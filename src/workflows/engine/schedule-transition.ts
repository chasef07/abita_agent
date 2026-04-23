import type { CallState } from "../../tools.js";

export type ScheduleWorkflowStep =
  | "identify_patient"
  | "register_patient"
  | "visit_reason"
  | "availability"
  | "booking";

export type ScheduleWorkflowEvent =
  | { type: "START" }
  | { type: "IDENTITY_CONFIRMED" }
  | { type: "REGISTRATION_ALLOWED" }
  | { type: "REGISTRATION_COMPLETED" }
  | { type: "REGISTRATION_SKIPPED" }
  | { type: "VISIT_REASON_CAPTURED" }
  | { type: "SLOT_SELECTED" }
  | { type: "BOOKING_COMPLETED" };

export interface ScheduleTransitionResult {
  nextStep: ScheduleWorkflowStep | null;
  activeFlow: CallState["workflow"]["activeFlow"];
  workflowComplete: boolean;
}

type AllowedActiveFlow = CallState["workflow"]["activeFlow"];

function assertActiveFlow(
  state: CallState,
  allowed: AllowedActiveFlow[],
  event: ScheduleWorkflowEvent["type"],
) {
  if (allowed.includes(state.workflow.activeFlow)) {
    return;
  }

  throw new Error(
    `Invalid schedule transition: ${event} cannot be applied while activeFlow is ${state.workflow.activeFlow}.`,
  );
}

export function transitionScheduleWorkflow(
  state: CallState,
  event: ScheduleWorkflowEvent,
): ScheduleTransitionResult {
  switch (event.type) {
    case "START":
      return {
        nextStep: "identify_patient",
        activeFlow: "identify",
        workflowComplete: false,
      };
    case "IDENTITY_CONFIRMED":
      assertActiveFlow(state, ["identify"], event.type);
      return {
        nextStep: "visit_reason",
        activeFlow: "visit_reason",
        workflowComplete: false,
      };
    case "REGISTRATION_ALLOWED":
      assertActiveFlow(state, ["identify"], event.type);
      return {
        nextStep: "register_patient",
        activeFlow: "register",
        workflowComplete: false,
      };
    case "REGISTRATION_COMPLETED":
      assertActiveFlow(state, ["register"], event.type);
      return {
        nextStep: "visit_reason",
        activeFlow: "visit_reason",
        workflowComplete: false,
      };
    case "REGISTRATION_SKIPPED":
      assertActiveFlow(state, ["visit_reason", "register"], event.type);
      return {
        nextStep: "visit_reason",
        activeFlow: "visit_reason",
        workflowComplete: false,
      };
    case "VISIT_REASON_CAPTURED":
      assertActiveFlow(state, ["visit_reason"], event.type);
      return {
        nextStep: "availability",
        activeFlow: "availability",
        workflowComplete: false,
      };
    case "SLOT_SELECTED":
      assertActiveFlow(state, ["availability"], event.type);
      return {
        nextStep: "booking",
        activeFlow: "booking",
        workflowComplete: false,
      };
    case "BOOKING_COMPLETED":
      assertActiveFlow(state, ["booking"], event.type);
      return {
        nextStep: null,
        activeFlow: "none",
        workflowComplete: true,
      };
  }
}

export function applyScheduleTransition(
  state: CallState,
  event: ScheduleWorkflowEvent,
): ScheduleTransitionResult {
  const result = transitionScheduleWorkflow(state, event);

  if (event.type === "START") {
    state.workflow.intent = "schedule";
    state.workflow.appointmentIntent = "schedule";
  }

  state.workflow.activeFlow = result.activeFlow;
  return result;
}

export type ScheduleTaskId = ScheduleWorkflowStep;

export function mapScheduleTaskResultToEvent(
  taskId: ScheduleTaskId,
  result: unknown,
): ScheduleWorkflowEvent {
  switch (taskId) {
    case "identify_patient": {
      const identifyResult = result as {
        outcome?: "identified" | "registration_allowed";
      };
      return identifyResult.outcome === "registration_allowed"
        ? { type: "REGISTRATION_ALLOWED" }
        : { type: "IDENTITY_CONFIRMED" };
    }
    case "register_patient": {
      const registrationResult = result as { registered?: boolean };
      return registrationResult.registered
        ? { type: "REGISTRATION_COMPLETED" }
        : { type: "REGISTRATION_SKIPPED" };
    }
    case "visit_reason":
      return { type: "VISIT_REASON_CAPTURED" };
    case "availability":
      return { type: "SLOT_SELECTED" };
    case "booking":
      return { type: "BOOKING_COMPLETED" };
  }
}
