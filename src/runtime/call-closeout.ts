import {
  AgentSessionEventTypes,
  sessionReportToJSON,
  type AgentSession,
  type JobContext,
} from "@livekit/agents";
import { type CallState } from "../state/call-state.js";
import { transferIsAccepted } from "../state/call-lifecycle.js";
import { domainOutcomeReceipts } from "../state/observability.js";
import type {
  RuntimeVoiceLanguageState,
  VoiceLanguageRuntime,
} from "./voice-language.js";
import type { SttProfileTransitionAnalytics } from "./stt-profile-observability.js";
import { attachCallDurationDeadline } from "./call-duration-deadline.js";

export type CallCloseoutObserver = {
  durationLimitReached(): void;
  toolsExecuted(event: { functionCalls?: Array<{ callId?: string }> }): void;
};

export type CallCloseoutCapture = {
  language: Record<string, unknown>;
  reportUnavailable?: boolean;
  sessionReport?: Record<string, unknown>;
  sttProfiles: Record<string, unknown>[];
  voiceLanguage?: RuntimeVoiceLanguageState;
};

export interface CallCloseoutEventAdapter {
  capture(): Promise<CallCloseoutCapture>;
  observe(observer: CallCloseoutObserver): void;
  onClose(closeout: () => Promise<CallPortalResult>): void;
}

export type CallPortalPhase = "call-start" | "outcome-checkpoint" | "shutdown";

export type CallPortalDelivery = {
  payload: Record<string, unknown>;
  phase: CallPortalPhase;
  timeoutMs: number;
};

export type CallPortalResult = {
  ok: boolean;
  skipped?: boolean;
  status?: number;
};

export type CallCloseoutAttachment = {
  startResult: CallPortalResult;
};

export interface CallPortal {
  deliver(delivery: CallPortalDelivery): Promise<CallPortalResult>;
  wait(ms: number): Promise<void>;
}

type ProductInteractionMessageKind =
  "START" | "CLOSEOUT" | "OUTCOME_CHECKPOINT";
type ProductInteractionCallStatus =
  "IN_PROGRESS" | "COMPLETED" | "ESCALATED" | "FAILED";
type ProductAppointmentAction = "BOOKED" | "CANCELLED" | "RESCHEDULED";

type ProductAppointmentEvidence = {
  action: ProductAppointmentAction;
  occurredAt: string;
  externalPatientId?: string;
  oldAppointmentId?: string;
  newAppointmentId?: string;
  bookingResult?: Record<string, unknown>;
  cancellationResult?: Record<string, unknown>;
};

type ProductInteractionRequest = {
  kind: ProductInteractionMessageKind;
  sourceCallId: string;
  callerPhone: string;
  officePhone: string;
  startedAt: string;
  status: ProductInteractionCallStatus;
  officeKey?: string;
  endedAt?: string;
  transcript?: Record<string, unknown>;
  appointmentOutcome?: ProductAppointmentEvidence;
  closeoutPayload?: Record<string, unknown>;
};

export class HttpCallPortal implements CallPortal {
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Pick<Console, "log" | "warn">;
  private readonly secret: string | undefined;
  private readonly url: string | undefined;

