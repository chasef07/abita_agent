// main.ts — LiveKit agent entry point
// Bootstraps the voice pipeline and connects to LiveKit Cloud.

import {
  type JobContext,
  type JobProcess,
  ServerOptions,
  cli,
  defineAgent,
  llm,
  tts as ttsCore,
  voice,
} from "@livekit/agents";
import * as assemblyai from "@livekit/agents-plugin-assemblyai";
import * as silero from "@livekit/agents-plugin-silero";
import * as baseten from "@livekit/agents-plugin-baseten";
import * as cartesia from "@livekit/agents-plugin-cartesia";
import * as livekit from "@livekit/agents-plugin-livekit";
import * as rime from "@livekit/agents-plugin-rime";
import { TelephonyBackgroundVoiceCancellation } from "@livekit/noise-cancellation-node";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Agent } from "./agent.js";
import {
  buildLlmSummary,
  createEmptySessionEventAnalytics,
  snapshotCloseEvent,
  snapshotErrorEvent,
  snapshotFalseInterruptionEvent,
  snapshotOverlappingSpeechEvent,
  snapshotSttProfileTransition,
  snapshotToolExecutions,
  type SttProfileTransitionAnalytics,
  type ToolExecutionAnalytics,
} from "./call-observability.js";
import {
  createCanonicalCallState,
  publicCallerAppointments,
  type CallState,
} from "./state/call-state.js";
import {
  buildPreCallContextState,
  formatPhoneLookupLogLine,
  loadPreCallBootstrap,
} from "./runtime/precall-bootstrap.js";
import {
  getAnalyticsSecret,
  postAnalyticsPayload,
} from "./runtime/analytics-post.js";
import {
  MAX_CALL_DURATION_MS,
  attachCallDurationDeadline,
} from "./runtime/call-duration-deadline.js";
import { fallbackLLMOptions, primaryLLMOptions } from "./model-config.js";
import {
  getCartesiaTtsOptions,
  getCartesiaTtsOptionsByLanguage,
  getRimeTtsOptions,
  ttsProviderForTrunk,
  type TtsProvider,
} from "./tts-config.js";
import { VoiceLanguageRuntime } from "./language-runtime.js";
import {
  type SttProfile,
  getAssemblyAISttOptions,
  getAssemblyAISttProfileOptions,
  selectSttProfileForAssistantText,
} from "./stt-config.js";
import {
  voiceMaxToolSteps,
  voiceTurnHandlingOptions,
} from "./session-options.js";
import { attachSipParticipantShutdown } from "./runtime/sip-room-shutdown.js";

type TurnMetricSnapshot = {
  itemId: string;
  role: string;
  type: string;
  createdAt: number;
  interrupted: boolean;
  metrics: Record<string, unknown>;
};

type PluginMetricSnapshot = Record<string, unknown>;

type TtsRuntime = {
  provider: TtsProvider;
  tts: ttsCore.TTS;
  languageRuntime: VoiceLanguageRuntime;
};

