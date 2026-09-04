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
import { fileURLToPath } from "node:url";
import { createVoiceAgent } from "./agent.js";
import type { CallState } from "./state/call-state.js";
import { transferIsAccepted } from "./state/call-lifecycle.js";
import {
  formatPhoneLookupLogLine,
  loadPreCallBootstrap,
} from "./runtime/precall-bootstrap.js";
import {
  applyPreCallBootstrap,
  createInitialCallState,
} from "./runtime/initial-call-state.js";
import { MAX_CALL_DURATION_MS } from "./runtime/call-duration-deadline.js";
import { createLlmPair } from "./model-config.js";
import {
  createVoiceLanguageState,
  VoiceLanguageRuntime,
} from "./runtime/voice-language.js";
import { createTtsRuntime } from "./tts-runtime.js";
import { getAssemblyAIInferenceSttOptions } from "./stt-config.js";
import {
  configureVoiceVad,
  voiceMaxToolSteps,
  voiceTurnHandlingOptions,
} from "./session-options.js";
import { attachSipParticipantShutdown } from "./runtime/sip-room-shutdown.js";
import {
  attachTurnProfileLifecycle,
  createTurnProfileController,
} from "./runtime/turn-profile-controller.js";
import {
  attachTranscriptionTimeoutRecovery,
  voiceTranscriptionTimeoutMs,
} from "./runtime/transcription-timeout-recovery.js";
import {
  HttpCallPortal,
  attachCallCloseout,
  attachStartupCallCloseout,
  createLiveKitCallCloseoutEventAdapter,
  resolveLiveKitCallStart,
} from "./runtime/call-closeout.js";
import {
  getProductInteractionConfig,
  validateRuntimeConfig,
} from "./runtime/portal-auth.js";
import {
  getOfficeProfileByPhone,
  getProductOfficeKeyByPhone,
} from "./customers/abita/profile.js";
import { coordinateSessionStartup } from "./runtime/session-startup.js";
import { HttpOwnedMiddleware } from "./clients/owned-middleware.js";

validateRuntimeConfig();

