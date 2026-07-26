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

export type CallCaptureDelivery = {
  payload: Record<string, unknown>;
  timeoutMs: number;
};

export type CallCapturePortalResult = {
  ok: boolean;
  skipped?: boolean;
  status?: number;
};

export interface CallCapturePortal {
  deliver(delivery: CallCaptureDelivery): Promise<CallCapturePortalResult>;
}

export class HttpCallCapturePortal implements CallCapturePortal {
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
    this.secret = nonEmpty(options.secret);
    this.url = nonEmpty(options.url);
  }

  async deliver(
    delivery: CallCaptureDelivery,
  ): Promise<CallCapturePortalResult> {
    if (!this.url) return { ok: false, skipped: true };
    if (!this.secret) {
      this.logger.warn(
        "[call-capture] final delivery skipped reason=missing_auth",
      );
      return { ok: false, skipped: true };
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.secret}`,
      "Content-Type": "application/json",
    };

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
      if (!response.ok) {
        this.logger.warn(
          `[call-capture] final delivery failed status=${response.status}`,
        );
        return { ok: false, status: response.status };
      }
      this.logger.log(
        `[call-capture] final delivery succeeded status=${response.status}`,
      );
      return { ok: true, status: response.status };
    } catch {
      this.logger.warn("[call-capture] final delivery request failed");
      return { ok: false };
    }
  }
}

export class InMemoryCallCapturePortal implements CallCapturePortal {
  readonly deliveries: CallCaptureDelivery[] = [];

  async deliver(
    delivery: CallCaptureDelivery,
  ): Promise<CallCapturePortalResult> {
    this.deliveries.push(delivery);
    return { ok: true, status: 200 };
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

export type CallCaptureFinalSnapshot = {
  language: Record<string, unknown>;
  reportUnavailable?: boolean;
  sessionReport?: Record<string, unknown>;
  sessionUsage?: Record<string, unknown>;
  sttProfiles: Record<string, unknown>[];
};

export type CallCaptureFinishResult = {
  finalResult: CallCapturePortalResult;
  timedOut: boolean;
};

export type CallCaptureRecord =
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

export interface CallCaptureEventAdapter {
  observe(record: (record: CallCaptureRecord) => void): void;
  onClose(
    finish: (
      snapshot: CallCaptureFinalSnapshot,
    ) => Promise<CallCaptureFinishResult>,
  ): void;
}

class CallCapture {
  private readonly call: CallCaptureContext;
  private readonly finalizationTimeoutMs: number;
  private readonly getCallState: () => CallState | null;
  private readonly llmMetrics: Record<string, unknown>[] = [];
  private readonly logger: Pick<Console, "warn">;
  private latestUsage: Record<string, unknown> | undefined;
  private readonly now: () => Date;
  private readonly portal: CallCapturePortal;
  private readonly sessionEvents: SessionEventAnalytics =
    createEmptySessionEventAnalytics();
  private readonly toolOutcomes = new Map<string, ToolExecutionAnalytics>();
  private durationLimitReached = false;
  private finishing = false;

  constructor(input: {
    call: CallCaptureContext;
    finalizationTimeoutMs?: number;
    getCallState: () => CallState | null;
    logger?: Pick<Console, "warn">;
    now?: () => Date;
    portal: CallCapturePortal;
  }) {
    this.call = input.call;
    this.finalizationTimeoutMs = input.finalizationTimeoutMs ?? 4_000;
    this.getCallState = input.getCallState;
    this.logger = input.logger ?? console;
    this.now = input.now ?? (() => new Date());
    this.portal = input.portal;
  }

  record(record: CallCaptureRecord): void {
    if (this.finishing) return;
    switch (record.type) {
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

  async finish(
    snapshot: CallCaptureFinalSnapshot,
  ): Promise<CallCaptureFinishResult> {
    this.finishing = true;
    const sessionReport = sanitizedSessionReport(snapshot.sessionReport);
    const callState = this.getCallState();
    const recordedAppointmentActions = callState
      ? appointmentActions(callState)
      : [];
    for (const outcome of withAppointmentActionToolExecutionFallback(
      [...this.toolOutcomes.values()],
      recordedAppointmentActions,
    )) {
      this.recordToolOutcome(outcome);
    }

    const endedAt = this.now();
    const usage = this.latestUsage ?? snapshot.sessionUsage;
    const payload: Record<string, unknown> = {
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
      toolExecutions: [...this.toolOutcomes.values()],
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
      turnMetrics: turnMetricsFromReport(sessionReport),
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

    const delivery = this.portal
      .deliver({
        payload,
        timeoutMs: this.finalizationTimeoutMs,
      })
      .catch((): CallCapturePortalResult => ({ ok: false }));
    const final = await settleWithin(delivery, this.finalizationTimeoutMs);
    const result = {
      finalResult: final.value ?? { ok: false },
      timedOut: !final.settled,
    };
    if (result.timedOut || !result.finalResult.ok) {
      this.logger.warn(
        `[call-capture] final delivery incomplete timedOut=${result.timedOut} finalOk=${result.finalResult.ok}`,
      );
    }
    return result;
  }

  private recordToolOutcomes(
    event: Parameters<typeof snapshotToolExecutions>[0],
  ): void {
    const callState = this.getCallState();
    for (const outcome of snapshotToolExecutions(event, () =>
      callState ? takePatientIdentityOutcome(callState) : undefined,
    )) {
      this.recordToolOutcome(outcome);
    }
  }

  private recordToolOutcome(outcome: ToolExecutionAnalytics): void {
    if (!this.toolOutcomes.has(outcome.callId)) {
      this.toolOutcomes.set(outcome.callId, outcome);
    }
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
}): void {
  const capture = new CallCapture({
    call: input.call,
    ...(input.finalizationTimeoutMs === undefined
      ? {}
      : { finalizationTimeoutMs: input.finalizationTimeoutMs }),
    getCallState: input.getCallState,
    ...(input.logger ? { logger: input.logger } : {}),
    ...(input.now ? { now: input.now } : {}),
    portal: input.portal,
  });
  input.events.observe((record) => capture.record(record));
  input.events.onClose((snapshot) => capture.finish(snapshot));
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
  const chatHistory = asRecord(report.chat_history);
  const items = Array.isArray(chatHistory?.items)
    ? chatHistory.items.flatMap(sanitizedMessageItem)
    : [];
  return {
    chat_history: { items },
    ...Object.fromEntries(
      ["sdk_version", "timestamp", "usage"]
        .filter((key) => report[key] !== undefined)
        .map((key) => [key, report[key]]),
    ),
  };
}

function sanitizedMessageItem(value: unknown): Record<string, unknown>[] {
  const item = asRecord(value);
  if (
    item?.type !== "message" ||
    typeof item.id !== "string" ||
    typeof item.role !== "string" ||
    !Array.isArray(item.content)
  ) {
    return [];
  }
  const content = item.content.filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );
  if (content.length === 0) return [];

  return [
    {
      content,
      ...(typeof item.created_at === "number"
        ? { created_at: item.created_at }
        : {}),
      id: item.id,
      interrupted: item.interrupted === true,
      ...(asRecord(item.metrics) ? { metrics: item.metrics } : {}),
      role: item.role,
      ...(typeof item.transcript_confidence === "number"
        ? { transcript_confidence: item.transcript_confidence }
        : {}),
      type: "message",
    },
  ];
}

function turnMetricsFromReport(
  report: Record<string, unknown> | undefined,
): Record<string, unknown>[] {
  const chatHistory = asRecord(report?.chat_history);
  if (!Array.isArray(chatHistory?.items)) return [];
  return chatHistory.items.flatMap((value) => {
    const item = asRecord(value);
    const metrics = asRecord(item?.metrics);
    if (!item || !metrics || Object.keys(metrics).length === 0) return [];
    return [
      {
        createdAt: item.created_at,
        interrupted: item.interrupted === true,
        itemId: item.id,
        metrics,
        role: item.role,
        type: "message",
      },
    ];
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
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

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}
