import type { llm } from "@livekit/agents";
import type { OfficeConfig } from "../customer/profile.js";
import type { CallFlowState, WorkflowToolName } from "../flow/index.js";
import { activeWorkflowCommandForState } from "../flow/index.js";
import type { CallState } from "./call-state.js";

export type ModelFacingWorkflowToolName = WorkflowToolName;

export type AgentToolName =
  | "record_turn_understanding"
  | ModelFacingWorkflowToolName;

export type AgentToolMap = Record<
  AgentToolName,
  // Tool definitions carry different schemas and result types; the registry
  // only needs the common executable tool shape.
  llm.FunctionTool<any, any, any>
>;

export interface ToolExposureInput {
  state: CallState;
  office: OfficeConfig;
  allTools: AgentToolMap;
}

export interface ToolExposureDecision {
  tools: llm.ToolContext;
  visibleToolNames: AgentToolName[];
  hiddenToolNames: AgentToolName[];
  reason: string;
  step: CallFlowState["step"];
  activeIntent: CallFlowState["activeIntent"];
}

const ALL_TOOL_NAMES: AgentToolName[] = [
  "record_turn_understanding",
  "verify_patient",
  "add_patient",
  "update_insurance",
  "get_availability",
  "cancel_appt",
  "add_patient_note",
  "book_appt",
  "check_insurance",
  "lookup_knowledge",
  "route_to_spring_hill",
  "transfer_call",
];

export function buildToolExposureDecision({
  state,
  office,
  allTools,
}: ToolExposureInput): ToolExposureDecision {
  const visibleToolNames = visibleToolNamesForState(state, office);
  const tools = Object.fromEntries(
    visibleToolNames.map((name) => [name, allTools[name]]),
  ) as llm.ToolContext;
  const visible = new Set(visibleToolNames);

  return {
    tools,
    visibleToolNames,
    hiddenToolNames: ALL_TOOL_NAMES.filter((name) => !visible.has(name)),
    reason: exposureReasonForState(state),
    step: state.flow.step,
    activeIntent: state.flow.activeIntent,
  };
}

export function pendingTurnUnderstanding(state: CallState): boolean {
  if (!state.flowHarnessEnabled) return false;
  const transcript = state.latestUserTranscript?.trim();
  if (!transcript) return false;
  return state.turnUnderstandingAppliedForTranscript !== transcript;
}

function visibleToolNamesForState(
  state: CallState,
  office: OfficeConfig,
): AgentToolName[] {
  if (!state.flowHarnessEnabled) {
    return legacyToolNamesForOffice(office, false);
  }

  const broadTools = legacyToolNamesForOffice(office, false);
  return broadTools;
}

function exposureReasonForState(state: CallState): string {
  if (!state.flowHarnessEnabled) return "legacy_harness_disabled";
  if (pendingTurnUnderstanding(state)) return "turn_update_pending_broad";
  const command = activeWorkflowCommandForState(state.flow);
  if (command) {
    return `planner_guidance_broad:${command.taskKind}:${command.phase}`;
  }
  return `flow_step_broad:${state.flow.step}`;
}

function legacyToolNamesForOffice(
  office: OfficeConfig,
  includeTurnUnderstanding: boolean,
): AgentToolName[] {
  return dedupe([
    ...(includeTurnUnderstanding
      ? (["record_turn_understanding"] as const)
      : []),
    "verify_patient",
    "add_patient",
    "update_insurance",
    "get_availability",
    "cancel_appt",
    "book_appt",
    "check_insurance",
    "lookup_knowledge",
    ...(office.features.routeToSpringHill
      ? (["route_to_spring_hill"] as const)
      : []),
    "transfer_call",
  ]);
}

function dedupe(names: readonly AgentToolName[]): AgentToolName[] {
  return [...new Set(names)];
}
