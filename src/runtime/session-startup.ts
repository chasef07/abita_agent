import {
  AgentSession,
  FallbackAdapter,
  inference,
  type JobContext,
} from "@livekit/agents";
import * as assemblyai from "@livekit/agents-plugin-assemblyai";
import * as krisp from "@livekit/agents-plugin-krisp";
import { createVoiceAgent } from "../agent.js";
import type { CallState } from "../state/call-state.js";
import { transferIsAccepted } from "../state/call-lifecycle.js";
import {
  formatPhoneLookupLogLine,
  lookupByPhone,
} from "./precall-bootstrap.js";
import {
  applyPreCallLookup,
  createInitialCallState,
} from "./initial-call-state.js";
import { MAX_CALL_DURATION_MS } from "./call-duration-deadline.js";
import { createLlmPair } from "../model-config.js";
import {
  createVoiceLanguageState,
  VoiceLanguageRuntime,
} from "./voice-language.js";
import { createTtsRuntime } from "../tts-runtime.js";
import { getAssemblyAISttOptions } from "../stt-config.js";
import {
  configureVoiceVad,
  voiceMaxToolSteps,
  voiceTurnHandlingOptions,
} from "../session-options.js";
import { attachSipParticipantShutdown } from "./sip-room-shutdown.js";
import {
  attachTurnProfileLifecycle,
  createTurnProfileController,
} from "./turn-profile-controller.js";
import {
  attachTranscriptionTimeoutRecovery,
  voiceTranscriptionTimeoutMs,
} from "./transcription-timeout-recovery.js";
import {
  HttpCallPortal,
  attachCallCloseout,
  attachStartupCallCloseout,
  createLiveKitCallCloseoutEventAdapter,
  resolveLiveKitCallStart,
} from "./call-closeout.js";
import { getProductInteractionConfig } from "./portal-auth.js";
import {
  getOfficeProfileByPhone,
  getProductOfficeKeyByPhone,
} from "../customers/abita/profile.js";
import { HttpOwnedMiddleware } from "../clients/owned-middleware.js";
import { getMiddlewareConfig } from "./middleware-routing.js";

/** Owns call registration, lookup, voice setup, and the closeout handoff. */
export async function startVoiceCall(ctx: JobContext): Promise<void> {
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
  // An unknown trunk has no trusted tenant for Product delivery.
  const portal = new HttpCallPortal(getProductInteractionConfig(office.key));
  const call = {
    callId,
    callerPhone,
    livekitContext,
    officeKey: productOfficeKey,
    officePhone: trunkPhone,
    startedAt,
  };
  const startup = new AbortController();
  let readyCallState: CallState | null = null;
  ctx.addShutdownCallback(async () => {
    startup.abort();
  });
  const registering = attachStartupCallCloseout({
    call,
    portal,
    registerShutdownCallback: (closeout) => ctx.addShutdownCallback(closeout),
  });
  attachSipParticipantShutdown(ctx, participant, {
    isTransferred: () =>
      readyCallState ? transferIsAccepted(readyCallState) : false,
    onShutdownRequested: () => startup.abort(),
  });
  console.log(`[call] Incoming: ${callerPhone} → ${trunkPhone} (${callId})`);
  try {
    startup.signal.throwIfAborted();
    const ownedMiddleware = new HttpOwnedMiddleware(
      getMiddlewareConfig(office.key),
    );
    // Handle rejection immediately while registration and voice setup overlap lookup.
    const lookup = lookupByPhone(
      ownedMiddleware,
      callerPhone,
      trunkPhone,
      startup.signal,
    ).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    const callStart = await registering;
    startup.signal.throwIfAborted();
    const stt = new assemblyai.STT({
      ...getAssemblyAISttOptions(),
      apiKey: process.env.ASSEMBLYAI_API_KEY,
    });
    const { primary: primaryLLM, fallback: fallbackLLM } = createLlmPair();
    const llmWithFallback = new FallbackAdapter({
      llms: [primaryLLM, fallbackLLM],
    });
    const ttsRuntime = createTtsRuntime(trunkPhone);
    const optionsByLanguage = ttsRuntime.optionsByLanguage;
    const initialVoiceLanguage = createVoiceLanguageState(
      "en",
      optionsByLanguage.en,
      ttsRuntime.provider,
    );
    console.log(
      `[tts] provider=${ttsRuntime.provider} trunk=${trunkPhone} voice_language=${initialVoiceLanguage.current} tts_language=${initialVoiceLanguage.ttsLanguage} speaker=${initialVoiceLanguage.speaker}`,
    );

    const callState = createInitialCallState({
      callId,
      callerPhone,
      officeKey: office.key,
      roomName,
      sipParticipantIdentity: participant.identity ?? "",
      trunkPhone,
      voiceLanguage: initialVoiceLanguage,
    });
    if (!callState.runtime.voiceLanguage) {
      throw new Error("Initial voice language state is required");
    }
    const voiceLanguageRuntime = new VoiceLanguageRuntime({
      optionsByLanguage,
      state: callState.runtime.voiceLanguage,
      tts: ttsRuntime,
    });
    const session = new AgentSession<CallState>({
      stt,
      llm: llmWithFallback,
      tts: ttsRuntime.tts,
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
    const turnProfileController = createTurnProfileController(stt, {
      startedAt,
      updateEndpointing: (endpointing) =>
        session.updateOptions({
          turnHandling: {
            endpointing: { mode: "fixed", ...endpointing },
          },
        }),
    });
    attachTurnProfileLifecycle(session, turnProfileController);

    await attachCallCloseout({
      call: {
        ...call,
        fallbackModel: fallbackLLM.model,
        initialVoiceLanguage,
        maxCallDurationMs: MAX_CALL_DURATION_MS,
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
      getCallState: () => readyCallState,
      onCloseoutAttached: callStart.handOffToCallCloseout,
      portal,
      startResult: callStart.startResult,
    });

    const phoneLookup = await lookup;
    startup.signal.throwIfAborted();
    if (!phoneLookup.ok) throw phoneLookup.error;
    console.log(formatPhoneLookupLogLine(phoneLookup.value));
    applyPreCallLookup(callState, phoneLookup.value);
    const { agent } = createVoiceAgent(trunkPhone, {
      ownedMiddleware,
      onAssistantText: turnProfileController.observeAssistantText,
      voiceLanguageRuntime,
    });
    startup.signal.throwIfAborted();
    await session.start({
      agent,
      room: ctx.room,
      inputOptions: {
        deleteRoomOnClose: true,
        participantIdentity: participant.identity,
        noiseCancellation: krisp.voiceIsolationTelephony({
          authProvider: krisp.auth.livekitCloud(),
        }),
      },
    });
    startup.signal.throwIfAborted();
    readyCallState = callState;
  } catch (error) {
    startup.abort();
    throw error;
  }
}
