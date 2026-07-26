import {
  AgentSessionEventTypes,
  sessionReportToJSON,
  type AgentSession,
  type JobContext,
} from "@livekit/agents";
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
import type { RuntimeVoiceLanguageState } from "../tts-config.js";
import type { SttLanguageDetector } from "../stt-language-detector.js";
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
  type ToolExecutionAnalytics,
} from "../call-observability.js";
import type { SttProfileTransitionAnalytics } from "../call-observability.js";
import { attachCallDurationDeadline } from "./call-duration-deadline.js";

export type CommittedConversationItem = {
  id: string;
  interrupted: boolean;
  metrics?: Record<string, unknown>;
  role: string;
  text: string;
  timestamp: number;
  transcriptConfidence?: number;
};

export type CallCaptureEnvelope = {
  callId: string;
  call?: Record<string, unknown>;
  finalState?: Record<string, unknown>;
  idempotencyKey: string;
  items?: CommittedConversationItem[];
  schemaVersion: 1;
  sequence: number;
  toolOutcomes?: SanitizedToolOutcome[];
  type: "start" | "checkpoint" | "final";
};

export type SanitizedToolOutcome = ToolExecutionAnalytics & {
  idempotencyKey: string;
};

export type CallCaptureDelivery = {
  envelope: CallCaptureEnvelope;
  legacyPayload?: Record<string, unknown>;
  timeoutMs: number;
};

export type CallCapturePortalResult = {
  durable?: boolean;
  ok: boolean;
  skipped?: boolean;
  status?: number;
};

export type CallCaptureFinalSnapshot = {
  language: Record<string, unknown>;
  reportUnavailable?: boolean;
  sessionReport?: Record<string, unknown>;
  sessionUsage?: Record<string, unknown>;
  sttProfiles: Record<string, unknown>[];
};

export type CallCaptureFinishResult = {
  finalResult: CallCapturePortalResult;
  pendingItemCount: number;
  pendingToolOutcomeCount: number;
  timedOut: boolean;
};

export interface CallCapturePortal {
  deliver(delivery: CallCaptureDelivery): Promise<CallCapturePortalResult>;
  wait(ms: number): Promise<void>;
}

async function responseAcknowledgesDelivery(
  response: Response,
  envelope: CallCaptureEnvelope,
): Promise<boolean> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return false;
  }
  const acknowledgment = asRecord(body);
  if (
    acknowledgment?.ok !== true ||
    acknowledgment.callId !== envelope.callId ||
    acknowledgment.idempotencyKey !== envelope.idempotencyKey ||
    acknowledgment.sequence !== envelope.sequence
  ) {
    return false;
  }

  const recordedItemIds = stringSet(acknowledgment.recordedItemIds);
  const recordedToolCallIds = stringSet(acknowledgment.recordedToolCallIds);
  return (
    (envelope.items ?? []).every((item) => recordedItemIds.has(item.id)) &&
    (envelope.toolOutcomes ?? []).every((outcome) =>
      recordedToolCallIds.has(outcome.callId),
    )
  );
}

export class HttpCallCapturePortal implements CallCapturePortal {
  private readonly captureUrl: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly legacyUrl: string | undefined;
  private readonly logger: Pick<Console, "log" | "warn">;
  private readonly secret: string | undefined;

