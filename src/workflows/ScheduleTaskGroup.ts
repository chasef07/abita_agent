import { beta, llm } from "@livekit/agents";
import type { CallState } from "../tools.js";
import { AvailabilityTask } from "../tasks/AvailabilityTask.js";
import { BookingTask } from "../tasks/BookingTask.js";
import { IdentifyPatientTask } from "../tasks/IdentifyPatientTask.js";
import { RegistrationTask } from "../tasks/RegistrationTask.js";
import { VisitReasonTask } from "../tasks/VisitReasonTask.js";

export async function runScheduleTaskGroup(
  chatCtx: llm.ChatContext,
  state: CallState,
) {
  const taskGroup = new beta.TaskGroup({
    chatCtx,
    summarizeChatCtx: true,
    onTaskCompleted: async ({ taskId, result }) => {
      if (taskId === "identify_patient") {
        const identifyResult = result as {
          outcome?: "identified" | "registration_allowed";
        };
        state.workflow.activeFlow =
          identifyResult.outcome === "registration_allowed"
            ? "register"
            : "visit_reason";
      } else if (taskId === "register_patient") {
        state.workflow.activeFlow = "visit_reason";
      } else if (taskId === "visit_reason") {
        state.workflow.activeFlow = "availability";
      } else if (taskId === "availability") {
        state.workflow.activeFlow = "booking";
      } else if (taskId === "booking") {
        state.workflow.activeFlow = "none";
      }
    },
  });

  taskGroup.add(() => new IdentifyPatientTask(chatCtx.copy(), state), {
    id: "identify_patient",
    description:
      "Resolve who the patient is before scheduling continues.",
  });

  if (state.workflow.registrationAllowed || !state.identity.patientId) {
    taskGroup.add(() => new RegistrationTask(chatCtx.copy(), state), {
      id: "register_patient",
      description:
        "Collect and submit new-patient registration details when registration is required.",
    });
  }

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
