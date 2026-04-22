import { beta, llm } from "@livekit/agents";
import type { CallState } from "../tools.js";
import { ExistingAppointmentTask } from "../tasks/ExistingAppointmentTask.js";
import { IdentifyPatientTask } from "../tasks/IdentifyPatientTask.js";

export interface ConfirmWorkflowResult {
  taskResults: Record<string, unknown>;
}

export async function runConfirmTaskGroup(
  chatCtx: llm.ChatContext,
  state: CallState,
): Promise<ConfirmWorkflowResult> {
  const identifyTask = new IdentifyPatientTask(chatCtx.copy(), state);
  const identifyResult = await identifyTask.run();

  if (identifyResult.outcome === "registration_allowed" || !state.identity.patientId) {
    state.workflow.activeFlow = "none";
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
        state.workflow.activeFlow = "none";
      }
    },
  });

  taskGroup.add(() => new ExistingAppointmentTask(chatCtx.copy(), state, "confirm"), {
    id: "existing_appointment",
    description:
      "Identify which current appointment the caller wants to confirm.",
  });

  const result = await taskGroup.run();

  return {
    taskResults: {
      identify_patient: identifyResult,
      ...result.taskResults,
    },
  };
}
