import { llm } from "@livekit/agents";
import type { CallState } from "../tools.js";
import { AvailabilityTask } from "../tasks/AvailabilityTask.js";
import { BookingTask } from "../tasks/BookingTask.js";
import { IdentifyPatientTask } from "../tasks/IdentifyPatientTask.js";
import { RegistrationTask } from "../tasks/RegistrationTask.js";
import { VisitReasonTask } from "../tasks/VisitReasonTask.js";
import {
  applyScheduleTransition,
  mapScheduleTaskResultToEvent,
  type ScheduleTaskId,
} from "./engine/schedule-transition.js";

function createScheduleTask(
  taskId: ScheduleTaskId,
  chatCtx: llm.ChatContext,
  state: CallState,
) {
  switch (taskId) {
    case "identify_patient":
      return new IdentifyPatientTask(chatCtx, state);
    case "register_patient":
      return new RegistrationTask(chatCtx, state);
    case "visit_reason":
      return new VisitReasonTask(chatCtx, state);
    case "availability":
      return new AvailabilityTask(chatCtx, state);
    case "booking":
      return new BookingTask(chatCtx, state);
  }
}

export async function runScheduleTaskGroup(
  chatCtx: llm.ChatContext,
  state: CallState,
) {
  let currentChatCtx = chatCtx;
  let transition = applyScheduleTransition(state, { type: "START" });
  const taskResults: Record<string, unknown> = {};

  while (transition.nextStep) {
    const taskId = transition.nextStep;
    const task = createScheduleTask(taskId, currentChatCtx.copy(), state);
    const result = await task.run();
    taskResults[taskId] = result;
    currentChatCtx = task.chatCtx.copy({ excludeInstructions: true });

    transition = applyScheduleTransition(
      state,
      mapScheduleTaskResultToEvent(taskId, result),
    );
  }

  return { taskResults };
}
