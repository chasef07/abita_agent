import type { CallState } from "../../tools.js";

export type RescheduleWorkflowStep =
  | "identify_patient"
  | "existing_appointment"
  | "visit_reason"
  | "availability"
  | "booking"
  | "cancel_original";

export type RescheduleWorkflowEvent =
  | { type: "START" }
  | { type: "IDENTITY_CONFIRMED" }
  | { type: "IDENTITY_UNRESOLVED" }
  | { type: "EXISTING_APPOINTMENT_SELECTED" }
  | { type: "VISIT_REASON_CAPTURED" }
  | { type: "SLOT_SELECTED" }
  | { type: "BOOKING_COMPLETED" }
  | { type: "CANCELLATION_COMPLETED" };

export interface RescheduleTransitionResult {
  nextStep: RescheduleWorkflowStep | null;
  activeFlow: CallState["workflow"]["activeFlow"];
  workflowComplete: boolean;
  workflowStopped: boolean;
}

type AllowedActiveFlow = CallState["workflow"]["activeFlow"];

function assertActiveFlow(
  state: CallState,
  allowed: AllowedActiveFlow[],
  event: RescheduleWorkflowEvent["type"],
) {
  if (allowed.includes(state.workflow.activeFlow)) {
    return;
  }

  throw new Error(
    `Invalid reschedule transition: ${event} cannot be applied while activeFlow is ${state.workflow.activeFlow}.`,
  );
}

export function transitionRescheduleWorkflow(
  state: CallState,
  event: RescheduleWorkflowEvent,
): RescheduleTransitionResult {
  switch (event.type) {
    case "START":
      return {
        nextStep: "identify_patient",
        activeFlow: "identify",
        workflowComplete: false,
        workflowStopped: false,
      };
    case "IDENTITY_CONFIRMED":
      assertActiveFlow(state, ["identify"], event.type);
      return {
        nextStep: "existing_appointment",
        activeFlow: "existing_appointment",
        workflowComplete: false,
        workflowStopped: false,
      };
    case "IDENTITY_UNRESOLVED":
      assertActiveFlow(state, ["identify"], event.type);
      return {
        nextStep: null,
        activeFlow: "none",
        workflowComplete: false,
        workflowStopped: true,
      };
    case "EXISTING_APPOINTMENT_SELECTED":
      assertActiveFlow(state, ["existing_appointment"], event.type);
      if (state.scheduling.reasonForVisit) {
        return {
          nextStep: "availability",
          activeFlow: "availability",
          workflowComplete: false,
          workflowStopped: false,
        };
      }
      return {
        nextStep: "visit_reason",
        activeFlow: "visit_reason",
        workflowComplete: false,
        workflowStopped: false,
      };
    case "VISIT_REASON_CAPTURED":
      assertActiveFlow(state, ["visit_reason"], event.type);
      return {
        nextStep: "availability",
        activeFlow: "availability",
        workflowComplete: false,
        workflowStopped: false,
      };
    case "SLOT_SELECTED":
      assertActiveFlow(state, ["availability"], event.type);
      return {
        nextStep: "booking",
        activeFlow: "booking",
        workflowComplete: false,
        workflowStopped: false,
      };
    case "BOOKING_COMPLETED":
      assertActiveFlow(state, ["booking"], event.type);
      return {
        nextStep: "cancel_original",
        activeFlow: "cancel",
        workflowComplete: false,
        workflowStopped: false,
      };
    case "CANCELLATION_COMPLETED":
      assertActiveFlow(state, ["cancel"], event.type);
      return {
        nextStep: null,
        activeFlow: "none",
        workflowComplete: true,
        workflowStopped: false,
      };
  }
}

export function applyRescheduleTransition(
  state: CallState,
  event: RescheduleWorkflowEvent,
): RescheduleTransitionResult {
  const result = transitionRescheduleWorkflow(state, event);

  if (event.type === "START") {
    state.workflow.intent = "reschedule";
    state.workflow.appointmentIntent = "reschedule";
  }

  state.workflow.activeFlow = result.activeFlow;
  return result;
}

export type RescheduleTaskId = Exclude<
  RescheduleWorkflowStep,
  "identify_patient"
>;

export function mapRescheduleTaskResultToEvent(
  taskId: RescheduleTaskId,
): RescheduleWorkflowEvent {
  switch (taskId) {
    case "existing_appointment":
      return { type: "EXISTING_APPOINTMENT_SELECTED" };
    case "visit_reason":
      return { type: "VISIT_REASON_CAPTURED" };
    case "availability":
      return { type: "SLOT_SELECTED" };
    case "booking":
      return { type: "BOOKING_COMPLETED" };
    case "cancel_original":
      return { type: "CANCELLATION_COMPLETED" };
  }
}
