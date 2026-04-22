import { beta, llm } from "@livekit/agents";
import type { CallState } from "../tools.js";
import { AvailabilityTask } from "../tasks/AvailabilityTask.js";
import { BookingTask } from "../tasks/BookingTask.js";
import { CancelAppointmentTask } from "../tasks/CancelAppointmentTask.js";
import { ExistingAppointmentTask } from "../tasks/ExistingAppointmentTask.js";
import { IdentifyPatientTask } from "../tasks/IdentifyPatientTask.js";
import { VisitReasonTask } from "../tasks/VisitReasonTask.js";

export interface RescheduleWorkflowResult {
  taskResults: Record<string, unknown>;
}

export async function runRescheduleTaskGroup(
  chatCtx: llm.ChatContext,
  state: CallState,
): Promise<RescheduleWorkflowResult> {
  const identifyTask = new IdentifyPatientTask(chatCtx.copy(), state);
  const identifyResult = await identifyTask.run();

  if (
    identifyResult.outcome === "registration_allowed" ||
    !state.identity.patientId
  ) {
    state.workflow.activeFlow = "none";
    return {
      taskResults: {
        identify_patient: identifyResult,
      },
    };
  }

  const needsVisitReason = !state.scheduling.reasonForVisit;

  const taskGroup = new beta.TaskGroup({
    chatCtx: identifyTask.chatCtx.copy({ excludeInstructions: true }),
    summarizeChatCtx: true,
    onTaskCompleted: async ({ taskId }) => {
      if (taskId === "existing_appointment") {
        state.workflow.activeFlow = needsVisitReason
          ? "visit_reason"
          : "availability";
      } else if (taskId === "visit_reason") {
        state.workflow.activeFlow = "availability";
      } else if (taskId === "availability") {
        state.workflow.activeFlow = "booking";
      } else if (taskId === "booking") {
        state.workflow.activeFlow = "cancel";
      } else if (taskId === "cancel_original") {
        state.workflow.activeFlow = "none";
      }
    },
  });

  taskGroup.add(() => new ExistingAppointmentTask(chatCtx.copy(), state), {
    id: "existing_appointment",
    description:
      "Identify which current appointment the caller wants to move before searching for the replacement.",
  });

  if (needsVisitReason) {
    taskGroup.add(() => new VisitReasonTask(chatCtx.copy(), state, "reschedule"), {
      id: "visit_reason",
      description:
        "Collect or confirm the reason for the replacement visit before checking availability.",
    });
  }

  taskGroup.add(
    () => new AvailabilityTask(chatCtx.copy(), state, "reschedule"),
    {
      id: "availability",
      description:
        "Search for the replacement slot and select one that the caller wants.",
    },
  );

  taskGroup.add(() => new BookingTask(chatCtx.copy(), state, "reschedule"), {
    id: "booking",
    description:
      "Book the replacement appointment once the caller agrees to it.",
  });

  taskGroup.add(
    () => new CancelAppointmentTask(chatCtx.copy(), state, "reschedule"),
    {
      id: "cancel_original",
      description:
        "Cancel the original appointment only after the replacement has been booked and confirmed.",
    },
  );

  const result = await taskGroup.run();

  return {
    taskResults: {
      identify_patient: identifyResult,
      ...result.taskResults,
    },
  };
}
