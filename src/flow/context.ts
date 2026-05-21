import type { CallFlowState } from "./types.js";

export interface FlowContextDirectives {
  currentObjective: string;
  allowedActions: string[];
  blockedActions: string[];
}

function formatList(values: string[]): string {
  return values.length > 0 ? values.join(", ") : "none";
}

export function directivesForFlowState(
  flow: CallFlowState,
): FlowContextDirectives {
  switch (flow.step) {
    case "triage_visit_type":
      return {
        currentObjective:
          "Find out what the caller needs to be seen for before checking insurance or scheduling.",
        allowedActions: ["ask_visit_reason", "prepareSchedulingPath"],
        blockedActions: [
          "check_insurance",
          "add_patient",
          "get_availability",
          "book_appt",
          "cancel_appt",
        ],
      };
    case "check_insurance":
      return {
        currentObjective:
          "Collect the exact insurance plan and check the right coverage type.",
        allowedActions: [
          "ask_insurance_plan",
          "check_insurance",
          "prepareSchedulingPath",
        ],
        blockedActions: [
          "add_patient",
          "get_availability",
          "book_appt",
          "cancel_appt",
        ],
      };
    case "route_office":
      return {
        currentObjective:
          "Explain the office routing and get agreement before switching the active workflow.",
        allowedActions: [
          "explain_routing",
          "route_to_spring_hill",
          "prepareSchedulingPath",
        ],
        blockedActions: ["transfer_call", "get_availability", "book_appt"],
      };
    case "verify_patient":
      return {
        currentObjective:
          "Verify the patient before using patient or scheduling tools.",
        allowedActions: ["ask_patient_name", "ask_dob", "verify_patient"],
        blockedActions: ["add_patient", "get_availability", "book_appt"],
      };
    case "collect_registration":
      return {
        currentObjective:
          "Collect only the missing registration fields, then read back the required fields before submitting.",
        allowedActions: ["ask_missing_registration_field", "add_patient"],
        blockedActions: ["get_availability", "book_appt", "cancel_appt"],
      };
    case "get_availability":
      return {
        currentObjective:
          "Search availability for the right routing lane and offer one best-fit slot.",
        allowedActions: ["ask_preferred_date", "get_availability"],
        blockedActions: ["book_appt", "cancel_appt"],
      };
    case "confirm_booking":
      return {
        currentObjective:
          "Confirm the exact appointment slot before booking it.",
        allowedActions: ["ask_booking_confirmation", "book_appt"],
        blockedActions: ["cancel_appt", "transfer_call"],
      };
    case "confirm_cancel":
      return {
        currentObjective:
          "Confirm the caller wants to cancel the specific appointment before cancelling.",
        allowedActions: ["ask_cancel_confirmation", "cancel_appt"],
        blockedActions: ["book_appt"],
      };
    default:
      return {
        currentObjective:
          "Understand the caller's intent and choose the safest next step.",
        allowedActions: ["ask_clarifying_question", "lookup_knowledge"],
        blockedActions: ["add_patient", "get_availability", "book_appt"],
      };
  }
}

export function compileFlowContextPacket(
  flow: CallFlowState,
  overrides: Partial<FlowContextDirectives> = {},
): string {
  const directives = {
    ...directivesForFlowState(flow),
    ...overrides,
  };

  return [
    "<flow_state>",
    `activeFlow: ${flow.activeFlow}`,
    `activeIntent: ${flow.activeIntent ?? "unknown"}`,
    `step: ${flow.step}`,
    `language: ${flow.language}`,
    `activePatient: ${flow.activePatientRef ?? "unknown"}`,
    `patientStatus: ${flow.patientStatus}`,
    `office: ${flow.officeKey}`,
    `visitType: ${flow.visitType ?? "unknown"}`,
    `coverageType: ${flow.coverageType ?? "unknown"}`,
    `routing: ${flow.routing ?? "unknown"}`,
    `task: ${flow.currentTask?.kind ?? flow.activeFlow}`,
    `pendingActions: ${flow.pendingActions.length}`,
    `availabilitySearches: ${flow.availabilitySearches.length}`,
    `missingSlots: ${formatList(flow.requiredSlots)}`,
    `completedSteps: ${formatList(flow.completedSteps)}`,
    `allowedActions: ${formatList(directives.allowedActions)}`,
    `blockedActions: ${formatList(directives.blockedActions)}`,
    "</flow_state>",
    "",
    "<current_objective>",
    directives.currentObjective,
    "</current_objective>",
  ].join("\n");
}
