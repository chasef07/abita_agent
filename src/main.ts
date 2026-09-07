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
  SimulationMode,
  isFunctionTool,
  isToolset,
  type SimulationContext,
  type ToolContextEntry,
} from "@livekit/agents";
import * as krisp from "@livekit/agents-plugin-krisp";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createVoiceAgent } from "./agent.js";
import {
  createCanonicalCallState,
  type CallState,
} from "./state/call-state.js";
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
  getOfficeProfiles,
  getProductOfficeKeyByPhone,
} from "./customers/abita/profile.js";
import { coordinateSessionStartup } from "./runtime/session-startup.js";
import {
  HttpOwnedMiddleware,
  type OwnedMiddleware,
} from "./clients/owned-middleware.js";
import { getMiddlewareConfig } from "./runtime/middleware-routing.js";
import { setupGoogleCloudTracing } from "./runtime/google-cloud-tracing.js";

// Simulation-only setup. The real-call path below remains unchanged.
export const simulationData = z
  .object({
    office: z.string().min(1),
    patient: z
      .object({
        firstName: z.string().trim().min(1),
        lastName: z.string().trim().min(1),
        dob: z.string().regex(/^\d{2}\/\d{2}\/\d{4}$/),
      })
      .strict(),
  })
  .strict();
type Patient = z.infer<typeof simulationData>["patient"];
export type SimulationEvidence = {
  verified: boolean;
  availabilityReads: number;
  slotCount: number;
  blocked: string[];
  readFailures: number;
};
const jobs = new Map<JobContext, SimulationEvidence>();
export const simulationFetch: typeof fetch = (input, init) =>
  fetch(input, { ...init, redirect: "error" });
export const newSimulationEvidence = (): SimulationEvidence => ({
  verified: false,
  availabilityReads: 0,
  slotCount: 0,
  blocked: [],
  readFailures: 0,
});

