import { beta, llm } from "@livekit/agents";
import type { CallState } from "../tools.js";
import { CancelAppointmentTask } from "../tasks/CancelAppointmentTask.js";
import { ExistingAppointmentTask } from "../tasks/ExistingAppointmentTask.js";
import { IdentifyPatientTask } from "../tasks/IdentifyPatientTask.js";
import { applyCancelTransition } from "./engine/cancel-transition.js";

export interface CancelWorkflowResult {
  taskResults: Record<string, unknown>;
}

export async function runCancelTaskGroup(
  chatCtx: llm.ChatContext,
  state: CallState,
): Promise<CancelWorkflowResult> {
  applyCancelTransition(state, { type: "START" });

  const identifyTask = new IdentifyPatientTask(chatCtx.copy(), state);
  const identifyResult = await identifyTask.run();

  const identifyEvent =
    identifyResult.outcome === "registration_allowed" ||
    !state.identity.patientId
      ? { type: "IDENTITY_UNRESOLVED" as const }
      : { type: "IDENTITY_CONFIRMED" as const };
  const identifyTransition = applyCancelTransition(state, identifyEvent);

  if (identifyTransition.workflowStopped) {
    return {
      taskResults: {
        identify_patient: identifyResult,
      },
    };
  }

  const taskGroup = new beta.TaskGroup({
    chatCtx: identifyTask.chatCtx.copy({ excludeInstructions: true }),
    summarizeChatCtx: true,
    onTaskCompleted: async ({ taskId }) => {
      if (taskId === "existing_appointment") {
        applyCancelTransition(state, {
          type: "EXISTING_APPOINTMENT_SELECTED",
        });
      } else if (taskId === "cancel_original") {
        applyCancelTransition(state, {
          type: "CANCELLATION_COMPLETED",
        });
      }
    },
  });

  taskGroup.add(
    () => new ExistingAppointmentTask(chatCtx.copy(), state, "cancel"),
    {
      id: "existing_appointment",
      description:
        "Identify which current appointment the caller wants to cancel.",
    },
  );

  taskGroup.add(
    () => new CancelAppointmentTask(chatCtx.copy(), state, "cancel"),
    {
      id: "cancel_original",
      description:
        "Cancel the identified appointment once the caller confirms they want it cancelled.",
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
