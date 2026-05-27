import type { llm } from "@livekit/agents";
import type { OfficeConfig } from "../customer/profile.js";
import {
  activeWorkflowCommandForState,
  DEFAULT_PATIENT_REF,
  type CallFlowState,
  type WorkflowToolName,
} from "../flow/index.js";
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
  const broadTools = broadToolNamesForOffice(office, false);
  if (preCallCallerAlreadyConfirmed(state.flow)) {
    return broadTools.filter((name) => name !== "verify_patient");
  }
  return broadTools;
}

function exposureReasonForState(state: CallState): string {
  if (pendingTurnUnderstanding(state)) return "turn_update_pending_broad";
  const reasonPrefix = preCallCallerAlreadyConfirmed(state.flow)
    ? "precall_confirmed_no_verify:"
    : "";
  const command = activeWorkflowCommandForState(state.flow);
  if (command) {
    return `${reasonPrefix}planner_guidance_broad:${command.taskKind}:${command.phase}`;
  }
  return `${reasonPrefix}flow_step_broad:${state.flow.step}`;
}

function preCallCallerAlreadyConfirmed(flow: CallFlowState): boolean {
  const preCall = flow.preCall;
  if (
    preCall?.status !== "single_match_confirmed" &&
    preCall?.status !== "multiple_match_confirmed"
  ) {
    return false;
  }
  const selectedRef = preCall.selectedCandidateRef ?? DEFAULT_PATIENT_REF;
  const patient = flow.patients[selectedRef];
  return patient?.status === "verified" && Boolean(patient.patientId);
}

function broadToolNamesForOffice(
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
