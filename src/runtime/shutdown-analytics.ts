import {
  sessionReportToJSON,
  type AgentSession,
  type JobContext,
} from "@livekit/agents";
import { readFile } from "node:fs/promises";
import {
  buildLlmSummary,
  withAppointmentActionToolExecutionFallback,
} from "../call-observability.js";
import {
  appointmentActions,
  type CallState,
  type RuntimeVoiceLanguageState,
} from "../state/call-state.js";
import type { getLlmOptions } from "../model-config.js";
import type { SttLanguageDetector } from "../stt-language-detector.js";
import {
  getAnalyticsSecret,
  postShutdownAnalyticsPayloads,
} from "./analytics-post.js";
import {
  MAX_CALL_DURATION_MS,
  type CallDurationDeadline,
} from "./call-duration-deadline.js";
import type { SessionAnalyticsBuffers } from "./session-analytics.js";

export type PluginMetricSnapshot = Record<string, unknown>;

export function attachShutdownAnalytics(
  ctx: JobContext,
  session: AgentSession<CallState>,
  options: {
    callId: string;
    callerPhone: string;
    trunkPhone: string;
    startedAt: Date;
    livekitContext: Record<string, unknown>;
    callDurationDeadline: CallDurationDeadline;
    llmOptions: ReturnType<typeof getLlmOptions>;
    llmMetrics: PluginMetricSnapshot[];
    sttLanguageDetector: SttLanguageDetector;
    analyticsBuffers: SessionAnalyticsBuffers;
    initialVoiceLanguage: RuntimeVoiceLanguageState;
    isCallStateInitialized: () => boolean;
  },
) {
  const {
    callId,
    callerPhone,
    trunkPhone,
    startedAt,
    livekitContext,
    callDurationDeadline,
    llmOptions,
    llmMetrics,
    sttLanguageDetector,
    analyticsBuffers,
    initialVoiceLanguage,
    isCallStateInitialized,
  } = options;

  // Shutdown hook: capture session report + audio, post analytics.
  ctx.addShutdownCallback(async () => {
    callDurationDeadline.clear();
    let sessionReport: Record<string, unknown> | undefined;
    let audioBase64: string | undefined;

    try {
      const report = ctx.makeSessionReport();
      sessionReport = sessionReportToJSON(report);

      if (report.audioRecordingPath) {
        try {
          const audioBuffer = await readFile(report.audioRecordingPath);
          audioBase64 = audioBuffer.toString("base64");
          console.log(`[shutdown] Audio captured: ${audioBuffer.length} bytes`);
        } catch (audioErr) {
          console.warn("[shutdown] Could not read audio file:", audioErr);
        }
      }
    } catch (reportErr) {
      console.warn("[shutdown] Could not capture session report:", reportErr);
    }

    // Post usage, turn metrics, and session report to analytics dashboard.
    // Session-level MetricsCollected is deprecated in LiveKit Agents; usage
    // and ChatMessage.metrics are the supported observability surfaces.
    if (process.env.ANALYTICS_URL) {
      const callState = isCallStateInitialized() ? session.userData : null;
      const runtime = callState?.runtime;
      const endedAt = new Date();
      const status = runtime?.transferred
        ? "ESCALATED"
        : callState
          ? "COMPLETED"
          : "FAILED";
      const endedReason = callDurationDeadline.exceeded()
        ? "duration_limit"
        : callState
          ? runtime?.endedReason
          : "call_state_not_initialized";
      const recordedAppointmentActions = callState
        ? appointmentActions(callState)
        : [];
      const payloadToolExecutions = withAppointmentActionToolExecutionFallback(
        analyticsBuffers.toolExecutions,
        recordedAppointmentActions,
      );
      const usage = analyticsBuffers.latestUsage ?? session.usage;
      const summaryPayload: Record<string, unknown> = {
        callId,
        callerPhone,
        officePhone: trunkPhone,
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        durationSec: Math.round(
          (endedAt.getTime() - startedAt.getTime()) / 1000,
        ),
        status,
        ...(endedReason
          ? {
              endedReason,
              ...(callDurationDeadline.exceeded()
                ? { maxCallDurationMs: MAX_CALL_DURATION_MS }
                : {}),
            }
          : {}),
        usage,
        llmSummary: buildLlmSummary({
          fallbackModel: llmOptions.fallback.model,
          llmMetrics,
          usage,
        }),
        sessionEvents: analyticsBuffers.sessionEvents,
        toolExecutions: payloadToolExecutions,
        appointmentActions: recordedAppointmentActions,
        language: sttLanguageDetector.telemetry,
        voiceLanguage: runtime?.voiceLanguage ?? initialVoiceLanguage,
        ...livekitContext,
      };
      const payload: Record<string, unknown> = {
        ...summaryPayload,
        llmMetrics,
        sttProfiles: analyticsBuffers.sttProfiles,
        turnMetrics: analyticsBuffers.turnMetrics,
        ...(callState ? { callState } : {}),
        ...(runtime?.preCallLookup
          ? { preCallLookup: runtime.preCallLookup }
          : {}),
        sessionReport,
      };

      // Include audio only if under 4MB base64 to avoid payload limits
      if (audioBase64 && audioBase64.length < 4 * 1024 * 1024) {
        payload.audioBase64 = audioBase64;
      } else if (audioBase64) {
        console.warn(
          `[shutdown] Audio too large for analytics POST (${(audioBase64.length / 1024 / 1024).toFixed(1)}MB), sending without audio`,
        );
      }

      await postShutdownAnalyticsPayloads(summaryPayload, payload, {
        secret: getAnalyticsSecret(),
        url: process.env.ANALYTICS_URL,
      });
    }
  });
}
