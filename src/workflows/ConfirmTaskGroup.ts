import { beta, llm } from "@livekit/agents";
import type { CallState } from "../tools.js";
import { ExistingAppointmentTask } from "../tasks/ExistingAppointmentTask.js";
import { IdentifyPatientTask } from "../tasks/IdentifyPatientTask.js";
import { applyConfirmTransition } from "./engine/confirm-transition.js";

export interface ConfirmWorkflowResult {
  taskResults: Record<string, unknown>;
}

export async function runConfirmTaskGroup(
  chatCtx: llm.ChatContext,
  state: CallState,
): Promise<ConfirmWorkflowResult> {
  applyConfirmTransition(state, { type: "START" });

  const identifyTask = new IdentifyPatientTask(chatCtx.copy(), state);
  const identifyResult = await identifyTask.run();

  const identifyEvent =
    identifyResult.outcome === "registration_allowed" || !state.identity.patientId
      ? { type: "IDENTITY_UNRESOLVED" as const }
      : { type: "IDENTITY_CONFIRMED" as const };
  const identifyTransition = applyConfirmTransition(state, identifyEvent);

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
    onTaskCompleted: async () => {
      applyConfirmTransition(state, {
        type: "EXISTING_APPOINTMENT_SELECTED",
      });
    },
  });

  taskGroup.add(
    () => new ExistingAppointmentTask(chatCtx.copy(), state, "confirm"),
    {
      id: "existing_appointment",
      description:
        "Identify which current appointment the caller wants to confirm.",
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
