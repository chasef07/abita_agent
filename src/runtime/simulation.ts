import {
  AgentSession,
  FallbackAdapter,
  SimulationMode,
  isFunctionTool,
  type JobContext,
  type ToolContextEntry,
} from "@livekit/agents";
import { z } from "zod";
import { createVoiceAgent } from "../agent.js";
import { HttpOwnedMiddleware } from "../clients/owned-middleware.js";
import { getOfficeProfiles } from "../customers/abita/profile.js";
import { createLlmPair } from "../model-config.js";
import {
  createCanonicalCallState,
  type CallState,
} from "../state/call-state.js";
import { voiceMaxToolSteps } from "../session-options.js";
import { getMiddlewareConfig } from "./middleware-routing.js";

export const simulationData = z.object({ office: z.string().min(1) });

export const simulationFetch: typeof fetch = (input, init) =>
  fetch(input, { ...init, redirect: "error" });

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
// EMR tools use dev middleware unchanged; these two tools reach other systems.
export function simulationTools(
  tools: readonly ToolContextEntry<CallState>[],
): ToolContextEntry<CallState>[] {
  return tools.filter(
    (entry) =>
      !isFunctionTool(entry) ||
      !["transfer_call", "create_staff_task"].includes(entry.name),
  );
}

export async function startSimulation(ctx: JobContext): Promise<void> {
  const sim = ctx.simulationContext();
  if (!sim || sim.simulationMode !== SimulationMode.TEXT)
    throw Error("Only text simulations are supported");
  const data = simulationData.parse(sim.userdata());
  const { office, config } = simulationMiddlewareConfig(data.office);
  const trunkPhone = office.trunkPhones[0]!;
  const middleware = new HttpOwnedMiddleware({
    ...config,
    fetch: simulationFetch,
  });
  const state = createCanonicalCallState({
    officeKey: office.key,
    trunkPhone,
    sipRoomName: ctx.room.name ?? "",
    sipParticipantIdentity: "simulation-caller",
    callId: sim.simulationJobId,
    callerPhone: "+12025550147",
    preCallLookup: { status: "not_attempted" },
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
  await agent.updateTools(simulationTools(agent.toolCtx.tools));
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
