import { voice } from "@livekit/agents";
import {
  getOfficeConfig,
  getOfficeConfigByPhone,
} from "../customer/profile.js";
import {
  add_patient,
  add_patient_note,
  book_appt,
  cancel_appt,
  check_insurance,
  confirm_appt,
  get_availability,
  lookup_knowledge,
  record_turn_understanding,
  route_to_spring_hill,
  transfer_call,
  update_insurance,
  verify_patient,
} from "../tools.js";
import type { CallState } from "./call-state.js";
import {
  buildToolExposureDecision,
  type AgentToolMap,
  type AgentToolName,
  type ToolExposureDecision,
} from "./tool-exposure.js";

const ALL_TOOLS: AgentToolMap = {
  record_turn_understanding,
  verify_patient,
  add_patient,
  update_insurance,
  get_availability,
  confirm_appt,
  cancel_appt,
  add_patient_note,
  book_appt,
  check_insurance,
  lookup_knowledge,
  route_to_spring_hill,
  transfer_call,
} as AgentToolMap;

export type AgentTools = Partial<AgentToolMap>;

export function buildToolsForTrunk(trunkPhone?: string): AgentTools {
  const office = getOfficeConfigByPhone(trunkPhone ?? "");
  return toolsFromNames([
    "verify_patient",
    "add_patient",
    "update_insurance",
    "get_availability",
    "confirm_appt",
    "cancel_appt",
    "add_patient_note",
    "book_appt",
    "check_insurance",
    "lookup_knowledge",
    ...(office.features.routeToSpringHill
      ? (["route_to_spring_hill"] as AgentToolName[])
      : []),
    "transfer_call",
  ]);
}

export function buildToolsForState(state: CallState): ToolExposureDecision {
  return buildToolExposureDecision({
    state,
    office: getOfficeConfig(state.officeKey),
    allTools: ALL_TOOLS,
  });
}

export async function applyDynamicToolsToAgent(
  agent: voice.Agent<CallState>,
  state: CallState,
  reason: string,
): Promise<void> {
  if (!state.dynamicToolsEnabled) return;
  const decision = buildToolsForState(state);
  await agent.updateTools(decision.tools);
  recordToolExposure(state, decision, reason);
}

export async function refreshAgentToolsForSession(
  session: voice.AgentSession<CallState>,
  reason: string,
): Promise<void> {
  const state = session.userData;
  if (!state.dynamicToolsEnabled) return;

  try {
    const decision = buildToolsForState(state);
    await session.currentAgent.updateTools(decision.tools);
    recordToolExposure(state, decision, reason);
  } catch (error) {
    console.warn(
      `[flow-tools] fallback reason="tool_exposure_error" message=${JSON.stringify(
        error instanceof Error ? error.message : String(error),
      )}`,
    );
    await session.currentAgent.updateTools(
      buildToolsForTrunk(state.trunkPhone),
    );
  }
}

function recordToolExposure(
  state: CallState,
  decision: ToolExposureDecision,
  reason: string,
): void {
  state.latestToolExposure = {
    visibleToolNames: decision.visibleToolNames,
    reason: decision.reason,
    refreshReason: reason,
    step: decision.step,
    activeIntent: decision.activeIntent,
  };
  console.log(
    `[flow-tools] visible=${JSON.stringify(
      decision.visibleToolNames,
    )} reason=${JSON.stringify(decision.reason)} refresh=${JSON.stringify(
      reason,
    )}`,
  );
}

function toolsFromNames(names: AgentToolName[]): AgentTools {
  return Object.fromEntries(names.map((name) => [name, ALL_TOOLS[name]]));
}