export default defineAgent({
  entry: async (ctx: JobContext) => {
    try {
      const stt = new inference.STT(getAssemblyAIInferenceSttOptions());

      // Connect and wait for the SIP participant
      await ctx.connect();
      const participant = await ctx.waitForParticipant();

      const callerPhone =
        participant.attributes["sip.phoneNumber"] ?? participant.identity;
      const trunkPhone = participant.attributes["sip.trunkPhoneNumber"] ?? "";
      const sipCallId = participant.attributes["sip.callID"] ?? "";
      const roomName = ctx.room.name ?? "";
      const roomSid = ctx.job.room?.sid ?? "";
      const { callId, startedAt } = resolveLiveKitCallStart({
        participantIdentity: participant.identity ?? "",
        roomCreationTime: ctx.room.creationTime,
        roomName,
        sipCallId,
      });
      const livekitContext = {
        agentJobId: ctx.job.id,
        roomName,
        roomSid,
        sipCallId,
        sipParticipantIdentity: participant.identity ?? "",
      };
      const office = getOfficeProfileByPhone(trunkPhone);
      const productOfficeKey = getProductOfficeKeyByPhone(trunkPhone);
      let startupActive = true;
      console.log(
        `[call] Incoming: ${callerPhone} → ${trunkPhone} (${callId})`,
      );
      const portal = new HttpCallPortal(
        getProductInteractionConfig(office.key),
      );
      const ownedMiddleware = new HttpOwnedMiddleware();
      await coordinateSessionStartup({
        lookup: (signal) =>
          loadPreCallBootstrap({
            middleware: ownedMiddleware,
            callerPhone,
            trunkPhone,
            signal,
          }),
        startupIsActive: () => startupActive,
        initializeRuntime: async () => {
          const callStart = await attachStartupCallCloseout({
            call: {
              callId,
              callerPhone,
              livekitContext,
              officeKey: productOfficeKey,
              officePhone: trunkPhone,
              startedAt,
            },
            portal,
            registerShutdownCallback: (closeout) => {
              ctx.addShutdownCallback(closeout);
            },
          });
          const { primary: primaryLLM, fallback: fallbackLLM } =
            createLlmPair();
          const llmWithFallback = new FallbackAdapter({
            llms: [primaryLLM, fallbackLLM],
          });
          const ttsRuntime = createTtsRuntime(trunkPhone);
          const optionsByLanguage = ttsRuntime.optionsByLanguage;
          const initialOptions = optionsByLanguage.en;
          const initialVoiceLanguage = createVoiceLanguageState(
            "en",
            initialOptions,
            ttsRuntime.provider,
          );
          const tts = ttsRuntime.tts;
          console.log(
            `[tts] provider=${ttsRuntime.provider} trunk=${trunkPhone} voice_language=${initialVoiceLanguage.current} tts_language=${initialVoiceLanguage.ttsLanguage} speaker=${initialVoiceLanguage.speaker}`,
          );

          const initialCall = {
            amdOfficePhone: office.amdOfficePhone,
            callId,
            callerPhone,
            maxDurationMs: MAX_CALL_DURATION_MS,
            officeKey: office.key,
            roomName,
            sipParticipantIdentity: participant.identity ?? "",
            trunkPhone,
            voiceLanguage: initialVoiceLanguage,
          };
          const callState = createInitialCallState(initialCall);
          if (!callState.runtime.voiceLanguage) {
            throw new Error("Initial voice language state is required");
          }
          const voiceLanguageRuntime = new VoiceLanguageRuntime({
            optionsByLanguage,
            state: callState.runtime.voiceLanguage,
            tts: ttsRuntime,
          });
          let callStateReady = false;
          const session = new AgentSession<CallState>({
            stt,
            llm: llmWithFallback,
            tts,
            userData: callState,
            maxToolSteps: voiceMaxToolSteps,
            transcriptionTimeout: voiceTranscriptionTimeoutMs,
            turnHandling: {
              turnDetection: new inference.TurnDetector(),
              ...voiceTurnHandlingOptions,
            },
          });
          attachTranscriptionTimeoutRecovery(session);
          configureVoiceVad(session.vad);
          const getCallState = (): CallState | null => {
            return callStateReady ? session.userData : null;
          };
          attachSipParticipantShutdown(ctx, participant, {
            isTransferred: () => {
              const state = getCallState();
              return state ? transferIsAccepted(state) : false;
            },
            onShutdownRequested: () => {
              startupActive = false;
            },
          });

          const turnProfileController = createTurnProfileController(stt, {
            startedAt,
            updateEndpointing: (endpointing) => {
              session.updateOptions({ turnHandling: { endpointing } });
            },
          });
          attachTurnProfileLifecycle(session, turnProfileController);

          await attachCallCloseout({
            call: {
              callId,
              callerPhone,
              fallbackModel: fallbackLLM.model,
              initialVoiceLanguage,
              livekitContext,
              maxCallDurationMs: MAX_CALL_DURATION_MS,
              officeKey: productOfficeKey,
              officePhone: trunkPhone,
              startedAt,
            },
            events: createLiveKitCallCloseoutEventAdapter(ctx, session, {
              callId,
              maxCallDurationMs: MAX_CALL_DURATION_MS,
              roomName,
              shutdownSession: (reason) => {
                session.shutdown({ drain: false, reason });
              },
              sttProfiles: turnProfileController.sttProfiles,
              voiceLanguageRuntime,
            }),
            getCallState,
            onCloseoutAttached: callStart.handOffToCallCloseout,
            portal,
            startResult: callStart.startResult,
          });

          return {
            callState,
            initialCall,
            initialVoiceLanguage,
            markCallStateReady: () => {
              callStateReady = true;
            },
            session,
            turnProfileController,
            voiceLanguageRuntime,
          };
        },
        createState: (preCall, runtime, startupOverlap) => {
          const { phoneLookup } = preCall;
          console.log(formatPhoneLookupLogLine(callerPhone, phoneLookup));
          applyPreCallBootstrap(
            runtime.callState,
            runtime.initialCall,
            preCall,
          );
          runtime.callState.runtime.preCallLookup.startupOverlap =
            startupOverlap;

          const { agent } = createVoiceAgent(trunkPhone, {
            ownedMiddleware,
            onAssistantText: runtime.turnProfileController.observeAssistantText,
            voiceLanguageRuntime: runtime.voiceLanguageRuntime,
          });
          runtime.markCallStateReady();
          return { agent, callState: runtime.callState };
        },
        startSession: async ({ agent }, runtime) => {
          await runtime.session.start({
            agent,
            room: ctx.room,
            inputOptions: {
              deleteRoomOnClose: true,
              participantIdentity: participant.identity,
            },
          });
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
