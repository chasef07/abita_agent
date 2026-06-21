// main.ts — LiveKit agent entry point
// Bootstraps the voice pipeline and connects to LiveKit Cloud.

import {
  inference,
  type JobContext,
  ServerOptions,
  cli,
  defineAgent,
  llm,
  voice,
} from "@livekit/agents";
import * as assemblyai from "@livekit/agents-plugin-assemblyai";
import * as baseten from "@livekit/agents-plugin-baseten";
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
  type RuntimeVoiceLanguageState,
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
import { getLlmOptions } from "./model-config.js";
import {
  getRimeTtsLanguageOptions,
  getRimeTtsOptions,
  getRimeTtsOptionsByLanguage,
  type RimeTtsLanguageOptions,
} from "./tts-config.js";
import {
  SttLanguageDetector,
  type SttLanguageDecision,
  type VoiceLanguage,
} from "./stt-language-detector.js";
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
  tts: rime.TTS;
  applyLanguageDecisionToTts: (
    decision: SttLanguageDecision,
  ) => RuntimeVoiceLanguageState | null;
  initialVoiceLanguage: RuntimeVoiceLanguageState;
  sttLanguageDetector: SttLanguageDetector;
};

function createRuntimeVoiceLanguageState(input: {
  decision?: Extract<SttLanguageDecision, { action: "switch" }>;
  language: VoiceLanguage;
  options: RimeTtsLanguageOptions;
}): RuntimeVoiceLanguageState {
  return {
    current: input.language,
    speaker: input.options.speaker,
    ttsLanguage: input.options.language,
    ttsProvider: "rime",
    ...(input.decision
      ? {
          providerCode: input.decision.providerCode,
          updatedAt: new Date().toISOString(),
          ...(input.decision.confidence !== undefined
            ? { confidence: input.decision.confidence }
            : {}),
        }
      : {}),
  };
}

function createRimeLanguageDecisionApplicator(input: {
  optionsByLanguage: Record<VoiceLanguage, RimeTtsLanguageOptions>;
  tts: rime.TTS;
}) {
  let appliedLanguage: VoiceLanguage = "en";

  return (decision: SttLanguageDecision): RuntimeVoiceLanguageState | null => {
    if (decision.action !== "switch") return null;
    if (decision.to === appliedLanguage) return null;

    const ttsOptions = input.optionsByLanguage[decision.to];
    input.tts.updateOptions(ttsOptions);
    appliedLanguage = decision.to;
    const voiceLanguage = createRuntimeVoiceLanguageState({
      decision,
      language: decision.to,
      options: ttsOptions,
    });
    console.log(
      `[language] applied_tts_options provider=rime voice_language=${decision.to} tts_language=${ttsOptions.language} speaker=${ttsOptions.speaker}`,
    );
    return voiceLanguage;
  };
}

function createTtsRuntime(input: { trunkPhone: string }): TtsRuntime {
  const sttLanguageDetector = new SttLanguageDetector();
  const initialLanguageOptions = getRimeTtsLanguageOptions({
    language: "en",
    trunkPhone: input.trunkPhone,
  });
  const ttsOptions = getRimeTtsOptions({
    language: "en",
    trunkPhone: input.trunkPhone,
  });
  const tts = new rime.TTS(ttsOptions);
  return {
    tts,
    applyLanguageDecisionToTts: createRimeLanguageDecisionApplicator({
      optionsByLanguage: getRimeTtsOptionsByLanguage(input.trunkPhone),
      tts,
    }),
    initialVoiceLanguage: createRuntimeVoiceLanguageState({
      language: "en",
      options: initialLanguageOptions,
    }),
    sttLanguageDetector,
  };
}

export default defineAgent({
  entry: async (ctx: JobContext) => {
    try {
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
      const llmOptions = getLlmOptions();
      const primaryLLM = new baseten.LLM(llmOptions.primary);
      const fallbackLLM = new baseten.LLM(llmOptions.fallback);

      const llmWithFallback = new llm.FallbackAdapter({
        llms: [primaryLLM, fallbackLLM],
      });
      const llmMetrics: PluginMetricSnapshot[] = [];
      llmWithFallback.on("metrics_collected", (metrics) => {
        // Per-plugin metrics are not deprecated and preserve token-speed and
        // peak-context analytics that cumulative session usage cannot express.
        llmMetrics.push(metrics as unknown as PluginMetricSnapshot);
      });
      const {
        applyLanguageDecisionToTts,
        initialVoiceLanguage,
        sttLanguageDetector,
        tts,
      } = createTtsRuntime({ trunkPhone });
      console.log(
        `[tts] provider=rime trunk=${trunkPhone} voice_language=${initialVoiceLanguage.current} tts_language=${initialVoiceLanguage.ttsLanguage} speaker=${initialVoiceLanguage.speaker}`,
      );

      const session = new voice.AgentSession<CallState>({
        stt,
        llm: llmWithFallback,
        tts,
        maxToolSteps: voiceMaxToolSteps,
        turnHandling: {
          turnDetection: new inference.TurnDetector(),
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

      const agent = new Agent(phoneLookup, trunkPhone, {
        onLanguageDecision: (decision) => {
          const voiceLanguage = applyLanguageDecisionToTts(decision);
          if (voiceLanguage) {
            session.userData.runtime.voiceLanguage = voiceLanguage;
          }
        },
        sttLanguageDetector,
      });

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
        voiceLanguage: initialVoiceLanguage,
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

      // Shutdown hook: capture session report + audio, post analytics.
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
              fallbackModel: llmOptions.fallback.model,
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
            language: sttLanguageDetector.telemetry,
            voiceLanguage: session.userData.runtime.voiceLanguage,
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
      });

      await session.start({
        agent,
        room: ctx.room,
        inputOptions: {
          noiseCancellation: TelephonyBackgroundVoiceCancellation(),
          deleteRoomOnClose: true,
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