export function simulationMiddlewareConfig(
  officeKey: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const office = getOfficeProfiles().find(
    (profile) => profile.key === officeKey,
  );
  if (!office) throw Error("Unknown simulation office");
  const config = getMiddlewareConfig(office.key, {
    ...env,
    LIVEKIT_AGENT_DEPLOYMENT: "simulation",
  });
  // A deployment label alone is not proof of backend isolation.
  if (
    !/^https:\/\/abita-middleware-sandbox-[a-z0-9.-]+\.run\.app\/?$/.test(
      config.middlewareBaseUrl,
    )
  )
    throw Error("Simulations require the dev middleware service");
  return { office, config };
}
export function readOnlySimulationMiddleware(
  client: OwnedMiddleware,
  patient: Patient,
  evidence: SimulationEvidence,
): OwnedMiddleware {
  let verifiedId: string | undefined;
  let routing: string | null = null;
  const block = (action: string): never => {
    evidence.blocked.push(action);
    throw Error("Read-only simulation blocked an out-of-scope operation");
  };
  const name = (s: string) => s.trim().toLowerCase();
  const normalizeDob = (s: string) =>
    s.replace(/^(\d{4})-(\d{2})-(\d{2})$/, "$2/$3/$1");
  return {
    resolvePatient: async (request) => {
      const identity = request.identity;
      const exactName =
        "firstName" in identity &&
        name(identity.firstName) === name(patient.firstName) &&
        name(identity.lastName) === name(patient.lastName) &&
        normalizeDob(identity.dob) === patient.dob;
      const exactId =
        "patientId" in identity &&
        verifiedId !== undefined &&
        identity.patientId === verifiedId;
      if (!exactName && !exactId) return block("patient_lookup");
      const result = await client.resolvePatient(request);
      if (result.status === "verified") {
        if (verifiedId && verifiedId !== result.patientId)
          return block("patient_changed");
        verifiedId = result.patientId;
        routing = result.routing;
        evidence.verified = true;
      } else evidence.readFailures++;
      return result;
    },
    getAvailability: async (request) => {
      if (
        !verifiedId ||
        normalizeDob(request.dob ?? "") !== patient.dob ||
        request.routing !== routing ||
        request.rangeDays !== 14
      )
        return block("availability_scope");
      if (++evidence.availabilityReads > 3)
        return block("availability_read_limit");
      const result = await client.getAvailability(request);
      if (result.status === "found") evidence.slotCount += result.slots.length;
      else evidence.readFailures++;
      return result;
    },
    createPatient: async () => block("create_patient"),
    updateInsurance: async () => block("update_insurance"),
    bookAppointment: async () => block("book_appointment"),
    cancelAppointment: async () => block("cancel_appointment"),
  };
}
export function simulationTools(
  tools: readonly ToolContextEntry<CallState>[],
  evidence: SimulationEvidence,
): ToolContextEntry<CallState>[] {
  const reads = new Set([
    "resolve_patient",
    "list_available_appointments",
    "check_insurance",
    "triage_eye_care",
  ]);
  return tools.map((entry) => {
    if (
      isToolset(entry) &&
      entry.id === "end_call" &&
      entry.tools.length === 1 &&
      entry.tools.every((t) => isFunctionTool(t) && t.name === "end_call")
    )
      return entry;
    if (!isFunctionTool(entry)) throw Error("Unsupported simulation toolset");
    if (reads.has(entry.name)) return entry;
    return {
      ...entry,
      execute: async () => {
        evidence.blocked.push(entry.name);
        return "This is an availability-only test. No records were changed and no message or transfer was sent.";
      },
    };
  });
}
export function simulationFailure(
  evidence: SimulationEvidence | undefined,
): string | null {
  if (!evidence) return "invalid-run: missing simulation evidence";
  if (evidence.blocked.length) return "A prohibited action was attempted";
  if (evidence.readFailures) return "invalid-run: backend read failed";
  if (!evidence.verified || !evidence.slotCount)
    return "Patient verification and inventory-backed availability are required";
  return null;
}
export async function startSimulation(ctx: JobContext): Promise<void> {
  const sim = ctx.simulationContext();
  if (!sim || sim.simulationMode !== SimulationMode.TEXT)
    throw Error("Only text simulations are supported");
  const data = simulationData.parse(sim.userdata());
  const { office, config } = simulationMiddlewareConfig(data.office);
  const trunkPhone = office.trunkPhones[0]!;
  const evidence = newSimulationEvidence();
  jobs.set(ctx, evidence);
  const middleware = readOnlySimulationMiddleware(
    new HttpOwnedMiddleware({ ...config, fetch: simulationFetch }),
    data.patient,
    evidence,
  );
  const state = createCanonicalCallState({
    officeKey: office.key,
    amdOfficePhone: office.amdOfficePhone,
    trunkPhone,
    sipRoomName: ctx.room.name ?? "",
    sipParticipantIdentity: "simulation-caller",
    callId: sim.simulationJobId,
    callerPhone: "+12025550147",
    preCallLookup: { status: "not_attempted", durationMs: null },
    insuranceCarrier: null,
    checkedInsurancePlan: null,
    checkedInsuranceCoverageType: null,
    routing: null,
    allowedProviders: [],
    routingAmbiguous: false,
    preauthRequired: false,
  });
  const { primary, fallback } = createLlmPair();
  const session = new AgentSession<CallState>({
    llm: new FallbackAdapter({ llms: [primary, fallback] }),
    userData: state,
    maxToolSteps: voiceMaxToolSteps,
    turnHandling: { turnDetection: "manual" },
  });
  const { agent } = createVoiceAgent(trunkPhone, {
    ownedMiddleware: middleware,
  });
  await agent.updateTools(simulationTools(agent.toolCtx.tools, evidence));
  const timer = setTimeout(
    () => session.shutdown({ drain: false, reason: "simulation_timeout" }),
    240000,
  );
  ctx.addShutdownCallback(async () => {
    clearTimeout(timer);
  });
  await ctx.connect();
  console.log(
    JSON.stringify({
      event: "simulation_target",
      office: office.key,
      backend: "dev",
      readOnly: true,
      jobId: sim.simulationJobId,
    }),
  );
  await session.start({
    agent,
    room: ctx.room,
    inputOptions: { audioEnabled: false, deleteRoomOnClose: true },
    outputOptions: { audioEnabled: false },
  });
}
export function gradeSimulation(sim: SimulationContext): void {
  const evidence = jobs.get(sim.jobContext);
  const failure = simulationFailure(evidence);
  if (failure) sim.fail(failure);
  console.log(
    JSON.stringify({
      event: "simulation_verification",
      jobId: sim.simulationJobId,
      simulatorPassed: sim.simulatorVerdict.success,
      failure,
      evidence,
    }),
  );
  jobs.delete(sim.jobContext);
}

validateRuntimeConfig();

export default defineAgent({
  entry: async (ctx: JobContext) => {
    try {
      if (ctx.simulationContext()) return await startSimulation(ctx);
      setupGoogleCloudTracing(ctx);
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
      const ownedMiddleware = new HttpOwnedMiddleware(
        getMiddlewareConfig(office.key),
      );
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
              noiseCancellation: krisp.voiceIsolationTelephony({
                authProvider: krisp.auth.livekitCloud(),
              }),
            },
          });
        },
      });
    } catch (err) {
      console.error("[entry] FATAL:", err);
      throw err;
    }
  },
  onSimulationEnd: gradeSimulation,
});

cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: "abita-agent",
    shutdownProcessTimeout: 60_000, // 60s to allow analytics POST to complete
  }),
);
