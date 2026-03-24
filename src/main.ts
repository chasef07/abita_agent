// main.ts — LiveKit agent entry point
// Bootstraps the voice pipeline and connects to LiveKit Cloud.

import {
  type JobContext,
  type JobProcess,
  ServerOptions,
  cli,
  defineAgent,
  inference,
  llm as lkLlm,
  voice,
} from "@livekit/agents";
import * as livekit from "@livekit/agents-plugin-livekit";
import * as silero from "@livekit/agents-plugin-silero";
import * as elevenlabs from "@livekit/agents-plugin-elevenlabs";
import * as baseten from "@livekit/agents-plugin-baseten";
import { TelephonyBackgroundVoiceCancellation } from "@livekit/noise-cancellation-node";
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { Agent } from "./agent.js";
import { CallLogger } from "./call-logger.js";
import { buildCallerContext } from "./prompt.js";
import { ScribeSTT } from "./scribe-stt.js";
import { type CallState, lookupByPhone } from "./tools.js";

dotenv.config({ path: ".env.local" });

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },

  entry: async (ctx: JobContext) => {
    try {
    const vad = ctx.proc.userData.vad as silero.VAD;

    const llm = new baseten.LLM({
      model: "zai-org/GLM-4.7",
    });

    const session = new voice.AgentSession<CallState>({
      stt: new ScribeSTT({ language: "en" }),
      llm,
      tts: new elevenlabs.TTS({
        model: "eleven_flash_v2_5",
        voiceId: "7EzWGsX10sAS4c9m9cPf",
        encoding: "pcm_16000",
        voiceSettings: {
          stability: 0.65,
          similarity_boost: 0.8,
          style: 0,
          speed: 0.88,
          use_speaker_boost: false,
        },
      }),
      vad,
      preemptiveGeneration: true,
      turnHandling: {
        turnDetection: new livekit.turnDetector.MultilingualModel(),
        interruption: {
          mode: "adaptive",
        },
        endpointing: {
          minDelay: 300,
          maxDelay: 1500,
        },
      },
    });

    // Connect to the room and wait for the SIP participant
    await ctx.connect();
    const participant = await ctx.waitForParticipant();

    const callerPhone = participant.attributes["sip.phoneNumber"] ?? participant.identity;
    const trunkPhone = participant.attributes["sip.trunkPhoneNumber"] ?? "";
    const callId = participant.attributes["sip.callID"] ?? ctx.room.name;

    console.log(`[call] Incoming: ${callerPhone} → ${trunkPhone} (${callId})`);

    session.userData = {
      office: trunkPhone,
      sipRoomName: ctx.room.name ?? "",
      sipParticipantIdentity: participant.identity ?? "",
      callerPhone,
      phoneLookup: null,
    };

    // Start session + greeting immediately — lookup runs in parallel
    const lookupPromise = lookupByPhone(callerPhone, trunkPhone);
    const agent = new Agent();

    await session.start({
      agent,
      room: ctx.room,
      inputOptions: {
        noiseCancellation: TelephonyBackgroundVoiceCancellation(),
      },
    });

    // Resolve lookup while greeting plays
    const phoneLookup = await lookupPromise;
    session.userData.phoneLookup = phoneLookup;

    if (phoneLookup?.status === "verified") {
      console.log(`[call] Caller match: ${phoneLookup.name} (ID: ${phoneLookup.patientId})`);
    } else if (phoneLookup?.status === "multiple_matches") {
      console.log(`[call] Multiple matches for ${callerPhone}: ${phoneLookup.matches.map(m => m.firstName).join(", ")}`);
    } else {
      console.log(`[call] No patient match for ${callerPhone}`);
    }

    // Inject caller context into chat context so the LLM sees it on the first turn
    const callerContext = buildCallerContext(phoneLookup);
    const chatCtx = new lkLlm.ChatContext([...agent.chatCtx.items]);
    chatCtx.addMessage({ role: "developer", content: callerContext });
    await agent.updateChatCtx(chatCtx);

    const logger = new CallLogger(session, { callId, callerPhone });

    // --- Automatic context compaction ---
    const COMPACT_THRESHOLD = 140_000;
    let compacting = false;

    session.on(voice.AgentSessionEventTypes.MetricsCollected, async (ev: any) => {
      const m = ev.metrics;
      if (m.type === "llm_metrics" && m.promptTokens > COMPACT_THRESHOLD && !compacting) {
        compacting = true;
        console.log(`[context] Compacting: ${m.promptTokens} prompt tokens`);
        try {
          const compacted = await agent.chatCtx._summarize(llm, { keepLastTurns: 3 });
          await agent.updateChatCtx(compacted);
          console.log(`[context] Compacted to ${compacted.items.length} items`);
          logger.logCompaction(m.promptTokens, compacted.items.length);
        } catch (err) {
          console.error("[context] Compaction failed:", err);
        }
        compacting = false;
      }
    });

    } catch (err) { console.error("[entry] FATAL:", err); throw err; }
  },
});

cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: "abita-agent",
  }),
);
