// main.ts — LiveKit agent entry point
// Bootstraps the voice pipeline and connects to LiveKit Cloud.

import {
  type JobContext,
  type JobProcess,
  ServerOptions,
  cli,
  defineAgent,
  inference,
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
import { ScribeSTT } from "./scribe-stt.js";
import { setOffice } from "./tools.js";

dotenv.config({ path: ".env.local" });

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },

  entry: async (ctx: JobContext) => {
    try {
    const vad = ctx.proc.userData.vad as silero.VAD;

    const llm = new baseten.LLM({
      model: "deepseek-ai/DeepSeek-V3.1",
    });

    const session = new voice.AgentSession({
      stt: new ScribeSTT({ language: "en" }),
      llm,
      tts: new elevenlabs.TTS({
        model: "eleven_flash_v2_5",
        voiceId: "7EzWGsX10sAS4c9m9cPf",
      }),
      vad,
      preemptiveGeneration: true,
      turnHandling: {
        turnDetection: new livekit.turnDetector.MultilingualModel(),
        interruption: {
          mode: "adaptive",
          minDuration: 0.1,
          minWords: 1,
        },
        endpointing: {
          minDelay: 0.2,
          maxDelay: 1.0,
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

    // Resolve office from the dialed phone number — middleware maps it to office config
    setOffice(trunkPhone);

    const agent = new Agent();

    await session.start({
      agent,
      room: ctx.room,
      inputOptions: {
        noiseCancellation: TelephonyBackgroundVoiceCancellation(),
      },
    });

    await session.say("thank you for calling Abita Eye Group, this is David, how can I help you?");

    // --- Metrics logging + automatic context compaction ---
    const COMPACT_THRESHOLD = 140_000; // 70% of 200k context window
    let compacting = false;

    session.on(voice.AgentSessionEventTypes.MetricsCollected, async (ev: any) => {
      const m = ev.metrics;
      if (m.type === "llm_metrics") {
        console.log(
          `[llm] ${m.promptTokens} in / ${m.completionTokens} out` +
          ` / cached: ${m.promptCachedTokens}` +
          ` / TTFT: ${m.ttftMs}ms` +
          ` / ${m.tokensPerSecond.toFixed(0)} tok/s`
        );

        if (m.promptTokens > COMPACT_THRESHOLD && !compacting) {
          compacting = true;
          console.log(`[context] Compacting: ${m.promptTokens} prompt tokens`);
          try {
            const compacted = await agent.chatCtx._summarize(
              llm,
              { keepLastTurns: 3 },
            );
            await agent.updateChatCtx(compacted);
            console.log(`[context] Compacted to ${compacted.items.length} items`);
          } catch (err) {
            console.error("[context] Compaction failed:", err);
          }
          compacting = false;
        }
      }

      if (m.type === "tts_metrics") {
        console.log(`[tts] TTFB: ${m.ttfbMs}ms / ${m.charactersCount} chars`);
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
