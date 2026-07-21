import {
  AgentSessionEventTypes,
  sessionReportToJSON,
  type AgentSession,
  type JobContext,
} from "@livekit/agents";
import { readFile } from "node:fs/promises";
import type { CallState } from "../state/call-state.js";
import { transferIsAccepted } from "../state/call-lifecycle.js";
import { appointmentActions } from "../state/observability.js";
import type { SttLanguageDetector } from "../stt-language-detector.js";
import type { RuntimeVoiceLanguageState } from "../tts-config.js";
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
import { attachCallDurationDeadline } from "./call-duration-deadline.js";
import type { SttProfileSwitcher } from "./stt-profile-switcher.js";

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

type CallContext = {
  callId: string;
  callerPhone: string;
  fallbackModel: string;
  initialVoiceLanguage: RuntimeVoiceLanguageState;
  livekitContext: Record<string, unknown>;
  maxCallDurationMs?: number;
  officePhone: string;
  startedAt: Date;
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

export async function attachCallCloseout(input: {
  call: CallContext;
  events: CallCloseoutEventAdapter;
  getCallState: () => CallState | null;
  logger?: Pick<Console, "warn">;
  now?: () => Date;
  portal: CallPortal;
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
      observedToolExecutions.push(...snapshotToolExecutions(event));
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
      callId: input.call.callId,
      callerPhone: input.call.callerPhone,
      officePhone: input.call.officePhone,
      startedAt: input.call.startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationSec: Math.round(
        (endedAt.getTime() - input.call.startedAt.getTime()) / 1000,
      ),
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
        callState?.runtime.voiceLanguage ?? input.call.initialVoiceLanguage,
      toolExecutions,
      appointmentActions: recordedAppointmentActions,
      ...input.call.livekitContext,
    };
    const richPayload: Record<string, unknown> = {
      ...summaryPayload,
      llmMetrics,
      sttProfiles: capture.sttProfiles,
      turnMetrics,
      ...(callState ? { callState } : {}),
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

  const startResult = await deliverWithRetries(
    input.portal,
    {
      payload: {
        callId: input.call.callId,
        callerPhone: input.call.callerPhone,
        officePhone: input.call.officePhone,
        startedAt: input.call.startedAt.toISOString(),
        status: "IN_PROGRESS",
        ...input.call.livekitContext,
      },
      phase: "call-start",
      timeoutMs: 2_000,
    },
    { maxAttempts: 1, retryDelayMs: 0 },
  );
  return { startResult };
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
    sttLanguageDetector: SttLanguageDetector;
    sttProfileSwitcher: SttProfileSwitcher;
  },
): CallCloseoutEventAdapter {
  let closeout: (() => Promise<CallCloseoutResult>) | undefined;
  let deadline: ReturnType<typeof attachCallDurationDeadline> | undefined;

  return {
    async capture() {
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
        language: options.sttLanguageDetector.telemetry,
        ...(reportUnavailable ? { reportUnavailable } : {}),
        sessionReport,
        sessionUsage: session.usage as unknown as Record<string, unknown>,
        sttProfiles: [...options.sttProfileSwitcher.sttProfiles],
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
        if (event.item.role === "assistant") {
          options.sttProfileSwitcher.applyAssistantPromptProfile(
            event.item.textContent ?? "",
            { createdAt: event.createdAt },
          );
        }
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
      session.on(AgentSessionEventTypes.UserInputTranscribed, (event) => {
        if (!event.isFinal) return;
        options.sttProfileSwitcher.applySttProfile("default", "user_final", {
          callerText: event.transcript,
          createdAt: event.createdAt,
        });
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
