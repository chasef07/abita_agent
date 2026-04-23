import { llm } from "@livekit/agents";
import {
  isWorkflowInterruptionResult,
  type CallState,
  type WorkflowInterruptionResult,
} from "../tools.js";
import { ExistingAppointmentTask } from "../tasks/ExistingAppointmentTask.js";
import { IdentifyPatientTask } from "../tasks/IdentifyPatientTask.js";
import {
  applyConfirmTransition,
  type ConfirmWorkflowStep,
} from "./engine/confirm-transition.js";

export interface ConfirmWorkflowResult {
  taskResults: Record<string, unknown>;
  interruption: WorkflowInterruptionResult | null;
}

function createConfirmTask(
  taskId: Exclude<ConfirmWorkflowStep, "identify_patient">,
  chatCtx: llm.ChatContext,
  state: CallState,
) {
  switch (taskId) {
    case "existing_appointment":
      return new ExistingAppointmentTask(chatCtx, state, "confirm");
  }
}

export async function runConfirmTaskGroup(
  chatCtx: llm.ChatContext,
  state: CallState,
): Promise<ConfirmWorkflowResult> {
  let currentChatCtx = chatCtx;
  let transition = applyConfirmTransition(state, { type: "START" });
  const taskResults: Record<string, unknown> = {};
  let interruption: WorkflowInterruptionResult | null = null;

  while (transition.nextStep) {
    const taskId = transition.nextStep;
    if (taskId === "identify_patient") {
      const identifyTask = new IdentifyPatientTask(
        currentChatCtx.copy(),
        state,
      );
      const identifyResult = await identifyTask.run();
      taskResults[taskId] = identifyResult;
      currentChatCtx = identifyTask.chatCtx.copy({ excludeInstructions: true });
      if (isWorkflowInterruptionResult(identifyResult)) {
        interruption = identifyResult;
        break;
      }

      const identifyEvent =
        identifyResult.outcome === "registration_allowed" ||
        !state.identity.patientId
          ? ({ type: "IDENTITY_UNRESOLVED" } as const)
          : ({ type: "IDENTITY_CONFIRMED" } as const);
      transition = applyConfirmTransition(state, identifyEvent);
      if (transition.workflowStopped) {
        break;
      }
      continue;
    }

    const task = createConfirmTask(taskId, currentChatCtx.copy(), state);
    const result = await task.run();
    taskResults[taskId] = result;
    currentChatCtx = task.chatCtx.copy({ excludeInstructions: true });
    if (isWorkflowInterruptionResult(result)) {
      interruption = result;
      break;
    }
    const existingAppointmentResult = result as {
      appointmentId?: number | null;
    };
    transition = applyConfirmTransition(state, {
      type:
        existingAppointmentResult.appointmentId === null
          ? "NO_EXISTING_APPOINTMENT"
          : "EXISTING_APPOINTMENT_SELECTED",
    });
    if (transition.workflowStopped) {
      break;
    }
  }

  return { taskResults, interruption };
}
