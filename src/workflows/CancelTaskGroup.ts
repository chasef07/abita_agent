import { llm } from "@livekit/agents";
import {
  isWorkflowInterruptionResult,
  type CallState,
  type WorkflowInterruptionResult,
} from "../tools.js";
import { CancelAppointmentTask } from "../tasks/CancelAppointmentTask.js";
import { ExistingAppointmentTask } from "../tasks/ExistingAppointmentTask.js";
import { IdentifyPatientTask } from "../tasks/IdentifyPatientTask.js";
import {
  applyCancelTransition,
  type CancelWorkflowStep,
} from "./engine/cancel-transition.js";

export interface CancelWorkflowResult {
  taskResults: Record<string, unknown>;
  interruption: WorkflowInterruptionResult | null;
}

function createCancelTask(
  taskId: Exclude<CancelWorkflowStep, "identify_patient">,
  chatCtx: llm.ChatContext,
  state: CallState,
) {
  switch (taskId) {
    case "existing_appointment":
      return new ExistingAppointmentTask(chatCtx, state, "cancel");
    case "cancel_original":
      return new CancelAppointmentTask(chatCtx, state, "cancel");
  }
}

export async function runCancelTaskGroup(
  chatCtx: llm.ChatContext,
  state: CallState,
): Promise<CancelWorkflowResult> {
  let currentChatCtx = chatCtx;
  let transition = applyCancelTransition(state, { type: "START" });
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
      transition = applyCancelTransition(state, identifyEvent);
      if (transition.workflowStopped) {
        break;
      }
      continue;
    }

    const task = createCancelTask(taskId, currentChatCtx.copy(), state);
    const result = await task.run();
    taskResults[taskId] = result;
    currentChatCtx = task.chatCtx.copy({ excludeInstructions: true });
    if (isWorkflowInterruptionResult(result)) {
      interruption = result;
      break;
    }

    transition = applyCancelTransition(
      state,
      taskId === "existing_appointment"
        ? { type: "EXISTING_APPOINTMENT_SELECTED" }
        : { type: "CANCELLATION_COMPLETED" },
    );
  }

  return { taskResults, interruption };
}