  constructor(options: {
    captureUrl?: string;
    fetchImpl?: typeof fetch;
    legacyUrl?: string;
    logger?: Pick<Console, "log" | "warn">;
    secret?: string;
  }) {
    this.captureUrl = nonEmpty(options.captureUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.legacyUrl = nonEmpty(options.legacyUrl);
    this.logger = options.logger ?? console;
    this.secret = nonEmpty(options.secret);
  }

  async deliver(
    delivery: CallCaptureDelivery,
  ): Promise<CallCapturePortalResult> {
    const usesCaptureContract = Boolean(this.captureUrl);
    if (usesCaptureContract && !this.secret) {
      this.logger.warn("[call-capture] delivery skipped reason=missing_auth");
      return { ok: false, skipped: true };
    }
    const url =
      this.captureUrl ??
      (delivery.envelope.type === "checkpoint" ? undefined : this.legacyUrl);
    if (!url) return { ok: false, skipped: true };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.secret) headers.Authorization = `Bearer ${this.secret}`;

    try {
      const response = await this.fetchImpl(url, {
        body: JSON.stringify(
          usesCaptureContract ? delivery.envelope : delivery.legacyPayload,
        ),
        headers,
        method: "POST",
        signal:
          delivery.timeoutMs > 0 && typeof AbortSignal.timeout === "function"
            ? AbortSignal.timeout(delivery.timeoutMs)
            : undefined,
      });
      if (!response.ok) {
        this.logger.warn(
          `[call-capture] delivery failed type=${delivery.envelope.type} status=${response.status}`,
        );
        return { ok: false, status: response.status };
      }
      if (
        usesCaptureContract &&
        !(await responseAcknowledgesDelivery(response, delivery.envelope))
      ) {
        this.logger.warn(
          `[call-capture] delivery acknowledgment invalid type=${delivery.envelope.type} status=${response.status}`,
        );
        return { ok: false, status: response.status };
      }

      this.logger.log(
        `[call-capture] delivery succeeded type=${delivery.envelope.type} status=${response.status}`,
      );
      return {
        ...(usesCaptureContract ? { durable: true } : {}),
        ok: true,
        status: response.status,
      };
    } catch {
      this.logger.warn(
        `[call-capture] delivery request failed type=${delivery.envelope.type}`,
      );
      return { ok: false };
    }
  }

