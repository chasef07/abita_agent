import type { llm } from "@livekit/agents";
import type { OfficeConfig } from "../customer/profile.js";
import type { CallFlowState } from "../flow/index.js";
import type { CallState } from "./call-state.js";

export type AgentToolName =
  | "record_turn_understanding"
  | "verify_patient"
  | "add_patient"
  | "update_insurance"
  | "get_availability"
  | "confirm_appt"
  | "cancel_appt"
  | "add_patient_note"
  | "book_appt"
  | "check_insurance"
  | "lookup_knowledge"
  | "route_to_spring_hill"
  | "transfer_call";

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
  "confirm_appt",
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

  if (pendingTurnUnderstanding(state)) {
    return dedupe([
      "record_turn_understanding",
      ...visibleToolNamesForStep(state, office),
    ]);
  }

  const base = visibleToolNamesForStep(state, office);
  return dedupe(base);
}

function visibleToolNamesForStep(
  state: CallState,
  office: OfficeConfig,
): AgentToolName[] {
  if (needsAppointmentLookup(state)) {
    return ["confirm_appt", "lookup_knowledge"];
  }

  switch (state.flow.step) {
    case "understand_intent":
    case "triage_visit_type":
      return ["lookup_knowledge"];
    case "answer":
      return ["lookup_knowledge"];
    case "check_insurance":
      return ["check_insurance", "lookup_knowledge"];
    case "route_office":
      return office.features.routeToSpringHill
        ? ["route_to_spring_hill", "lookup_knowledge"]
        : ["lookup_knowledge"];
    case "verify_patient":
      return canLookupAppointments(state)
        ? ["verify_patient", "confirm_appt", "lookup_knowledge"]
        : ["verify_patient", "lookup_knowledge"];
    case "collect_registration":
      return ["add_patient", "check_insurance", "lookup_knowledge"];
    case "collect_visit_reason":
      return ["lookup_knowledge"];
    case "get_availability":
      return shouldExposeInsuranceUpdate(state)
        ? ["update_insurance", "get_availability", "lookup_knowledge"]
        : ["get_availability", "lookup_knowledge"];
    case "confirm_booking":
    case "book":
      return hasCurrentAvailability(state)
        ? ["book_appt", "get_availability", "lookup_knowledge"]
        : ["get_availability", "lookup_knowledge"];
    case "confirm_cancel":
    case "cancel":
      if (!canLookupAppointments(state)) {
        return ["verify_patient", "lookup_knowledge"];
      }
      return ["cancel_appt", "confirm_appt", "lookup_knowledge"];
    case "handoff":
      return ["transfer_call", "lookup_knowledge"];
  }
}

function exposureReasonForState(state: CallState): string {
  if (!state.flowHarnessEnabled) return "legacy_harness_disabled";
  if (pendingTurnUnderstanding(state)) return "turn_update_pending";
  return `flow_step:${state.flow.step}`;
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
    "confirm_appt",
    "cancel_appt",
    "add_patient_note",
    "book_appt",
    "check_insurance",
    "lookup_knowledge",
    ...(office.features.routeToSpringHill
      ? (["route_to_spring_hill"] as const)
      : []),
    "transfer_call",
  ]);
}

function hasCurrentAvailability(state: CallState): boolean {
  return state.lastAvailabilitySlots.length > 0;
}

function needsAppointmentLookup(state: CallState): boolean {
  return (
    canLookupAppointments(state) &&
    (state.flow.activeIntent === "existing_appointment_confirm" ||
      state.flow.activeIntent === "existing_appointment_reschedule")
  );
}

function canLookupAppointments(state: CallState): boolean {
  return (
    state.flow.patientStatus === "verified" ||
    state.flow.patientStatus === "created"
  );
}

function shouldExposeInsuranceUpdate(state: CallState): boolean {
  return (
    Boolean(state.patientId) &&
    state.flow.activeFlow === "insurance" &&
    state.checkedInsuranceCoverageType === "medical" &&
    Boolean(state.checkedInsurancePlan)
  );
}

function dedupe(names: readonly AgentToolName[]): AgentToolName[] {
  return [...new Set(names)];
}
