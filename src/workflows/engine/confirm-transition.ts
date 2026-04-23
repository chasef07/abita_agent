import type { CallState } from "../../tools.js";

export type ConfirmWorkflowStep = "identify_patient" | "existing_appointment";

export type ConfirmWorkflowEvent =
  | { type: "START" }
  | { type: "IDENTITY_CONFIRMED" }
  | { type: "IDENTITY_UNRESOLVED" }
  | { type: "NO_EXISTING_APPOINTMENT" }
  | { type: "EXISTING_APPOINTMENT_SELECTED" };

export interface ConfirmTransitionResult {
  nextStep: ConfirmWorkflowStep | null;
  activeFlow: CallState["workflow"]["activeFlow"];
  workflowComplete: boolean;
  workflowStopped: boolean;
}

type AllowedActiveFlow = CallState["workflow"]["activeFlow"];

function assertActiveFlow(
  state: CallState,
  allowed: AllowedActiveFlow[],
  event: ConfirmWorkflowEvent["type"],
) {
  if (allowed.includes(state.workflow.activeFlow)) {
    return;
  }

  throw new Error(
    `Invalid confirm transition: ${event} cannot be applied while activeFlow is ${state.workflow.activeFlow}.`,
  );
}

export function transitionConfirmWorkflow(
  state: CallState,
  event: ConfirmWorkflowEvent,
): ConfirmTransitionResult {
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
        nextStep: null,
        activeFlow: "none",
        workflowComplete: true,
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
  }
}

export function applyConfirmTransition(
  state: CallState,
  event: ConfirmWorkflowEvent,
): ConfirmTransitionResult {
  const result = transitionConfirmWorkflow(state, event);

  if (event.type === "START") {
    state.workflow.intent = "confirm";
    state.workflow.appointmentIntent = "confirm";
  }

  state.workflow.activeFlow = result.activeFlow;
  return result;
}