  async wait(ms: number): Promise<void> {
    if (ms <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export class InMemoryCallCapturePortal implements CallCapturePortal {
  readonly deliveries: CallCaptureDelivery[] = [];
  readonly waits: number[] = [];
  private readonly results: Partial<
    Record<CallCaptureEnvelope["type"], CallCapturePortalResult[]>
  >;

  constructor(
    results: Partial<
      Record<CallCaptureEnvelope["type"], CallCapturePortalResult[]>
    > = {},
  ) {
    this.results = Object.fromEntries(
      Object.entries(results).map(([type, typeResults]) => [
        type,
        [...typeResults],
      ]),
    );
  }

  async deliver(
    delivery: CallCaptureDelivery,
  ): Promise<CallCapturePortalResult> {
    this.deliveries.push(delivery);
    return (
      this.results[delivery.envelope.type]?.shift() ?? {
        ok: true,
        status: 200,
      }
    );
  }

  async wait(ms: number): Promise<void> {
    this.waits.push(ms);
  }
}

export type CallCaptureContext = {
  callId: string;
  callerPhone: string;
  fallbackModel: string;
  initialVoiceLanguage: RuntimeVoiceLanguageState;
  livekitContext: Record<string, unknown>;
  maxCallDurationMs?: number;
  officePhone: string;
  startedAt: Date;
};

export interface CallCaptureEventAdapter {
  observe(record: (record: CallCaptureRecord) => void): void;
  onClose(
    finish: (
      snapshot: CallCaptureFinalSnapshot,
    ) => Promise<CallCaptureFinishResult>,
  ): void;
}

type CallCaptureRecord =
  | {
      item: CommittedConversationItem;
      type: "conversation-item";
    }
  | {
      event: Parameters<typeof snapshotToolExecutions>[0];
      type: "tools-executed";
    }
  | {
      type: "duration-limit";
    }
  | {
      event: Parameters<typeof snapshotFalseInterruptionEvent>[0];
      type: "false-interruption";
    }
  | {
      metric: Record<string, unknown>;
      type: "llm-metric";
    }
  | {
      event: Parameters<typeof snapshotOverlappingSpeechEvent>[0];
      type: "overlapping-speech";
    }
  | {
      event: Parameters<typeof snapshotCloseEvent>[0];
      type: "session-closed";
    }
  | {
      event: Parameters<typeof snapshotErrorEvent>[0];
      type: "session-error";
    }
  | {
      type: "usage-updated";
      usage: Record<string, unknown>;
    };

type TurnMetricSnapshot = {
  interrupted: boolean;
  itemId: string;
  metrics: Record<string, unknown>;
  role: string;
  timestamp: number;
};

export class CallCapture {
  private readonly call: CallCaptureContext;
  private readonly finalizationTimeoutMs: number;
  private readonly getCallState: () => CallState | null;
  private readonly items = new Map<string, CommittedConversationItem>();
  private readonly llmMetrics: Record<string, unknown>[] = [];
  private readonly logger: Pick<Console, "warn">;
  private latestUsage: Record<string, unknown> | undefined;
  private readonly now: () => Date;
  private readonly portal: CallCapturePortal;
  private readonly recordedItemIds = new Set<string>();
  private readonly recordedToolCallIds = new Set<string>();
  private readonly retryDelayMs: number;
  private readonly sessionEvents: SessionEventAnalytics =
    createEmptySessionEventAnalytics();
  private readonly toolOutcomes = new Map<string, SanitizedToolOutcome>();
  private readonly turnMetrics: TurnMetricSnapshot[] = [];
  private queue = Promise.resolve();
  private sequence = 0;
  private durationLimitReached = false;
  private finishing = false;
  private stopRetries = false;

  constructor(input: {
    call: CallCaptureContext;
    finalizationTimeoutMs?: number;
    getCallState: () => CallState | null;
    logger?: Pick<Console, "warn">;
    now?: () => Date;
    portal: CallCapturePortal;
    retryDelayMs?: number;
  }) {
    this.call = input.call;
    this.finalizationTimeoutMs = input.finalizationTimeoutMs ?? 4_000;
    this.getCallState = input.getCallState;
    this.logger = input.logger ?? console;
    this.now = input.now ?? (() => new Date());
    this.portal = input.portal;
    this.retryDelayMs = input.retryDelayMs ?? 1_000;
  }

  start(): void {
    this.enqueue({
      envelope: {
        callId: this.call.callId,
        call: {
          callerPhone: this.call.callerPhone,
          officePhone: this.call.officePhone,
          startedAt: this.call.startedAt.toISOString(),
          ...this.call.livekitContext,
        },
        idempotencyKey: `${this.call.callId}:start`,
        schemaVersion: 1,
        sequence: this.nextSequence(),
        type: "start",
      },
      legacyPayload: {
        callId: this.call.callId,
        callerPhone: this.call.callerPhone,
        officePhone: this.call.officePhone,
        startedAt: this.call.startedAt.toISOString(),
        status: "IN_PROGRESS",
        ...this.call.livekitContext,
      },
      timeoutMs: 1_500,
    });
  }

  record(record: CallCaptureRecord): void {
    if (this.finishing) return;
    switch (record.type) {
      case "conversation-item":
        this.recordConversationItem(record.item);
        return;
      case "tools-executed":
        this.recordToolOutcomes(record.event);
        return;
      case "duration-limit": {
        this.durationLimitReached = true;
        const callState = this.getCallState();
        if (!callState) return;
        callState.runtime.endedReason = "duration_limit";
        if (this.call.maxCallDurationMs !== undefined) {
          callState.runtime.maxCallDurationMs = this.call.maxCallDurationMs;
        }
        return;
      }
      case "false-interruption":
        this.sessionEvents.falseInterruptions.push(
          snapshotFalseInterruptionEvent(record.event),
        );
        return;
      case "llm-metric":
        this.llmMetrics.push(record.metric);
        return;
      case "overlapping-speech":
        this.sessionEvents.overlappingSpeech.push(
          snapshotOverlappingSpeechEvent(record.event),
        );
        return;
      case "session-closed":
        this.sessionEvents.close = snapshotCloseEvent(record.event);
        return;
      case "session-error":
        this.sessionEvents.errors.push(snapshotErrorEvent(record.event));
        return;
      case "usage-updated":
        this.latestUsage = record.usage;
        return;
    }
  }

  private recordConversationItem(item: CommittedConversationItem): void {
    if (this.items.has(item.id)) return;
    this.items.set(item.id, item);
    if (item.metrics && Object.keys(item.metrics).length > 0) {
      this.turnMetrics.push({
        interrupted: item.interrupted,
        itemId: item.id,
        metrics: item.metrics,
        role: item.role,
        timestamp: item.timestamp,
      });
    }
    this.enqueue(
      {
        envelope: {
          callId: this.call.callId,
          idempotencyKey: `${this.call.callId}:${item.id}`,
          items: [item],
          schemaVersion: 1,
          sequence: this.nextSequence(),
          type: "checkpoint",
        },
        timeoutMs: 1_500,
      },
      () => this.recordedItemIds.add(item.id),
    );
  }

  private recordToolOutcomes(
    event: Parameters<typeof snapshotToolExecutions>[0],
  ): void {
    const callState = this.getCallState();
    for (const outcome of snapshotToolExecutions(event, () =>
      callState ? takePatientIdentityOutcome(callState) : undefined,
    )) {
      this.recordSanitizedToolOutcome(outcome);
    }
  }

  private recordSanitizedToolOutcome(outcome: ToolExecutionAnalytics): void {
    if (this.toolOutcomes.has(outcome.callId)) return;
    const idempotencyKey = `${this.call.callId}:tool:${outcome.callId}`;
    const sanitizedOutcome = { ...outcome, idempotencyKey };
    this.toolOutcomes.set(outcome.callId, sanitizedOutcome);
    this.enqueue(
      {
        envelope: {
          callId: this.call.callId,
          idempotencyKey,
          schemaVersion: 1,
          sequence: this.nextSequence(),
          toolOutcomes: [sanitizedOutcome],
          type: "checkpoint",
        },
        timeoutMs: 1_500,
      },
      () => this.recordedToolCallIds.add(outcome.callId),
    );
  }

  async finish(
    snapshot: CallCaptureFinalSnapshot,
  ): Promise<CallCaptureFinishResult> {
    this.finishing = true;
    const sessionReport = sanitizedSessionReport(snapshot.sessionReport);
    for (const item of committedItemsFromReport(sessionReport)) {
      this.recordConversationItem(item);
    }
    const callState = this.getCallState();
    const recordedAppointmentActions = callState
      ? appointmentActions(callState)
      : [];
    const toolExecutions = [...this.toolOutcomes.values()].map(
      toolExecutionFromOutcome,
    );
    for (const outcome of withAppointmentActionToolExecutionFallback(
      toolExecutions,
      recordedAppointmentActions,
    )) {
      this.recordSanitizedToolOutcome(outcome);
    }
    const finalReserveMs = Math.min(
      1_000,
      Math.max(10, Math.floor(this.finalizationTimeoutMs / 3)),
    );
    const flush = await settleWithin(
      this.queue,
      Math.max(0, this.finalizationTimeoutMs - finalReserveMs),
    );
    if (!flush.settled) this.stopRetries = true;
    const finalDeadline = Date.now() + finalReserveMs;

    const endedAt = this.now();
    const usage = this.latestUsage ?? snapshot.sessionUsage;
    const legacyPayload: Record<string, unknown> = {
      callId: this.call.callId,
      callerPhone: this.call.callerPhone,
      durationSec: Math.round(
        (endedAt.getTime() - this.call.startedAt.getTime()) / 1_000,
      ),
      endedAt: endedAt.toISOString(),
      officePhone: this.call.officePhone,
      status:
        callState && transferIsAccepted(callState)
          ? "ESCALATED"
          : callState
            ? "COMPLETED"
            : "FAILED",
      startedAt: this.call.startedAt.toISOString(),
      ...(this.durationLimitReached
        ? {
            endedReason: "duration_limit",
            ...(this.call.maxCallDurationMs !== undefined
              ? { maxCallDurationMs: this.call.maxCallDurationMs }
              : {}),
          }
        : !callState
          ? { endedReason: "call_state_not_initialized" }
          : callState.runtime.endedReason
            ? { endedReason: callState.runtime.endedReason }
            : {}),
      usage,
      llmSummary: buildLlmSummary({
        fallbackModel: this.call.fallbackModel,
        llmMetrics: this.llmMetrics,
        usage,
      }),
      sessionEvents: this.sessionEvents,
      language: snapshot.language,
      voiceLanguage:
        callState?.runtime.voiceLanguage ?? this.call.initialVoiceLanguage,
      toolExecutions: [...this.toolOutcomes.values()].map(
        toolExecutionFromOutcome,
      ),
      knowledgeRetrievals: callState
        ? officeKnowledgeRetrievals(callState)
        : [],
      identityTransitions: callState
        ? patientIdentityTransitions(callState)
        : [],
      appointmentActions: recordedAppointmentActions,
      availabilityReads: callState ? availabilityReadEvents(callState) : [],
      ownedMiddlewareFailures: callState
        ? ownedMiddlewareFailures(callState)
        : [],
      ...this.call.livekitContext,
      llmMetrics: this.llmMetrics,
      sttProfiles: snapshot.sttProfiles,
      turnMetrics: this.turnMetrics,
      ...(callState
        ? { callState: sanitizeCallStateForCapture(callState) }
        : {}),
      ...(callState?.runtime.preCallLookup
        ? { preCallLookup: callState.runtime.preCallLookup }
        : {}),
      sessionReport,
    };
    if (snapshot.reportUnavailable) {
      this.logger.warn("[call-capture] LiveKit session report unavailable");
    }
    const finalDelivery: CallCaptureDelivery = {
      envelope: {
        callId: this.call.callId,
        finalState: legacyPayload,
        idempotencyKey: `${this.call.callId}:final`,
        items: [...this.items.values()],
        schemaVersion: 1,
        sequence: this.nextSequence(),
        toolOutcomes: [...this.toolOutcomes.values()],
        type: "final",
      },
      legacyPayload,
      timeoutMs: Math.max(1, Math.min(750, finalDeadline - Date.now())),
    };
    const final = await deliverWithRetryUntil(
      this.portal,
      finalDelivery,
      finalDeadline,
      Math.min(this.retryDelayMs, 100),
    );
    if (final.value?.durable) {
      for (const itemId of this.items.keys()) {
        this.recordedItemIds.add(itemId);
      }
      for (const callId of this.toolOutcomes.keys()) {
        this.recordedToolCallIds.add(callId);
      }
    }
    const result = {
      finalResult: final.value ?? { ok: false },
      pendingItemCount: [...this.items.keys()].filter(
        (itemId) => !this.recordedItemIds.has(itemId),
      ).length,
      pendingToolOutcomeCount: [...this.toolOutcomes.keys()].filter(
        (callId) => !this.recordedToolCallIds.has(callId),
      ).length,
      timedOut: !flush.settled || !final.settled,
    };
    if (
      result.timedOut ||
      result.pendingItemCount > 0 ||
      result.pendingToolOutcomeCount > 0 ||
      !result.finalResult.ok
    ) {
      this.logger.warn(
        `[call-capture] finalization incomplete timedOut=${result.timedOut} pendingItems=${result.pendingItemCount} pendingToolOutcomes=${result.pendingToolOutcomeCount} finalOk=${result.finalResult.ok}`,
      );
    }
    return result;
  }

  private enqueue(
    delivery: CallCaptureDelivery,
    onAccepted?: () => void,
  ): void {
    this.queue = this.queue.then(async () => {
      let attempt = 0;
      while (true) {
        const result = await this.portal.deliver(delivery);
        if (result.ok) {
          onAccepted?.();
          return;
        }
        if (result.skipped || this.stopRetries) return;
        if (!isRetryableDeliveryFailure(result)) {
          this.logger.warn(
            `[call-capture] delivery pending type=${delivery.envelope.type} status=${result.status ?? "unknown"} retryable=false`,
          );
          return;
        }
        attempt += 1;
        await this.portal.wait(
          Math.min(this.retryDelayMs * attempt, this.retryDelayMs * 5),
        );
        if (this.stopRetries) return;
      }
    });
  }

  private nextSequence(): number {
    this.sequence += 1;
    return this.sequence;
  }
}

export function attachCallCapture(input: {
  call: CallCaptureContext;
  events: CallCaptureEventAdapter;
  finalizationTimeoutMs?: number;
  getCallState: () => CallState | null;
  logger?: Pick<Console, "warn">;
  now?: () => Date;
  portal: CallCapturePortal;
  retryDelayMs?: number;
}): CallCapture {
  const capture = new CallCapture({
    call: input.call,
    ...(input.finalizationTimeoutMs === undefined
      ? {}
      : { finalizationTimeoutMs: input.finalizationTimeoutMs }),
    getCallState: input.getCallState,
    ...(input.logger ? { logger: input.logger } : {}),
    ...(input.now ? { now: input.now } : {}),
    portal: input.portal,
    ...(input.retryDelayMs === undefined
      ? {}
      : { retryDelayMs: input.retryDelayMs }),
  });
  input.events.observe((record) => capture.record(record));
  input.events.onClose((snapshot) => capture.finish(snapshot));
  capture.start();
  return capture;
}

type LlmMetricsSource = {
  on(event: "metrics_collected", listener: (metrics: unknown) => void): unknown;
};

export function createLiveKitCallCaptureEventAdapter(
  ctx: JobContext,
  session: AgentSession<CallState>,
  options: {
    callId: string;
    llm: LlmMetricsSource;
    maxCallDurationMs: number;
    roomName: string;
    shutdownSession: (reason: string) => void;
    sttLanguageDetector: SttLanguageDetector;
    sttProfiles: SttProfileTransitionAnalytics[];
  },
): CallCaptureEventAdapter {
  let finish:
    | ((snapshot: CallCaptureFinalSnapshot) => Promise<CallCaptureFinishResult>)
    | undefined;
  let deadline: ReturnType<typeof attachCallDurationDeadline> | undefined;

  return {
    observe(record) {
      deadline = attachCallDurationDeadline(ctx, {
        callId: options.callId,
        onExceeded: () => record({ type: "duration-limit" }),
        roomName: options.roomName,
        shutdownSession: options.shutdownSession,
        timeoutMs: options.maxCallDurationMs,
      });

      options.llm.on("metrics_collected", (metrics) => {
        if (metrics && typeof metrics === "object") {
          record({
            metric: metrics as Record<string, unknown>,
            type: "llm-metric",
          });
        }
      });

      session.on(AgentSessionEventTypes.ConversationItemAdded, (event) => {
        if (event.item.type !== "message") return;
        const text = event.item.textContent;
        if (!text) return;
        const metrics = Object.fromEntries(
          Object.entries(event.item.metrics ?? {}).filter(
            ([, value]) => value !== undefined,
          ),
        );
        record({
          item: {
            id: event.item.id,
            interrupted: event.item.interrupted,
            ...(Object.keys(metrics).length > 0 ? { metrics } : {}),
            role: event.item.role,
            text,
            timestamp: event.item.createdAt,
            ...(event.item.transcriptConfidence === undefined
              ? {}
              : {
                  transcriptConfidence: event.item.transcriptConfidence,
                }),
          },
          type: "conversation-item",
        });
      });
      session.on(AgentSessionEventTypes.SessionUsageUpdated, (event) => {
        record({
          type: "usage-updated",
          usage: event.usage as unknown as Record<string, unknown>,
        });
      });
      session.on(AgentSessionEventTypes.FunctionToolsExecuted, (event) => {
        record({ event, type: "tools-executed" });
      });
      session.on(AgentSessionEventTypes.Error, (event) => {
        record({ event, type: "session-error" });
      });
      session.on(AgentSessionEventTypes.Close, (event) => {
        record({ event, type: "session-closed" });
      });
      session.on(AgentSessionEventTypes.AgentFalseInterruption, (event) => {
        record({ event, type: "false-interruption" });
      });
      session.on(AgentSessionEventTypes.OverlappingSpeech, (event) => {
        record({ event, type: "overlapping-speech" });
      });
    },
    onClose(callback) {
      finish = callback;
      ctx.addShutdownCallback(async () => {
        deadline?.clear();
        await finish?.(captureLiveKitFinalSnapshot(ctx, session, options));
      });
    },
  };
}

function captureLiveKitFinalSnapshot(
  ctx: JobContext,
  session: AgentSession<CallState>,
  options: {
    sttLanguageDetector: SttLanguageDetector;
    sttProfiles: SttProfileTransitionAnalytics[];
  },
): CallCaptureFinalSnapshot {
  let reportUnavailable = false;
  let sessionReport: Record<string, unknown> | undefined;
  try {
    sessionReport = sanitizedSessionReport(
      sessionReportToJSON(ctx.makeSessionReport()),
    );
  } catch {
    reportUnavailable = true;
  }

  return {
    language: options.sttLanguageDetector.telemetry,
    ...(reportUnavailable ? { reportUnavailable } : {}),
    ...(sessionReport ? { sessionReport } : {}),
    sessionUsage: session.usage as unknown as Record<string, unknown>,
    sttProfiles: [...options.sttProfiles],
  };
}

const PRIVATE_CALL_STATE_CAPTURE_FIELDS = new Set([
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

function sanitizeCallStateForCapture(state: CallState): unknown {
  return sanitizeCaptureValue(state);
}

function sanitizeCaptureValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeCaptureValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !PRIVATE_CALL_STATE_CAPTURE_FIELDS.has(key))
      .map(([key, nestedValue]) => [key, sanitizeCaptureValue(nestedValue)]),
  );
}

function sanitizedSessionReport(
  report: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!report) return undefined;
  const items = committedItemsFromReport(report).map((item) => ({
    content: [item.text],
    created_at: item.timestamp,
    id: item.id,
    interrupted: item.interrupted,
    ...(item.metrics ? { metrics: item.metrics } : {}),
    role: item.role,
    ...(item.transcriptConfidence === undefined
      ? {}
      : { transcript_confidence: item.transcriptConfidence }),
    type: "message",
  }));
  return {
    chat_history: { items },
    ...Object.fromEntries(
      ["sdk_version", "timestamp", "usage"]
        .filter((key) => report[key] !== undefined)
        .map((key) => [key, report[key]]),
    ),
  };
}

function toolExecutionFromOutcome(
  outcome: SanitizedToolOutcome,
): ToolExecutionAnalytics {
  return {
    callId: outcome.callId,
    createdAt: outcome.createdAt,
    outputClass: outcome.outputClass,
    status: outcome.status,
    toolName: outcome.toolName,
  };
}

async function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<{ settled: boolean; value?: T }> {
  if (timeoutMs <= 0) return { settled: false };

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    promise.then((value) => ({ settled: true as const, value })),
    new Promise<{ settled: false }>((resolve) => {
      timeout = setTimeout(() => resolve({ settled: false }), timeoutMs);
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  return result;
}

async function deliverWithRetryUntil(
  portal: CallCapturePortal,
  delivery: CallCaptureDelivery,
  deadline: number,
  retryDelayMs: number,
): Promise<{ settled: boolean; value?: CallCapturePortalResult }> {
  let value: CallCapturePortalResult | undefined;
  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    const attempt = await settleWithin(
      portal.deliver({
        ...delivery,
        timeoutMs: Math.max(1, Math.min(delivery.timeoutMs, remainingMs)),
      }),
      remainingMs,
    );
    if (!attempt.settled) return { settled: false, value };
    value = attempt.value;
    if (value?.ok || value?.skipped) return { settled: true, value };

    const waitMs = Math.min(retryDelayMs, deadline - Date.now());
    if (waitMs > 0) {
      const wait = await settleWithin(
        portal.wait(waitMs),
        Math.min(waitMs + 10, deadline - Date.now()),
      );
      if (!wait.settled) return { settled: false, value };
    }
  }
  return { settled: false, value };
}

function committedItemsFromReport(
  report: Record<string, unknown> | undefined,
): CommittedConversationItem[] {
  const chatHistory = asRecord(report?.chat_history);
  if (!Array.isArray(chatHistory?.items)) return [];

  const items: CommittedConversationItem[] = [];
  for (const value of chatHistory.items) {
    const item = asRecord(value);
    if (
      item?.type !== "message" ||
      typeof item.id !== "string" ||
      typeof item.role !== "string" ||
      !Array.isArray(item.content)
    ) {
      continue;
    }
    const text = item.content
      .filter((part): part is string => typeof part === "string")
      .join("\n");
    if (!text) continue;
    const timestamp =
      typeof item.created_at === "number" ? item.created_at : Date.now();
    items.push({
      id: item.id,
      interrupted: item.interrupted === true,
      role: item.role,
      text,
      timestamp,
      ...(typeof item.transcript_confidence === "number"
        ? { transcriptConfidence: item.transcript_confidence }
        : {}),
    });
  }
  return items;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringSet(value: unknown): Set<string> {
  if (!Array.isArray(value)) return new Set();
  return new Set(
    value.filter((item): item is string => typeof item === "string"),
  );
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function isRetryableDeliveryFailure(result: CallCapturePortalResult): boolean {
  if (result.status === undefined) return true;
  return result.status === 408 || result.status === 429 || result.status >= 500;
}
