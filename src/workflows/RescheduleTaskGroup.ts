import { llm } from "@livekit/agents";
import type { CallState } from "../tools.js";
import { AvailabilityTask } from "../tasks/AvailabilityTask.js";
import { BookingTask } from "../tasks/BookingTask.js";
import { CancelAppointmentTask } from "../tasks/CancelAppointmentTask.js";
import { ExistingAppointmentTask } from "../tasks/ExistingAppointmentTask.js";
import { IdentifyPatientTask } from "../tasks/IdentifyPatientTask.js";
import { VisitReasonTask } from "../tasks/VisitReasonTask.js";
import {
  applyRescheduleTransition,
  mapRescheduleTaskResultToEvent,
  type RescheduleTaskId,
} from "./engine/reschedule-transition.js";

export interface RescheduleWorkflowResult {
  taskResults: Record<string, unknown>;
}

function createRescheduleTask(
  taskId: RescheduleTaskId,
  chatCtx: llm.ChatContext,
  state: CallState,
) {
  switch (taskId) {
    case "existing_appointment":
      return new ExistingAppointmentTask(chatCtx, state);
    case "visit_reason":
      return new VisitReasonTask(chatCtx, state, "reschedule");
    case "availability":
      return new AvailabilityTask(chatCtx, state, "reschedule");
    case "booking":
      return new BookingTask(chatCtx, state, "reschedule");
    case "cancel_original":
      return new CancelAppointmentTask(chatCtx, state, "reschedule");
  }
}

export async function runRescheduleTaskGroup(
  chatCtx: llm.ChatContext,
  state: CallState,
): Promise<RescheduleWorkflowResult> {
  let currentChatCtx = chatCtx;
  let transition = applyRescheduleTransition(state, { type: "START" });
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
      transition = applyRescheduleTransition(state, identifyEvent);
      if (transition.workflowStopped) {
        break;
      }
      continue;
    }

    const task = createRescheduleTask(taskId, currentChatCtx.copy(), state);
    const result = await task.run();
    taskResults[taskId] = result;
    currentChatCtx = task.chatCtx.copy({ excludeInstructions: true });
    transition = applyRescheduleTransition(
      state,
      mapRescheduleTaskResultToEvent(taskId),
    );
  }

  return { taskResults };
}
