import {
  AgentSessionEventTypes,
  sessionReportToJSON,
  type AgentSession,
  type JobContext,
} from "@livekit/agents";
import { readFile } from "node:fs/promises";
import {
  patientIdentityTransitions,
  takePatientIdentityOutcome,
  type CallState,
} from "../state/call-state.js";
import { transferIsAccepted } from "../state/call-lifecycle.js";
import {
  appointmentActions,
  availabilityReadEvents,
  officeKnowledgeRetrievals,
  ownedMiddlewareFailures,
} from "../state/observability.js";
import type {
  RuntimeVoiceLanguageState,
  VoiceLanguageRuntime,
} from "./voice-language.js";
import {
  buildLlmSummary,
  createEmptySessionEventAnalytics,
  snapshotCloseEvent,
  snapshotErrorEvent,
  snapshotFalseInterruptionEvent,
  snapshotOverlappingSpeechEvent,
  snapshotToolExecutions,
  withAppointmentActionToolExecutionFallback,
  type SessionEventAnalytics,
  type SttProfileTransitionAnalytics,
  type ToolExecutionAnalytics,
} from "../call-observability.js";
import { attachCallDurationDeadline } from "./call-duration-deadline.js";

type ConversationItemAdded = {
  createdAt: number;
  item: {
    id: string;
    interrupted: boolean;
    metrics?: Record<string, unknown>;
    role: string;
    type: "message";
  };
};

type TurnMetricSnapshot = {
  createdAt: number;
  interrupted: boolean;
  itemId: string;
  metrics: Record<string, unknown>;
  role: string;
  type: string;
};

export type CallCloseoutObserver = {
  conversationItemAdded(event: ConversationItemAdded): void;
  durationLimitReached(): void;
  falseInterruption(
    event: Parameters<typeof snapshotFalseInterruptionEvent>[0],
  ): void;
  llmMetric(metric: Record<string, unknown>): void;
  overlappingSpeech(
    event: Parameters<typeof snapshotOverlappingSpeechEvent>[0],
  ): void;
  sessionClosed(event: Parameters<typeof snapshotCloseEvent>[0]): void;
  sessionError(event: Parameters<typeof snapshotErrorEvent>[0]): void;
  toolsExecuted(event: Parameters<typeof snapshotToolExecutions>[0]): void;
  usageUpdated(usage: Record<string, unknown>): void;
};

export type CallCloseoutCapture = {
  audio?: Uint8Array;
  audioUnreadable?: boolean;
  language: Record<string, unknown>;
  reportUnavailable?: boolean;
  sessionReport?: Record<string, unknown>;
  sessionUsage?: Record<string, unknown>;
  sttProfiles: Record<string, unknown>[];
  voiceLanguage?: RuntimeVoiceLanguageState;
};

export interface CallCloseoutEventAdapter {
  capture(): Promise<CallCloseoutCapture>;
  observe(observer: CallCloseoutObserver): void;
  onClose(closeout: () => Promise<CallCloseoutResult>): void;
}

export type CallPortalPhase = "call-start" | "shutdown-summary" | "shutdown";

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

export type CallCloseoutResult = {
  richResult: CallPortalResult;
  summaryResult: CallPortalResult;
};

export type CallCloseoutAttachment = {
  startResult: CallPortalResult;
};

