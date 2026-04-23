import { beta, llm } from "@livekit/agents";
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

export async function runScheduleTaskGroup(
  chatCtx: llm.ChatContext,
  state: CallState,
) {
  applyScheduleTransition(state, { type: "START" });

  const taskGroup = new beta.TaskGroup({
    chatCtx,
    summarizeChatCtx: true,
    onTaskCompleted: async ({ taskId, result }) => {
      const event = mapScheduleTaskResultToEvent(
        taskId as ScheduleTaskId,
        result,
      );
      applyScheduleTransition(state, event);
    },
  });

  taskGroup.add(() => new IdentifyPatientTask(chatCtx.copy(), state), {
    id: "identify_patient",
    description: "Resolve who the patient is before scheduling continues.",
  });

  taskGroup.add(() => new RegistrationTask(chatCtx.copy(), state), {
    id: "register_patient",
    description:
      "Collect and submit new-patient registration details when registration is required.",
  });

  taskGroup.add(() => new VisitReasonTask(chatCtx.copy(), state), {
    id: "visit_reason",
    description:
      "Collect or update the reason for the visit before availability.",
  });

  taskGroup.add(() => new AvailabilityTask(chatCtx.copy(), state), {
    id: "availability",
    description:
      "Search availability and pick a slot, or revisit an earlier step if the caller changes details.",
  });

  taskGroup.add(() => new BookingTask(chatCtx.copy(), state), {
    id: "booking",
    description:
      "Confirm and book the selected slot once the caller clearly agrees.",
  });

  return taskGroup.run();
}