  constructor(options: {
    fetchImpl?: typeof fetch;
    logger?: Pick<Console, "log" | "warn">;
    secret?: string;
    url?: string;
  }) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger = options.logger ?? console;
    this.secret = options.secret;
    this.url = options.url;
  }

  async deliver(delivery: CallPortalDelivery): Promise<CallPortalResult> {
    if (!this.url) return { ok: false, skipped: true };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.secret) headers.Authorization = `Bearer ${this.secret}`;

    try {
      const response = await this.fetchImpl(this.url, {
        body: JSON.stringify(productInteractionPayload(delivery)),
        headers,
        method: "POST",
        signal:
          delivery.timeoutMs > 0 && typeof AbortSignal.timeout === "function"
            ? AbortSignal.timeout(delivery.timeoutMs)
            : undefined,
      });
      if (response.ok) {
        this.logger.log(
          `[${delivery.phase}] Product Interaction POST succeeded status=${response.status}`,
        );
        return { ok: true, status: response.status };
      }

      this.logger.warn(
        `[${delivery.phase}] Product Interaction POST returned status=${response.status}`,
      );
      return { ok: false, status: response.status };
    } catch {
      this.logger.warn(`[${delivery.phase}] Product Interaction POST failed`);
      return { ok: false };
    }
  }

  async wait(ms: number): Promise<void> {
    if (ms <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}

function productInteractionPayload(
  delivery: CallPortalDelivery,
): ProductInteractionRequest {
  const payload = delivery.payload;
  const officeKey = stringValue(payload.officeKey);
  const endedAt = stringValue(payload.endedAt);
  const transcript =
    delivery.phase === "shutdown" && isRecord(payload.sessionReport)
      ? payload.sessionReport
      : undefined;
  const closeoutPayload =
    delivery.phase === "shutdown" ? { ...payload } : undefined;
  if (closeoutPayload) delete closeoutPayload.sessionReport;
  const appointmentOutcome = productAppointmentOutcome(payload);
  return {
    kind: productMessageKind(delivery.phase),
    sourceCallId: requiredString(payload.callId, "callId"),
    callerPhone: requiredString(payload.callerPhone, "callerPhone"),
    officePhone: requiredString(payload.officePhone, "officePhone"),
    startedAt: requiredString(payload.startedAt, "startedAt"),
    status: productCallStatus(payload.status),
    ...(officeKey ? { officeKey } : {}),
    ...(endedAt ? { endedAt } : {}),
    ...(transcript ? { transcript } : {}),
    ...(appointmentOutcome ? { appointmentOutcome } : {}),
    ...(closeoutPayload ? { closeoutPayload } : {}),
  };
}

function productMessageKind(
  phase: CallPortalPhase,
): ProductInteractionMessageKind {
  switch (phase) {
    case "call-start":
      return "START";
    case "outcome-checkpoint":
      return "OUTCOME_CHECKPOINT";
    case "shutdown":
      return "CLOSEOUT";
  }
}

function productAppointmentOutcome(
  payload: Record<string, unknown>,
): ProductAppointmentEvidence | undefined {
  const explicit = isRecord(payload.appointmentOutcome)
    ? payload.appointmentOutcome
    : undefined;
  const action = explicit;
  if (!action) return undefined;

  const actionName = productAppointmentAction(action.action);
  const bookingResult = isRecord(action.bookingResult)
    ? action.bookingResult
    : undefined;
  const cancellationResult = isRecord(action.cancellationResult)
    ? action.cancellationResult
    : undefined;
  if (
    !actionName ||
    (actionName === "BOOKED" && !bookingResult) ||
    (actionName === "CANCELLED" && !cancellationResult) ||
    (actionName === "RESCHEDULED" && (!bookingResult || !cancellationResult))
  ) {
    return undefined;
  }

  const occurredAt =
    stringValue(action.occurredAt) ??
    stringValue(action.createdAt) ??
    stringValue(payload.endedAt) ??
    stringValue(payload.startedAt);
  if (!occurredAt) return undefined;

  const externalPatientId = stringValue(action.externalPatientId);
  const oldAppointmentId = stringValue(action.oldAppointmentId);
  const newAppointmentId = stringValue(action.newAppointmentId);
  return {
    action: actionName,
    occurredAt,
    ...(externalPatientId ? { externalPatientId } : {}),
    ...(oldAppointmentId ? { oldAppointmentId } : {}),
    ...(newAppointmentId ? { newAppointmentId } : {}),
    ...(bookingResult ? { bookingResult } : {}),
    ...(cancellationResult ? { cancellationResult } : {}),
  };
}

function productAppointmentAction(
  value: unknown,
): ProductAppointmentAction | undefined {
  switch (stringValue(value)?.toLowerCase()) {
    case "booked":
      return "BOOKED";
    case "cancelled":
      return "CANCELLED";
    case "rescheduled":
      return "RESCHEDULED";
    default:
      return undefined;
  }
}

function productCallStatus(value: unknown): ProductInteractionCallStatus {
  switch (value) {
    case "IN_PROGRESS":
    case "COMPLETED":
    case "ESCALATED":
    case "FAILED":
      return value;
    default:
      throw new Error("Product Interaction status is required");
  }
}

function requiredString(value: unknown, name: string): string {
  const normalized = stringValue(value);
  if (!normalized) {
    throw new Error(`Product Interaction ${name} is required`);
  }
  return normalized;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export class InMemoryCallPortal implements CallPortal {
  readonly deliveries: CallPortalDelivery[] = [];
  readonly waits: number[] = [];
  private readonly results: Partial<
    Record<CallPortalPhase, CallPortalResult[]>
  >;

  constructor(
    results: Partial<Record<CallPortalPhase, CallPortalResult[]>> = {},
  ) {
    this.results = Object.fromEntries(
      Object.entries(results).map(([phase, phaseResults]) => [
        phase,
        [...phaseResults],
      ]),
    );
  }

  async deliver(delivery: CallPortalDelivery): Promise<CallPortalResult> {
    this.deliveries.push(delivery);
    return this.results[delivery.phase]?.shift() ?? { ok: true, status: 200 };
  }

  async wait(ms: number): Promise<void> {
    this.waits.push(ms);
  }
}

export type CallStartContext = {
  callId: string;
  callerPhone: string;
  livekitContext: Record<string, unknown>;
  officeKey?: string;
  officePhone: string;
  startedAt: Date;
};

const LIVEKIT_ROOM_CREATION_SKEW_TOLERANCE_MS = 5_000;

export function resolveLiveKitCallStart(
  input: {
    participantIdentity: string;
    roomCreationTime: Date;
    roomName: string;
    sipCallId: string;
  },
  getWorkerStartedAt: () => Date = () => new Date(),
): Pick<CallStartContext, "callId" | "startedAt"> {
  const workerStartedAt = getWorkerStartedAt();
  const roomCreationTimeMs = input.roomCreationTime.getTime();
  return {
    callId:
      input.sipCallId ||
      input.roomName ||
      input.participantIdentity ||
      "unknown",
    startedAt:
      Number.isFinite(roomCreationTimeMs) &&
      roomCreationTimeMs > 0 &&
      roomCreationTimeMs <=
        workerStartedAt.getTime() + LIVEKIT_ROOM_CREATION_SKEW_TOLERANCE_MS
        ? input.roomCreationTime
        : workerStartedAt,
  };
}

type CallContext = CallStartContext & {
  fallbackModel: string;
  initialVoiceLanguage: RuntimeVoiceLanguageState;
  maxCallDurationMs?: number;
};

async function deliverWithRetries(
  portal: CallPortal,
  delivery: CallPortalDelivery,
  options: { maxAttempts: number; retryDelayMs: number },
): Promise<CallPortalResult> {
  let result: CallPortalResult = { ok: false };
  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    result = await portal.deliver(delivery);
    if (result.ok || result.skipped) return result;
    if (attempt < options.maxAttempts) {
      await portal.wait(options.retryDelayMs * attempt);
    }
  }
  return result;
}

export async function attachStartupCallCloseout(input: {
  call: CallStartContext;
  now?: () => Date;
  portal: CallPortal;
  registerShutdownCallback(closeout: () => Promise<void>): void;
}): Promise<{
  handOffToCallCloseout(): void;
  startResult: CallPortalResult;
}> {
  let handedOff = false;
  let failedCloseout: Promise<void> | undefined;
  let resolveCallStart: () => void = () => undefined;
  const callStartFinished = new Promise<void>((resolve) => {
    resolveCallStart = resolve;
  });
  const closeFailedStartup = () => {
    failedCloseout ??= callStartFinished.then(() =>
      deliverFailedStartup(
        input.call,
        input.portal,
        input.now?.() ?? new Date(),
      ),
    );
    return failedCloseout;
  };
  input.registerShutdownCallback(async () => {
    if (!handedOff) await closeFailedStartup();
  });
  const startResult = await deliverCallStart(input.call, input.portal).finally(
    resolveCallStart,
  );
  return {
    handOffToCallCloseout() {
      handedOff = true;
    },
    startResult,
  };
}

export async function attachCallCloseout(input: {
  call: CallContext;
  events: CallCloseoutEventAdapter;
  getCallState: () => CallState | null;
  logger?: Pick<Console, "warn">;
  now?: () => Date;
  onCloseoutAttached?: () => void;
  portal: CallPortal;
  startResult?: CallPortalResult;
}): Promise<CallCloseoutAttachment> {
  const logger = input.logger ?? console;
  const now = input.now ?? (() => new Date());
  let durationLimitReached = false;
  const checkpointedCallIds = new Set<string>();
  let checkpointDeliveries = Promise.resolve();
  input.events.observe({
    durationLimitReached() {
      durationLimitReached = true;
      const callState = input.getCallState();
      if (!callState) return;
      callState.runtime.endedReason = "duration_limit";
    },
    toolsExecuted(event) {
      const callState = input.getCallState();
      if (!callState) return;
      const callIds = new Set(
        (event.functionCalls ?? []).map((call) => call.callId).filter(Boolean),
      );
      const pendingReceipts = domainOutcomeReceipts(callState).filter(
        (receipt) =>
          callIds.has(receipt.callId) &&
          !checkpointedCallIds.has(receipt.callId) &&
          appointmentReceiptIsPromotable(receipt),
      );
      for (const receipt of pendingReceipts) {
        checkpointedCallIds.add(receipt.callId);
        const payload = {
          ...callIdentityPayload(input.call),
          appointmentOutcome: receipt.evidence,
          domainOutcomes: [receipt],
          status: "IN_PROGRESS",
        };
        if (!productAppointmentOutcome(payload)) continue;
        checkpointDeliveries = checkpointDeliveries.then(async () => {
          await deliverWithRetries(
            input.portal,
            {
              payload,
              phase: "outcome-checkpoint",
              timeoutMs: 3_000,
            },
            { maxAttempts: 2, retryDelayMs: 1_000 },
          );
        });
      }
    },
  });
  input.events.onClose(async () => {
    await checkpointDeliveries;
    const endedAt = now();
    const callState = input.getCallState();
    const capture = await input.events.capture();
    const domainOutcomes = callState ? domainOutcomeReceipts(callState) : [];
    const appointmentReceipt = [...domainOutcomes]
      .reverse()
      .find(appointmentReceiptIsPromotable);
    const appointmentOutcome = appointmentReceipt?.evidence
      ? {
          ...appointmentReceipt.evidence,
          occurredAt: appointmentReceipt.occurredAt,
        }
      : undefined;
    if (capture.reportUnavailable) {
      logger.warn("[closeout] LiveKit session report was unavailable");
    }
    const closeoutPayload: Record<string, unknown> = {
      ...callTimingPayload(input.call, endedAt),
      status:
        callState && transferIsAccepted(callState)
          ? "ESCALATED"
          : callState
            ? "COMPLETED"
            : "FAILED",
      ...(durationLimitReached
        ? {
            endedReason: "duration_limit",
            ...(input.call.maxCallDurationMs !== undefined
              ? { maxCallDurationMs: input.call.maxCallDurationMs }
              : {}),
          }
        : !callState
          ? { endedReason: "call_state_not_initialized" }
          : callState.runtime.endedReason
            ? { endedReason: callState.runtime.endedReason }
            : {}),
      language: capture.language,
      voiceLanguage:
        capture.voiceLanguage ??
        callState?.runtime.voiceLanguage ??
        input.call.initialVoiceLanguage,
      domainOutcomes,
      ...(appointmentOutcome ? { appointmentOutcome } : {}),
      ...(capture.reportUnavailable ? { sessionReportUnavailable: true } : {}),
      ...input.call.livekitContext,
      sttProfiles: capture.sttProfiles,
      sessionReport: capture.sessionReport,
    };

    return deliverWithRetries(
      input.portal,
      {
        payload: closeoutPayload,
        phase: "shutdown",
        timeoutMs: 10_000,
      },
      { maxAttempts: 4, retryDelayMs: 2_000 },
    );
  });
  input.onCloseoutAttached?.();

  const startResult =
    input.startResult ?? (await deliverCallStart(input.call, input.portal));
  return { startResult };
}

async function deliverCallStart(
  call: CallStartContext,
  portal: CallPortal,
): Promise<CallPortalResult> {
  return deliverWithRetries(
    portal,
    {
      payload: {
        ...callIdentityPayload(call),
        status: "IN_PROGRESS",
        ...call.livekitContext,
      },
      phase: "call-start",
      timeoutMs: 2_000,
    },
    { maxAttempts: 1, retryDelayMs: 0 },
  );
}

async function deliverFailedStartup(
  call: CallStartContext,
  portal: CallPortal,
  endedAt: Date,
): Promise<void> {
  const payload = {
    ...callTimingPayload(call, endedAt),
    status: "FAILED",
    endedReason: "call_state_not_initialized",
    language: {},
    ...call.livekitContext,
  };
  await deliverWithRetries(
    portal,
    {
      payload,
      phase: "shutdown",
      timeoutMs: 10_000,
    },
    { maxAttempts: 4, retryDelayMs: 2_000 },
  );
}

function callTimingPayload(call: CallStartContext, endedAt: Date) {
  const normalizedEndedAt = new Date(
    Math.max(endedAt.getTime(), call.startedAt.getTime()),
  );
  return {
    ...callIdentityPayload(call),
    endedAt: normalizedEndedAt.toISOString(),
    durationSec: Math.round(
      (normalizedEndedAt.getTime() - call.startedAt.getTime()) / 1000,
    ),
  };
}

function callIdentityPayload(call: CallStartContext) {
  return {
    callId: call.callId,
    callerPhone: call.callerPhone,
    ...(call.officeKey ? { officeKey: call.officeKey } : {}),
    officePhone: call.officePhone,
    startedAt: call.startedAt.toISOString(),
  };
}

function appointmentReceiptIsPromotable(
  receipt: ReturnType<typeof domainOutcomeReceipts>[number],
): boolean {
  return (
    (receipt.status === "success" || receipt.status === "partial") &&
    receipt.evidence?.replayed !== true &&
    ["booked", "cancelled", "rescheduled"].includes(receipt.outcome)
  );
}

export function createLiveKitCallCloseoutEventAdapter(
  ctx: JobContext,
  session: AgentSession<CallState>,
  options: {
    callId: string;
    maxCallDurationMs: number;
    roomName: string;
    shutdownSession: (reason: string) => void;
    sttProfiles: SttProfileTransitionAnalytics[];
    voiceLanguageRuntime: Pick<VoiceLanguageRuntime, "snapshot">;
  },
): CallCloseoutEventAdapter {
  let closeout: (() => Promise<CallPortalResult>) | undefined;
  let deadline: ReturnType<typeof attachCallDurationDeadline> | undefined;

  return {
    async capture() {
      const voiceLanguage = options.voiceLanguageRuntime.snapshot();
      let reportUnavailable = false;
      let sessionReport: Record<string, unknown> | undefined;

      try {
        const report = ctx.makeSessionReport();
        sessionReport = sanitizeSessionReport(sessionReportToJSON(report));
      } catch {
        reportUnavailable = true;
      }

      return {
        language: voiceLanguage.language,
        ...(reportUnavailable ? { reportUnavailable } : {}),
        sessionReport,
        sttProfiles: [...options.sttProfiles],
        voiceLanguage: voiceLanguage.voiceLanguage,
      };
    },
    observe(observer) {
      deadline = attachCallDurationDeadline(ctx, {
        callId: options.callId,
        onExceeded: observer.durationLimitReached,
        roomName: options.roomName,
        shutdownSession: options.shutdownSession,
        timeoutMs: options.maxCallDurationMs,
      });

      session.on(AgentSessionEventTypes.FunctionToolsExecuted, (event) => {
        observer.toolsExecuted(event);
      });
    },
    onClose(callback) {
      closeout = callback;
      ctx.addShutdownCallback(async () => {
        deadline?.clear();
        await closeout?.();
      });
    },
  };
}

const PRIVATE_SESSION_REPORT_KEYS = new Set([
  "access_token",
  "api_key",
  "audio_recording_path",
  "audio_recording_started_at",
  "authorization",
  "backend_id",
  "client_secret",
  "credential",
  "credentials",
  "id_token",
  "internal_url",
  "password",
  "private_key",
  "refresh_token",
  "secret",
  "thought_signature",
  "token",
]);

function sanitizeSessionReport(
  report: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(report)
      .filter(([key]) => !isPrivateSessionReportKey(key))
      .map(([key, value]) => [key, sanitizeSessionReportValue(value)]),
  );
}

function isPrivateSessionReportKey(key: string): boolean {
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  return PRIVATE_SESSION_REPORT_KEYS.has(normalized);
}

function sanitizeSessionReportValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeSessionReportValue);
  if (typeof value === "string") return sanitizeSessionReportString(value);
  if (!isRecord(value)) return value;
  return sanitizeSessionReport(value);
}

function sanitizeSessionReportString(value: string): string {
  return value
    .replace(
      /\bAuthorization\s*:\s*(?:(?:Bearer|Basic)\s+)?[^\s,;]+/gi,
      "Authorization: [REDACTED]",
    )
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(
      /([?&\s](?:access_token|api_key|authorization|client_secret|credential|id_token|password|private_key|refresh_token|secret|token)=)[^&#\s]+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /https?:\/\/(?:(?:localhost|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})(?::\d+)?|[^\s/]+\.(?:internal|local))[^\s]*/gi,
      "[REDACTED_INTERNAL_URL]",
    );
}