export interface CallPortal {
  deliver(delivery: CallPortalDelivery): Promise<CallPortalResult>;
  wait(ms: number): Promise<void>;
}

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
        body: JSON.stringify(delivery.payload),
        headers,
        method: "POST",
        signal:
          delivery.timeoutMs > 0 && typeof AbortSignal.timeout === "function"
            ? AbortSignal.timeout(delivery.timeoutMs)
            : undefined,
      });
      if (response.ok) {
        this.logger.log(
          `[${delivery.phase}] Analytics POST succeeded status=${response.status}`,
        );
        return { ok: true, status: response.status };
      }

      this.logger.warn(
        `[${delivery.phase}] Analytics POST returned status=${response.status}`,
      );
      return { ok: false, status: response.status };
    } catch {
      this.logger.warn(`[${delivery.phase}] Analytics POST failed`);
      return { ok: false };
    }
  }

  async wait(ms: number): Promise<void> {
    if (ms <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
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
  officePhone: string;
  startedAt: Date;
};

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
  let latestUsage: Record<string, unknown> | undefined;
  const llmMetrics: Record<string, unknown>[] = [];
  const observedToolExecutions: ToolExecutionAnalytics[] = [];
  const sessionEvents: SessionEventAnalytics =
    createEmptySessionEventAnalytics();
  const turnMetrics: TurnMetricSnapshot[] = [];
  input.events.observe({
    conversationItemAdded(event) {
      const metrics = Object.fromEntries(
        Object.entries(event.item.metrics ?? {}).filter(
          ([, value]) => value !== undefined,
        ),
      );
      if (Object.keys(metrics).length === 0) return;
      turnMetrics.push({
        createdAt: event.createdAt,
        interrupted: event.item.interrupted,
        itemId: event.item.id,
        metrics,
        role: event.item.role,
        type: event.item.type,
      });
    },
    durationLimitReached() {
      durationLimitReached = true;
      const callState = input.getCallState();
      if (!callState) return;
      callState.runtime.endedReason = "duration_limit";
      if (input.call.maxCallDurationMs !== undefined) {
        callState.runtime.maxCallDurationMs = input.call.maxCallDurationMs;
      }
    },
    falseInterruption(event) {
      sessionEvents.falseInterruptions.push(
        snapshotFalseInterruptionEvent(event),
      );
    },
    llmMetric(metric) {
      llmMetrics.push(metric);
    },
    overlappingSpeech(event) {
      sessionEvents.overlappingSpeech.push(
        snapshotOverlappingSpeechEvent(event),
      );
    },
    sessionClosed(event) {
      sessionEvents.close = snapshotCloseEvent(event);
    },
    sessionError(event) {
      sessionEvents.errors.push(snapshotErrorEvent(event));
    },
    toolsExecuted(event) {
      const callState = input.getCallState();
      observedToolExecutions.push(
        ...snapshotToolExecutions(event, () =>
          callState ? takePatientIdentityOutcome(callState) : undefined,
        ),
      );
    },
    usageUpdated(usage) {
      latestUsage = usage;
    },
  });
  input.events.onClose(async () => {
    const endedAt = now();
    const callState = input.getCallState();
    const capture = await input.events.capture();
    const recordedAppointmentActions = callState
      ? appointmentActions(callState)
      : [];
    const recordedAvailabilityReads = callState
      ? availabilityReadEvents(callState)
      : [];
    const recordedOwnedMiddlewareFailures = callState
      ? ownedMiddlewareFailures(callState)
      : [];
    const recordedIdentityTransitions = callState
      ? patientIdentityTransitions(callState)
      : [];
    const recordedKnowledgeRetrievals = callState
      ? officeKnowledgeRetrievals(callState)
      : [];
    const toolExecutions = withAppointmentActionToolExecutionFallback(
      observedToolExecutions,
      recordedAppointmentActions,
    );
    const capturedAudioBase64 = capture.audio
      ? Buffer.from(capture.audio).toString("base64")
      : undefined;
    const audioBase64 =
      capturedAudioBase64 && capturedAudioBase64.length < 4 * 1024 * 1024
        ? capturedAudioBase64
        : undefined;
    if (capturedAudioBase64 && !audioBase64) {
      logger.warn(
        "[closeout] Call audio exceeded 4 MiB payload limit; omitted",
      );
    }
    if (capture.audioUnreadable) {
      logger.warn("[closeout] Recorded call audio could not be read; omitted");
    }
    if (capture.reportUnavailable) {
      logger.warn("[closeout] LiveKit session report was unavailable");
    }
    const usage = latestUsage ?? capture.sessionUsage;
    const summaryPayload: Record<string, unknown> = {
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
      usage,
      llmSummary: buildLlmSummary({
        fallbackModel: input.call.fallbackModel,
        llmMetrics,
        usage,
      }),
      sessionEvents,
      language: capture.language,
      voiceLanguage:
        capture.voiceLanguage ??
        callState?.runtime.voiceLanguage ??
        input.call.initialVoiceLanguage,
      toolExecutions,
      knowledgeRetrievals: recordedKnowledgeRetrievals,
      identityTransitions: recordedIdentityTransitions,
      appointmentActions: recordedAppointmentActions,
      availabilityReads: recordedAvailabilityReads,
      ownedMiddlewareFailures: recordedOwnedMiddlewareFailures,
      ...input.call.livekitContext,
    };
    const richPayload: Record<string, unknown> = {
      ...summaryPayload,
      llmMetrics,
      sttProfiles: capture.sttProfiles,
      turnMetrics,
      ...(callState
        ? { callState: sanitizeCallStateForAnalytics(callState) }
        : {}),
      ...(callState?.runtime.preCallLookup
        ? { preCallLookup: callState.runtime.preCallLookup }
        : {}),
      sessionReport: capture.sessionReport,
      ...(audioBase64 ? { audioBase64 } : {}),
    };

    const summaryResult = await deliverWithRetries(
      input.portal,
      {
        payload: summaryPayload,
        phase: "shutdown-summary",
        timeoutMs: 3_000,
      },
      { maxAttempts: 2, retryDelayMs: 1_000 },
    );
    const richResult = await deliverWithRetries(
      input.portal,
      {
        payload: richPayload,
        phase: "shutdown",
        timeoutMs: 10_000,
      },
      { maxAttempts: 4, retryDelayMs: 2_000 },
    );
    return { richResult, summaryResult };
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
        callId: call.callId,
        callerPhone: call.callerPhone,
        officePhone: call.officePhone,
        startedAt: call.startedAt.toISOString(),
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
    sessionEvents: createEmptySessionEventAnalytics(),
    language: {},
    toolExecutions: [],
    knowledgeRetrievals: [],
    identityTransitions: [],
    appointmentActions: [],
    ownedMiddlewareFailures: [],
    ...call.livekitContext,
  };
  await deliverWithRetries(
    portal,
    {
      payload,
      phase: "shutdown-summary",
      timeoutMs: 3_000,
    },
    { maxAttempts: 2, retryDelayMs: 1_000 },
  );
  await deliverWithRetries(
    portal,
    {
      payload: {
        ...payload,
        llmMetrics: [],
        sttProfiles: [],
        turnMetrics: [],
      },
      phase: "shutdown",
      timeoutMs: 10_000,
    },
    { maxAttempts: 4, retryDelayMs: 2_000 },
  );
}

function callTimingPayload(call: CallStartContext, endedAt: Date) {
  return {
    callId: call.callId,
    callerPhone: call.callerPhone,
    officePhone: call.officePhone,
    startedAt: call.startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationSec: Math.round(
      (endedAt.getTime() - call.startedAt.getTime()) / 1000,
    ),
  };
}

const PRIVATE_CALL_STATE_ANALYTICS_FIELDS = new Set([
  "appointmentId",
  "appointmentTypeId",
  "bookingToken",
  "bookingTokensBySlotId",
  "candidates",
  "cancellationToken",
  "completedBookingsByPatientId",
  "completedReschedulesByPatientId",
  "id",
  "insPlanId",
  "latestBookedAppointmentId",
  "patientId",
  "respPartyId",
]);

function sanitizeCallStateForAnalytics(state: CallState): unknown {
  return sanitizeAnalyticsValue(state);
}

function sanitizeAnalyticsValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeAnalyticsValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !PRIVATE_CALL_STATE_ANALYTICS_FIELDS.has(key))
      .map(([key, nestedValue]) => [key, sanitizeAnalyticsValue(nestedValue)]),
  );
}

