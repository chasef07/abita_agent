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
import * as rime from "@livekit/agents-plugin-rime";
import { fileURLToPath } from "node:url";
import { createVoiceAgent } from "./agent.js";
import {
  createCanonicalCallState,
  type CallState,
} from "./state/call-state.js";
import { publicCallerAppointments } from "./state/appointments.js";
import { transferIsAccepted } from "./state/call-lifecycle.js";
import {
  buildPreCallContextState,
  formatPhoneLookupLogLine,
  loadPreCallBootstrap,
} from "./runtime/precall-bootstrap.js";
import { MAX_CALL_DURATION_MS } from "./runtime/call-duration-deadline.js";
import { createLlmPair } from "./model-config.js";
import {
  createRimeVoiceLanguageState,
  getRimeTtsLanguageOptions,
  getRimeTtsOptions,
  getRimeTtsOptionsByLanguage,
  type RimeTtsLanguageOptions,
  type RuntimeVoiceLanguageState,
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
import {
  attachTurnProfileLifecycle,
  createTurnProfileController,
} from "./runtime/turn-profile-controller.js";
import {
  HttpCallPortal,
  attachCallCloseout,
  createLiveKitCallCloseoutEventAdapter,
} from "./runtime/call-closeout.js";
import { getAnalyticsSecret } from "./runtime/portal-auth.js";

type TtsRuntime = {
  tts: rime.TTS;
  applyLanguageDecisionToTts: (
    decision: SttLanguageDecision,
  ) => RuntimeVoiceLanguageState | null;
  initialVoiceLanguage: RuntimeVoiceLanguageState;
  sttLanguageDetector: SttLanguageDetector;
};

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
    const voiceLanguage = createRimeVoiceLanguageState({
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
    initialVoiceLanguage: createRimeVoiceLanguageState({
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
      const { primary: primaryLLM, fallback: fallbackLLM } = createLlmPair();

      const llmWithFallback = new FallbackAdapter({
        llms: [primaryLLM, fallbackLLM],
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
      const getCallState = (): CallState | null => {
        try {
          return session.userData;
        } catch {
          return null;
        }
      };
      attachSipParticipantShutdown(ctx, participant, {
        isTransferred: () => {
          const state = getCallState();
          return state ? transferIsAccepted(state) : false;
        },
      });

      const turnProfileController = createTurnProfileController(stt, {
        startedAt,
        updateEndpointing: (endpointing) => {
          session.updateOptions({ turnHandling: { endpointing } });
        },
      });
      attachTurnProfileLifecycle(session, turnProfileController);

      // Register closeout before pre-call bootstrap so start rows do not get
      // stranded if setup fails after the initial portal write.
      await attachCallCloseout({
        call: {
          callId,
          callerPhone,
          fallbackModel: fallbackLLM.model,
          initialVoiceLanguage,
          livekitContext,
          maxCallDurationMs: MAX_CALL_DURATION_MS,
          officePhone: trunkPhone,
          startedAt,
        },
        events: createLiveKitCallCloseoutEventAdapter(ctx, session, {
          callId,
          llm: llmWithFallback,
          maxCallDurationMs: MAX_CALL_DURATION_MS,
          roomName,
          shutdownSession: (reason) => {
            session.shutdown({ drain: false, reason });
          },
          sttLanguageDetector,
          sttProfiles: turnProfileController.sttProfiles,
        }),
        getCallState,
        portal: new HttpCallPortal({
          secret: getAnalyticsSecret(),
          url: process.env.ANALYTICS_URL,
        }),
      });

      console.log(
        `[call] Incoming: ${callerPhone} → ${trunkPhone} (${callId})`,
      );

      // Phone lookup before session start so context is ready for the first LLM turn.
      const preCall = await loadPreCallBootstrap({ callerPhone, trunkPhone });
      const { phoneLookup, verified } = preCall;
      console.log(formatPhoneLookupLogLine(callerPhone, phoneLookup));

      const { agent, office } = createVoiceAgent(phoneLookup, trunkPhone, {
        onAssistantText: turnProfileController.observeAssistantText,
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
        voiceLanguage: initialVoiceLanguage,
      });
      session.userData.runtime.maxCallDurationMs = MAX_CALL_DURATION_MS;

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
