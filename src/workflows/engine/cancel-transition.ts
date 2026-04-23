import type { CallState } from "../../tools.js";

export type CancelWorkflowStep =
  | "identify_patient"
  | "existing_appointment"
  | "cancel_original";

export type CancelWorkflowEvent =
  | { type: "START" }
  | { type: "IDENTITY_CONFIRMED" }
  | { type: "IDENTITY_UNRESOLVED" }
  | { type: "NO_EXISTING_APPOINTMENT" }
  | { type: "EXISTING_APPOINTMENT_SELECTED" }
  | { type: "CANCELLATION_COMPLETED" };

export interface CancelTransitionResult {
  nextStep: CancelWorkflowStep | null;
  activeFlow: CallState["workflow"]["activeFlow"];
  workflowComplete: boolean;
  workflowStopped: boolean;
}

type AllowedActiveFlow = CallState["workflow"]["activeFlow"];

function assertActiveFlow(
  state: CallState,
  allowed: AllowedActiveFlow[],
  event: CancelWorkflowEvent["type"],
) {
  if (allowed.includes(state.workflow.activeFlow)) {
    return;
  }

  throw new Error(
    `Invalid cancel transition: ${event} cannot be applied while activeFlow is ${state.workflow.activeFlow}.`,
  );
}

export function transitionCancelWorkflow(
  state: CallState,
  event: CancelWorkflowEvent,
): CancelTransitionResult {
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
      return {
        nextStep: "cancel_original",
        activeFlow: "cancel",
        workflowComplete: false,
        workflowStopped: false,
      };
    case "NO_EXISTING_APPOINTMENT":
      assertActiveFlow(state, ["existing_appointment"], event.type);
      return {
        nextStep: null,
        activeFlow: "none",
        workflowComplete: false,
        workflowStopped: true,
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

export function applyCancelTransition(
  state: CallState,
  event: CancelWorkflowEvent,
): CancelTransitionResult {
  const result = transitionCancelWorkflow(state, event);

  if (event.type === "START") {
    state.workflow.intent = "cancel";
    state.workflow.appointmentIntent = "cancel";
  }

  state.workflow.activeFlow = result.activeFlow;
  return result;
}