function createTtsRuntime(trunkPhone: string): TtsRuntime {
  const provider = ttsProviderForTrunk(trunkPhone);
  if (provider === "rime") {
    const tts = new rime.TTS(getRimeTtsOptions());
    return {
      provider,
      tts,
      languageRuntime: new VoiceLanguageRuntime(tts, {
        appliedTtsLanguage: "en",
      }),
    };
  }

  const tts = new cartesia.TTS(getCartesiaTtsOptions());
  return {
    provider,
    tts,
    languageRuntime: new VoiceLanguageRuntime(tts, {
      appliedTtsLanguage: "en",
      ttsOptionsByLanguage: getCartesiaTtsOptionsByLanguage(),
    }),
  };
}

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },

  entry: async (ctx: JobContext) => {
    try {
      const vad = ctx.proc.userData.vad as silero.VAD;

      const primaryLLM = new baseten.LLM(primaryLLMOptions);
      const fallbackLLM = new baseten.LLM(fallbackLLMOptions);

      const llmWithFallback = new llm.FallbackAdapter({
        llms: [primaryLLM, fallbackLLM],
      });
      const llmMetrics: PluginMetricSnapshot[] = [];
      llmWithFallback.on("metrics_collected", (metrics) => {
        // Per-plugin metrics are not deprecated and preserve token-speed and
        // peak-context analytics that cumulative session usage cannot express.
        llmMetrics.push(metrics as unknown as PluginMetricSnapshot);
      });
      const stt = new assemblyai.STT(getAssemblyAISttOptions());

      // Connect and wait for the SIP participant
      await ctx.connect();
      const participant = await ctx.waitForParticipant();

      const callerPhone =
        participant.attributes["sip.phoneNumber"] ?? participant.identity;
      const trunkPhone = participant.attributes["sip.trunkPhoneNumber"] ?? "";
      const sipCallId = participant.attributes["sip.callID"] ?? "";
      const roomName = ctx.room.name ?? "";
      const callId = sipCallId || roomName || participant.identity || "unknown";
      const startedAt = new Date();
      const livekitContext = {
        agentJobId: ctx.job.id,
        roomName,
        sipCallId,
        sipParticipantIdentity: participant.identity ?? "",
      };
      const {
        provider: ttsProvider,
        tts,
        languageRuntime,
      } = createTtsRuntime(trunkPhone);
      console.log(`[tts] provider=${ttsProvider} trunk=${trunkPhone}`);

      const session = new voice.AgentSession<CallState>({
        stt,
        llm: llmWithFallback,
        tts,
        vad,
        maxToolSteps: voiceMaxToolSteps,
        turnHandling: {
          turnDetection: new livekit.turnDetector.MultilingualModel(),
          ...voiceTurnHandlingOptions,
        },
      });
      attachSipParticipantShutdown(ctx, participant, {
        isTransferred: () => session.userData.runtime.transferred,
      });

      const callDurationDeadline = attachCallDurationDeadline(ctx, {
        callId,
        onExceeded: () => {
          try {
            session.userData.runtime.endedReason = "duration_limit";
            session.userData.runtime.maxCallDurationMs = MAX_CALL_DURATION_MS;
          } catch {
            // The deadline is far beyond normal bootstrap time, but keep this
            // guard so shutdown still happens if state has not initialized.
          }
        },
        roomName,
        shutdownSession: (reason) => {
          session.shutdown({ drain: false, reason });
        },
      });

      console.log(
        `[call] Incoming: ${callerPhone} → ${trunkPhone} (${callId})`,
      );

      await postAnalyticsPayload(
        {
          callId,
          callerPhone,
          officePhone: trunkPhone,
          startedAt: startedAt.toISOString(),
          status: "IN_PROGRESS",
          ...livekitContext,
        },
        {
          maxAttempts: 1,
          phase: "call-start",
          retryDelayMs: 0,
          secret: getAnalyticsSecret(),
          timeoutMs: 2_000,
          url: process.env.ANALYTICS_URL,
        },
      );

      // Phone lookup before session start so context is ready for the first LLM turn.
      const preCall = await loadPreCallBootstrap({ callerPhone, trunkPhone });
      const { office, phoneLookup, verified } = preCall;
      console.log(formatPhoneLookupLogLine(callerPhone, phoneLookup));

      const agent = new Agent(phoneLookup, trunkPhone, { languageRuntime });

      session.userData = createCanonicalCallState({
        preCall: buildPreCallContextState(phoneLookup, callerPhone),
        preCallLookup: preCall.telemetry,
        officeKey: office.key,
        amdOfficePhone: office.amdOfficePhone,
        sipRoomName: roomName,
        sipParticipantIdentity: participant.identity ?? "",
        callId,
        callerPhone,
        trunkPhone,
        patientId: verified?.patientId ?? null,
        patientName: verified?.name ?? null,
        dob: verified?.dob ?? null,
        insuranceCarrier: verified?.insuranceCarrier ?? null,
        insPlanId: verified?.insPlanId ?? null,
        respPartyId: verified?.respPartyId ?? null,
        checkedInsurancePlan: verified?.insuranceCarrier ?? null,
        checkedInsuranceCoverageType: null,
        routing: verified?.routing ?? null,
        lastAvailabilityRouting: null,
        lastAvailabilitySlots: [],
        bookableAvailabilitySlots: [],
        allowedProviders: verified?.allowedProviders ?? [],
        routingAmbiguous: verified?.routingAmbiguous ?? false,
        preauthRequired: verified?.preauthRequired ?? false,
        appointmentsStatus: verified?.appointmentsStatus ?? null,
        appointments: publicCallerAppointments(verified?.appointments),
        transferred: false,
      });
      session.userData.runtime.maxCallDurationMs = MAX_CALL_DURATION_MS;

      let activeSttProfile: SttProfile = "default";
      let promptedSttProfile: SttProfile | null = null;
      const sttProfiles: SttProfileTransitionAnalytics[] = [
        snapshotSttProfileTransition({
          createdAt: startedAt,
          from: null,
          reason: "startup",
          to: activeSttProfile,
        }),
      ];
      const turnMetrics: TurnMetricSnapshot[] = [];
      const toolExecutions: ToolExecutionAnalytics[] = [];
      const sessionEvents = createEmptySessionEventAnalytics();
      let latestUsage: Record<string, unknown> | undefined;

      const applySttProfile = (
        profile: SttProfile,
        reason: string,
        details: {
          assistantText?: string;
          callerText?: string;
          createdAt?: number;
        } = {},
      ) => {
        if (profile === activeSttProfile) return;

        const previousProfile = activeSttProfile;
        stt.updateOptions(getAssemblyAISttProfileOptions(profile));
        activeSttProfile = profile;
        sttProfiles.push(
          snapshotSttProfileTransition({
            ...details,
            createdAt: details.createdAt ?? Date.now(),
            from: previousProfile,
            reason,
            to: profile,
          }),
        );
        console.log(`[stt] AssemblyAI profile=${profile} reason=${reason}`);
      };

      session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
        if (ev.item.type !== "message") return;

        const metrics = Object.fromEntries(
          Object.entries(ev.item.metrics ?? {}).filter(
            ([, value]) => value !== undefined,
          ),
        );
        if (Object.keys(metrics).length > 0) {
          turnMetrics.push({
            itemId: ev.item.id,
            role: ev.item.role,
            type: ev.item.type,
            createdAt: ev.createdAt,
            interrupted: ev.item.interrupted,
            metrics,
          });
        }

        if (ev.item.role !== "assistant") return;

        const assistantText = ev.item.textContent ?? "";
        const profile = selectSttProfileForAssistantText(assistantText, {
          fallbackProfile: promptedSttProfile,
        });
        promptedSttProfile = profile === "default" ? null : profile;
        applySttProfile(profile, "assistant_prompt", {
          assistantText,
          createdAt: ev.createdAt,
        });
      });

      session.on(voice.AgentSessionEventTypes.SessionUsageUpdated, (ev) => {
        latestUsage = ev.usage as unknown as Record<string, unknown>;
      });

      session.on(voice.AgentSessionEventTypes.FunctionToolsExecuted, (ev) => {
        toolExecutions.push(...snapshotToolExecutions(ev));
      });

      session.on(voice.AgentSessionEventTypes.Error, (ev) => {
        sessionEvents.errors.push(snapshotErrorEvent(ev));
      });

      session.on(voice.AgentSessionEventTypes.Close, (ev) => {
        sessionEvents.close = snapshotCloseEvent(ev);
      });

      session.on(voice.AgentSessionEventTypes.AgentFalseInterruption, (ev) => {
        sessionEvents.falseInterruptions.push(
          snapshotFalseInterruptionEvent(ev),
        );
      });

      session.on(voice.AgentSessionEventTypes.OverlappingSpeech, (ev) => {
        sessionEvents.overlappingSpeech.push(
          snapshotOverlappingSpeechEvent(ev),
        );
      });

      session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
        if (ev.isFinal) {
          applySttProfile("default", "user_final", {
            callerText: ev.transcript,
            createdAt: ev.createdAt,
          });
        }
      });

      // Shutdown hook: capture session report + audio, post analytics, delete room.
      ctx.addShutdownCallback(async () => {
        callDurationDeadline.clear();
        let sessionReport: Record<string, unknown> | undefined;
        let audioBase64: string | undefined;

        try {
          const report = ctx.makeSessionReport();
          sessionReport = voice.sessionReportToJSON(report);

          if (report.audioRecordingPath) {
            try {
              const audioBuffer = await readFile(report.audioRecordingPath);
              audioBase64 = audioBuffer.toString("base64");
              console.log(
                `[shutdown] Audio captured: ${audioBuffer.length} bytes`,
              );
            } catch (audioErr) {
              console.warn("[shutdown] Could not read audio file:", audioErr);
            }
          }
        } catch (reportErr) {
          console.warn(
            "[shutdown] Could not capture session report:",
            reportErr,
          );
        }

        // Post usage, turn metrics, and session report to analytics dashboard.
        // Session-level MetricsCollected is deprecated in LiveKit Agents; usage
        // and ChatMessage.metrics are the supported observability surfaces.
        if (process.env.ANALYTICS_URL) {
          const endedAt = new Date();
          const status = session.userData.runtime.transferred
            ? "ESCALATED"
            : "COMPLETED";
          const endedReason = callDurationDeadline.exceeded()
            ? "duration_limit"
            : undefined;
          const payload: Record<string, unknown> = {
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
                  maxCallDurationMs: MAX_CALL_DURATION_MS,
                }
              : {}),
            usage: latestUsage ?? session.usage,
            llmSummary: buildLlmSummary({
              fallbackModel: fallbackLLMOptions.model,
              llmMetrics,
              usage: latestUsage ?? session.usage,
            }),
            llmMetrics,
            sttProfiles,
            sessionEvents,
            toolExecutions,
            turnMetrics,
            callState: session.userData,
            preCallLookup: session.userData.runtime.preCallLookup,
            language: languageRuntime.telemetry,
            sessionReport,
            ...livekitContext,
          };

          // Include audio only if under 4MB base64 to avoid payload limits
          if (audioBase64 && audioBase64.length < 4 * 1024 * 1024) {
            payload.audioBase64 = audioBase64;
          } else if (audioBase64) {
            console.warn(
              `[shutdown] Audio too large for analytics POST (${(audioBase64.length / 1024 / 1024).toFixed(1)}MB), sending without audio`,
            );
          }

          await postAnalyticsPayload(payload, {
            phase: "shutdown",
            secret: getAnalyticsSecret(),
            url: process.env.ANALYTICS_URL,
          });
        }

        try {
          if (callDurationDeadline.roomDeletionStarted()) {
            await callDurationDeadline.waitForRoomDeletion();
          }
          if (roomName && !callDurationDeadline.roomDeletionCompleted()) {
            await ctx.deleteRoom(roomName);
          }
        } catch (err) {
          console.error("[shutdown] Failed to delete room:", err);
        }
      });

      await session.start({
        agent,
        room: ctx.room,
        inputOptions: {
          noiseCancellation: TelephonyBackgroundVoiceCancellation(),
          participantIdentity: participant.identity,
        },
      });
    } catch (err) {
      console.error("[entry] FATAL:", err);
      throw err;
    }
  },
});

cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: "abita-agent",
    shutdownProcessTimeout: 60_000, // 60s to allow analytics POST to complete
  }),
);