type LlmMetricsSource = {
  on(event: "metrics_collected", listener: (metrics: unknown) => void): unknown;
};

export function createLiveKitCallCloseoutEventAdapter(
  ctx: JobContext,
  session: AgentSession<CallState>,
  options: {
    callId: string;
    llm: LlmMetricsSource;
    maxCallDurationMs: number;
    roomName: string;
    shutdownSession: (reason: string) => void;
    sttProfiles: SttProfileTransitionAnalytics[];
    voiceLanguageRuntime: Pick<VoiceLanguageRuntime, "snapshot">;
  },
): CallCloseoutEventAdapter {
  let closeout: (() => Promise<CallCloseoutResult>) | undefined;
  let deadline: ReturnType<typeof attachCallDurationDeadline> | undefined;

  return {
    async capture() {
      const voiceLanguage = options.voiceLanguageRuntime.snapshot();
      let audio: Uint8Array | undefined;
      let audioUnreadable = false;
      let reportUnavailable = false;
      let sessionReport: Record<string, unknown> | undefined;

      try {
        const report = ctx.makeSessionReport();
        sessionReport = sessionReportToJSON(report);
        if (report.audioRecordingPath) {
          try {
            audio = await readFile(report.audioRecordingPath);
          } catch {
            audioUnreadable = true;
          }
        }
      } catch {
        reportUnavailable = true;
      }

      return {
        ...(audio ? { audio } : {}),
        ...(audioUnreadable ? { audioUnreadable } : {}),
        language: voiceLanguage.language,
        ...(reportUnavailable ? { reportUnavailable } : {}),
        sessionReport,
        sessionUsage: session.usage as unknown as Record<string, unknown>,
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

      options.llm.on("metrics_collected", (metrics) => {
        if (metrics && typeof metrics === "object") {
          observer.llmMetric(metrics as Record<string, unknown>);
        }
      });

      session.on(AgentSessionEventTypes.ConversationItemAdded, (event) => {
        if (event.item.type !== "message") return;
        observer.conversationItemAdded({
          createdAt: event.createdAt,
          item: {
            id: event.item.id,
            interrupted: event.item.interrupted,
            metrics: Object.fromEntries(
              Object.entries(event.item.metrics ?? {}),
            ),
            role: event.item.role,
            type: event.item.type,
          },
        });
      });
      session.on(AgentSessionEventTypes.SessionUsageUpdated, (event) => {
        observer.usageUpdated(
          event.usage as unknown as Record<string, unknown>,
        );
      });
      session.on(AgentSessionEventTypes.FunctionToolsExecuted, (event) => {
        observer.toolsExecuted(event);
      });
      session.on(AgentSessionEventTypes.Error, observer.sessionError);
      session.on(AgentSessionEventTypes.Close, observer.sessionClosed);
      session.on(
        AgentSessionEventTypes.AgentFalseInterruption,
        observer.falseInterruption,
      );
      session.on(
        AgentSessionEventTypes.OverlappingSpeech,
        observer.overlappingSpeech,
      );
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
