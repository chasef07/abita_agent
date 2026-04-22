import { beta, llm } from "@livekit/agents";
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

export async function runRescheduleTaskGroup(
  chatCtx: llm.ChatContext,
  state: CallState,
): Promise<RescheduleWorkflowResult> {
  applyRescheduleTransition(state, { type: "START" });

  const identifyTask = new IdentifyPatientTask(chatCtx.copy(), state);
  const identifyResult = await identifyTask.run();

  const identifyEvent =
    identifyResult.outcome === "registration_allowed" ||
    !state.identity.patientId
      ? { type: "IDENTITY_UNRESOLVED" as const }
      : { type: "IDENTITY_CONFIRMED" as const };
  const identifyTransition = applyRescheduleTransition(state, identifyEvent);

  if (identifyTransition.workflowStopped) {
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
      const event = mapRescheduleTaskResultToEvent(taskId as RescheduleTaskId);
      applyRescheduleTransition(state, event);
    },
  });

  taskGroup.add(() => new ExistingAppointmentTask(chatCtx.copy(), state), {
    id: "existing_appointment",
    description:
      "Identify which current appointment the caller wants to move before searching for the replacement.",
  });

  if (needsVisitReason) {
    taskGroup.add(
      () => new VisitReasonTask(chatCtx.copy(), state, "reschedule"),
      {
        id: "visit_reason",
        description:
          "Collect or confirm the reason for the replacement visit before checking availability.",
      },
    );
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
