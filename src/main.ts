// main.ts — LiveKit agent entry point
// Bootstraps the voice pipeline and connects to LiveKit Cloud.

import {
  type JobContext,
  type JobProcess,
  metrics as metricsLib,
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
import * as deepgram from "@livekit/agents-plugin-deepgram";
import dotenv from "dotenv";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Agent } from "./agent.js";
import { RoomServiceClient } from "livekit-server-sdk";
import { type CallState, lookupByPhone } from "./tools.js";

dotenv.config({ path: ".env.local" });

let _roomSvc: RoomServiceClient | undefined;
function getRoomSvc(): RoomServiceClient {
  _roomSvc ??= new RoomServiceClient(
    process.env.LIVEKIT_URL!,
    process.env.LIVEKIT_API_KEY!,
    process.env.LIVEKIT_API_SECRET!,
  );
  return _roomSvc;
}

export default defineAgent({
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load({ activationThreshold: 0.3 });
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
          minDuration: 700,
          minWords: 3,
          discardAudioIfUninterruptible: true,
          falseInterruptionTimeout: 2000,
          resumeFalseInterruption: true,
        },
        endpointing: {
          minDelay: 1000,
          maxDelay: 2000,
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
    });

    // Collect raw LiveKit metrics as single source of truth for analytics
    const startedAt = new Date();
    const rawMetrics: Record<string, unknown>[] = [];
    session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev: any) => {
      metricsLib.logMetrics(ev.metrics);
      rawMetrics.push({ ...ev.metrics });
    });

    // Close the session when the SIP caller hangs up (or transfer completes).
    // This must fire for ALL disconnects — including transfers — because the
    // framework's built-in closeOnDisconnect doesn't fully tear down the STT
    // WebSocket, leaving zombie sessions that accumulate as "concurrent."
    ctx.room.on("participantDisconnected", async (p) => {
      if (p.identity === participant.identity) {
        console.log(`[call] SIP participant ${p.identity} disconnected (transferred=${session.userData.transferred}), closing session`);
        await session.close();
      }
    });

    // Shutdown hook: capture session report + audio, post analytics, delete room.
    ctx.addShutdownCallback(async () => {
      let sessionReport: Record<string, unknown> | undefined;
      let audioBase64: string | undefined;

      try {
        const report = ctx.makeSessionReport();
        sessionReport = voice.sessionReportToJSON(report);

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

      // Post raw metrics + session report to analytics dashboard
      const analyticsUrl = process.env.ANALYTICS_URL;
      if (analyticsUrl) {
        const endedAt = new Date();
        const payload: Record<string, unknown> = {
          callId,
          callerPhone,
          officePhone: trunkPhone,
          startedAt: startedAt.toISOString(),
          endedAt: endedAt.toISOString(),
          durationSec: Math.round((endedAt.getTime() - startedAt.getTime()) / 1000),
          metrics: rawMetrics,
          sessionReport,
        };

        // Include audio only if under 4MB base64 to avoid payload limits
        if (audioBase64 && audioBase64.length < 4 * 1024 * 1024) {
          payload.audioBase64 = audioBase64;
        } else if (audioBase64) {
          console.warn(`[shutdown] Audio too large for analytics POST (${(audioBase64.length / 1024 / 1024).toFixed(1)}MB), sending without audio`);
        }

        const headers: Record<string, string> = { "Content-Type": "application/json" };
        const secret = process.env.WEBHOOK_SECRET;
        if (secret) headers["Authorization"] = `Bearer ${secret}`;

        const maxAttempts = 4;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          try {
            const res = await fetch(analyticsUrl, {
              method: "POST",
              headers,
              body: JSON.stringify(payload),
              signal: AbortSignal.timeout(10_000),
            });
            if (res.ok) {
              console.log(`[shutdown] Analytics POST succeeded (attempt ${attempt})`);
              break;
            }
            const body = await res.text().catch(() => "");
            console.warn(`[shutdown] Analytics POST returned ${res.status} (attempt ${attempt}): ${body.slice(0, 200)}`);
          } catch (err) {
            console.warn(`[shutdown] Analytics POST failed (attempt ${attempt}):`, err);
          }
          if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, 2_000 * attempt));
        }
      }

      try {
        if (ctx.room.name) await getRoomSvc().deleteRoom(ctx.room.name);
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
    shutdownProcessTimeout: 60_000, // 60s to allow analytics POST to complete
  }),
);
