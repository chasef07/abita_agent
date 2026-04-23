import { llm } from "@livekit/agents";
import type { CallState } from "../tools.js";
import { ExistingAppointmentTask } from "../tasks/ExistingAppointmentTask.js";
import { IdentifyPatientTask } from "../tasks/IdentifyPatientTask.js";
import {
  applyConfirmTransition,
  type ConfirmWorkflowStep,
} from "./engine/confirm-transition.js";

export interface ConfirmWorkflowResult {
  taskResults: Record<string, unknown>;
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
    transition = applyConfirmTransition(state, {
      type: "EXISTING_APPOINTMENT_SELECTED",
    });
  }

  return { taskResults };
}
