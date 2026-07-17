// main.ts — LiveKit agent entry point
// Bootstraps the voice pipeline and connects to LiveKit Cloud.

import {
  AgentSession,
  FallbackAdapter,
  inference,
  type JobContext,
  ServerOptions,
  cli,
  defineAgent,
} from "@livekit/agents";
import * as assemblyai from "@livekit/agents-plugin-assemblyai";
import * as baseten from "@livekit/agents-plugin-baseten";
import * as rime from "@livekit/agents-plugin-rime";
import { fileURLToPath } from "node:url";
import { createAgent } from "./agent.js";
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
import { getAssemblyAISttOptions } from "./stt-config.js";
import {
  voiceMaxToolSteps,
  voiceTurnHandlingOptions,
} from "./session-options.js";
import { attachSipParticipantShutdown } from "./runtime/sip-room-shutdown.js";
import { createSttProfileSwitcher } from "./runtime/stt-profile-switcher.js";
import { attachSessionAnalytics } from "./runtime/session-analytics.js";
import {
  attachShutdownAnalytics,
  type PluginMetricSnapshot,
} from "./runtime/shutdown-analytics.js";

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
    ttsLanguage: input.options.lang,
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
      `[language] applied_tts_options provider=rime voice_language=${decision.to} tts_language=${ttsOptions.lang} speaker=${ttsOptions.speaker}`,
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
      const roomSid = ctx.job.room?.sid ?? "";
      const callId = sipCallId || roomName || participant.identity || "unknown";
      const startedAt = new Date();
      const livekitContext = {
        agentJobId: ctx.job.id,
        roomName,
        roomSid,
        sipCallId,
        sipParticipantIdentity: participant.identity ?? "",
      };
      const llmOptions = getLlmOptions();
      const primaryLLM = new baseten.LLM(llmOptions.primary);
      const fallbackLLM = new baseten.LLM(llmOptions.fallback);

      const llmWithFallback = new FallbackAdapter({
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

      const session = new AgentSession<CallState>({
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

      let callStateInitialized = false;
      const sttProfileSwitcher = createSttProfileSwitcher(stt, { startedAt });
      const analyticsBuffers = attachSessionAnalytics(session, {
        sttProfileSwitcher,
      });

      // Register closeout before pre-call bootstrap so start rows do not get
      // stranded if setup fails after the initial portal write.
      attachShutdownAnalytics(ctx, session, {
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
        isCallStateInitialized: () => callStateInitialized,
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

      const agent = createAgent(phoneLookup, trunkPhone, {
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
      callStateInitialized = true;

      await session.start({
        agent,
        room: ctx.room,
        inputOptions: {
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
