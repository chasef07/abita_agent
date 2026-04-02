// main.ts — LiveKit agent entry point
// Bootstraps the voice pipeline and connects to LiveKit Cloud.

import {
  type JobContext,
  type JobProcess,
  ServerOptions,
  cli,
  defineAgent,
  inference,
  llm,
  voice,
} from "@livekit/agents";
import * as livekit from "@livekit/agents-plugin-livekit";
import * as silero from "@livekit/agents-plugin-silero";
import * as elevenlabs from "@livekit/agents-plugin-elevenlabs";
import * as baseten from "@livekit/agents-plugin-baseten";
import { TelephonyBackgroundVoiceCancellation } from "@livekit/noise-cancellation-node";
import dotenv from "dotenv";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Agent } from "./agent.js";
import { CallLogger } from "./call-logger.js";
import * as deepgram from "@livekit/agents-plugin-deepgram";
// import { ScribeSTT } from "./scribe-stt.js"; // Kept for rollback
import { RoomServiceClient } from "livekit-server-sdk";
import { type CallState, lookupByPhone } from "./tools.js";

dotenv.config({ path: ".env.local" });

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },

  entry: async (ctx: JobContext) => {
    try {
    const vad = ctx.proc.userData.vad as silero.VAD;

    const primaryLLM = new baseten.LLM({
      model: "zai-org/GLM-4.7",
      parallelToolCalls: false,
      temperature: 0.3,
    });

    const fallbackLLM = new baseten.LLM({
      model: "zai-org/GLM-5",
      parallelToolCalls: false,
      temperature: 0.3,
    });

    const llmWithFallback = new llm.FallbackAdapter({
      llms: [primaryLLM, fallbackLLM],
    });

    const session = new voice.AgentSession<CallState>({
      stt: new deepgram.STT({ model: "nova-3", language: "multi" }),
      llm: llmWithFallback,
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
          minDuration: 500,
          minWords: 2,
          discardAudioIfUninterruptible: true,
          falseInterruptionTimeout: 2000,
          resumeFalseInterruption: true,
        },
        endpointing: {
          minDelay: 1000,
          maxDelay: 3000,
        },
      },
    });

    // Connect and wait for the SIP participant
    await ctx.connect();
    const participant = await ctx.waitForParticipant();

    const callerPhone = participant.attributes["sip.phoneNumber"] ?? participant.identity;
    const trunkPhone = participant.attributes["sip.trunkPhoneNumber"] ?? "";
    const callId = participant.attributes["sip.callID"] ?? ctx.room.name;

    console.log(`[call] Incoming: ${callerPhone} → ${trunkPhone} (${callId})`);

    // Phone lookup before session start so context is ready for the first LLM turn
    const phoneLookup = await lookupByPhone(callerPhone, trunkPhone);
    if (phoneLookup?.status === "verified") {
      console.log(`[call] Caller match: ${phoneLookup.name} (ID: ${phoneLookup.patientId})`);
    } else if (phoneLookup?.status === "multiple_matches") {
      console.log(`[call] Multiple matches for ${callerPhone}: ${phoneLookup.matches.map(m => m.firstName).join(", ")}`);
    } else {
      console.log(`[call] No patient match for ${callerPhone}`);
    }

    const agent = new Agent(phoneLookup, trunkPhone);

    const verified = phoneLookup?.status === "verified" ? phoneLookup : null;
    session.userData = {
      office: trunkPhone,
      sipRoomName: ctx.room.name ?? "",
      sipParticipantIdentity: participant.identity ?? "",
      callerPhone,
      patientId: verified?.patientId ?? null,
      patientName: verified?.name ?? null,
      dob: verified?.dob ?? null,
      insuranceCarrier: verified?.insuranceCarrier ?? null,
      routing: verified?.routing ?? null,
      allowedProviders: verified?.allowedProviders ?? [],
      routingAmbiguous: verified?.routingAmbiguous ?? false,
      preauthRequired: false,
      appointments: verified?.appointments ?? [],
      transferred: false,
    };

    await session.start({
      agent,
      room: ctx.room,
      inputOptions: {
        noiseCancellation: TelephonyBackgroundVoiceCancellation(),
      },
    });

    const logger = new CallLogger(session, { callId, callerPhone, officePhone: trunkPhone });
    session.userData.onToolCall = (record) => logger.recordToolCall(record);

    // Close the session when the SIP caller hangs up (or transfer completes).
    // Without this, rooms can linger indefinitely if the framework doesn't
    // auto-detect the SIP participant leaving.
    ctx.room.on("participantDisconnected", async (p) => {
      if (p.identity === participant.identity) {
        console.log(`[call] SIP participant ${p.identity} disconnected, closing session`);
        await session.close();
      }
    });

    // Shutdown hook: capture session report + audio, flush analytics, delete room.
    ctx.addShutdownCallback(async () => {
      try {
        const report = ctx.makeSessionReport();
        const reportJson = voice.sessionReportToJSON(report);
        logger.setSessionReport(reportJson);

        if (report.audioRecordingPath) {
          try {
            const audioBuffer = await readFile(report.audioRecordingPath);
            logger.setAudioData(audioBuffer);
            console.log(`[shutdown] Audio captured: ${audioBuffer.length} bytes`);
          } catch (audioErr) {
            console.warn("[shutdown] Could not read audio file:", audioErr);
          }
        }
      } catch (reportErr) {
        console.warn("[shutdown] Could not capture session report:", reportErr);
      }

      try {
        await logger.flush();
      } catch (err) {
        console.error("[shutdown] Failed to flush analytics:", err);
      }
      try {
        const roomSvc = new RoomServiceClient(
          process.env.LIVEKIT_URL!,
          process.env.LIVEKIT_API_KEY!,
          process.env.LIVEKIT_API_SECRET!,
        );
        if (ctx.room.name) await roomSvc.deleteRoom(ctx.room.name);
      } catch (err) {
        console.error("[shutdown] Failed to delete room:", err);
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
