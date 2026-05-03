// main.ts — LiveKit agent entry point
// Bootstraps the voice pipeline and connects to LiveKit Cloud.

import {
  type JobContext,
  type JobProcess,
  ServerOptions,
  cli,
  defineAgent,
  llm,
  voice,
} from "@livekit/agents";
import * as assemblyai from "@livekit/agents-plugin-assemblyai";
import * as silero from "@livekit/agents-plugin-silero";
import * as elevenlabs from "@livekit/agents-plugin-elevenlabs";
import * as baseten from "@livekit/agents-plugin-baseten";
import dotenv from "dotenv";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Agent } from "./agent.js";
import { RoomServiceClient } from "livekit-server-sdk";
import { type CallState, lookupByPhone } from "./tools.js";
import { getOfficeConfigByPhone } from "./offices.js";
import { fallbackLLMOptions, primaryLLMOptions } from "./model-config.js";
import {
  type AssemblyAISttProfile,
  getAssemblyAISttOptions,
  getAssemblyAISttProfileOptions,
  selectAssemblyAISttProfileForAssistantText,
} from "./stt-config.js";

dotenv.config({ path: ".env.local" });

type TurnMetricSnapshot = {
  itemId: string;
  role: string;
  type: string;
  createdAt: number;
  interrupted: boolean;
  metrics: Record<string, unknown>;
};

type PluginMetricSnapshot = Record<string, unknown>;

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
      const session = new voice.AgentSession<CallState>({
        stt,
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
        // preemptiveGeneration: false,
        turnHandling: {
          turnDetection: "stt",
          interruption: {
            mode: "adaptive",
            minDuration: 1000,
            minWords: 3,
            discardAudioIfUninterruptible: true,
            falseInterruptionTimeout: 2500,
            resumeFalseInterruption: true,
          },
          endpointing: {
            minDelay: 0,
          },
        },
      });

      // Connect and wait for the SIP participant
      await ctx.connect();
      const participant = await ctx.waitForParticipant();

      const callerPhone =
        participant.attributes["sip.phoneNumber"] ?? participant.identity;
      const trunkPhone = participant.attributes["sip.trunkPhoneNumber"] ?? "";
      const callId = participant.attributes["sip.callID"] ?? ctx.room.name;

      console.log(
        `[call] Incoming: ${callerPhone} → ${trunkPhone} (${callId})`,
      );

      // Phone lookup before session start so context is ready for the first LLM turn
      const office = getOfficeConfigByPhone(trunkPhone);
      const phoneLookup = await lookupByPhone(callerPhone, trunkPhone);
      if (phoneLookup?.status === "verified") {
        console.log(
          `[call] Caller match: ${phoneLookup.name} (ID: ${phoneLookup.patientId})`,
        );
      } else if (phoneLookup?.status === "multiple_matches") {
        console.log(
          `[call] Multiple matches for ${callerPhone}: ${phoneLookup.matches.map((m) => m.firstName).join(", ")}`,
        );
      } else {
        console.log(`[call] No patient match for ${callerPhone}`);
      }

      const agent = new Agent(phoneLookup, trunkPhone);

      const verified = phoneLookup?.status === "verified" ? phoneLookup : null;
      session.userData = {
        officeKey: office.key,
        amdOfficePhone: office.amdOfficePhone,
        sipRoomName: ctx.room.name ?? "",
        sipParticipantIdentity: participant.identity ?? "",
        callerPhone,
        patientId: verified?.patientId ?? null,
        patientName: verified?.name ?? null,
        dob: verified?.dob ?? null,
        insuranceCarrier: verified?.insuranceCarrier ?? null,
        insPlanId: verified?.insPlanId ?? null,
        respPartyId: verified?.respPartyId ?? null,
        checkedInsurancePlan: verified?.insuranceCarrier ?? null,
        routing: verified?.routing ?? null,
        allowedProviders: verified?.allowedProviders ?? [],
        routingAmbiguous: verified?.routingAmbiguous ?? false,
        preauthRequired: false,
        appointments: verified?.appointments ?? [],
        transferred: false,
      };

      const startedAt = new Date();
      const turnMetrics: TurnMetricSnapshot[] = [];
      let latestUsage: Record<string, unknown> | undefined;

      let activeSttProfile: AssemblyAISttProfile = "default";
      const applySttProfile = (
        profile: AssemblyAISttProfile,
        reason: string,
      ) => {
        if (profile === activeSttProfile) return;

        stt.updateOptions(getAssemblyAISttProfileOptions(profile));
        activeSttProfile = profile;
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

        const profile = selectAssemblyAISttProfileForAssistantText(
          ev.item.textContent ?? "",
        );
        applySttProfile(profile, "assistant_prompt");
      });

      session.on(voice.AgentSessionEventTypes.SessionUsageUpdated, (ev) => {
        latestUsage = ev.usage as unknown as Record<string, unknown>;
      });

      session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
        if (ev.isFinal) {
          applySttProfile("default", "user_final");
        }
      });

      await session.start({
        agent,
        room: ctx.room,
      });

      // End the job when the SIP caller hangs up (or transfer completes).
      // LiveKit's documented Node pattern is ctx.shutdown(), which closes the
      // session, disconnects the agent, and runs shutdown hooks.
      ctx.room.on("participantDisconnected", (p) => {
        if (p.identity === participant.identity) {
          console.log(
            `[call] SIP participant ${p.identity} disconnected (transferred=${session.userData.transferred}), shutting down job`,
          );
          ctx.shutdown(`sip participant disconnected: ${p.identity}`);
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
        const analyticsUrl = process.env.ANALYTICS_URL;
        if (analyticsUrl) {
          const endedAt = new Date();
          const payload: Record<string, unknown> = {
            callId,
            callerPhone,
            officePhone: trunkPhone,
            startedAt: startedAt.toISOString(),
            endedAt: endedAt.toISOString(),
            durationSec: Math.round(
              (endedAt.getTime() - startedAt.getTime()) / 1000,
            ),
            usage: latestUsage ?? session.usage,
            llmMetrics,
            turnMetrics,
            sessionReport,
          };

          // Include audio only if under 4MB base64 to avoid payload limits
          if (audioBase64 && audioBase64.length < 4 * 1024 * 1024) {
            payload.audioBase64 = audioBase64;
          } else if (audioBase64) {
            console.warn(
              `[shutdown] Audio too large for analytics POST (${(audioBase64.length / 1024 / 1024).toFixed(1)}MB), sending without audio`,
            );
          }

          const headers: Record<string, string> = {
            "Content-Type": "application/json",
          };
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
                console.log(
                  `[shutdown] Analytics POST succeeded (attempt ${attempt})`,
                );
                break;
              }
              const body = await res.text().catch(() => "");
              console.warn(
                `[shutdown] Analytics POST returned ${res.status} (attempt ${attempt}): ${body.slice(0, 200)}`,
              );
            } catch (err) {
              console.warn(
                `[shutdown] Analytics POST failed (attempt ${attempt}):`,
                err,
              );
            }
            if (attempt < maxAttempts)
              await new Promise((r) => setTimeout(r, 2_000 * attempt));
          }
        }

        try {
          if (ctx.room.name) await getRoomSvc().deleteRoom(ctx.room.name);
        } catch (err) {
          console.error("[shutdown] Failed to delete room:", err);
        }
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
