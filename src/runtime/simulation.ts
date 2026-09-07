import {
  AgentSession,
  FallbackAdapter,
  SimulationMode,
  isFunctionTool,
  isToolset,
  type JobContext,
  type SimulationContext,
  type ToolContextEntry,
} from "@livekit/agents";
import { z } from "zod";
import { createVoiceAgent } from "../agent.js";
import {
  HttpOwnedMiddleware,
  type OwnedMiddleware,
} from "../clients/owned-middleware.js";
import { getOfficeProfiles } from "../customers/abita/profile.js";
import { createLlmPair } from "../model-config.js";
import {
  createCanonicalCallState,
  type CallState,
} from "../state/call-state.js";
import { voiceMaxToolSteps } from "../session-options.js";
import { getMiddlewareConfig } from "./middleware-routing.js";

// Simulation-only startup, read-only guards, and result verification.
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
