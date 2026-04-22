import { llm, voice } from "@livekit/agents";
import { buildTaskPrompt } from "../prompt.js";
import { buildWorkingStateSummary, cancel_appt, type CallState } from "../tools.js";

export interface CancelAppointmentTaskResult {
  cancelled: boolean;
}

export class CancelAppointmentTask extends voice.AgentTask<
  CancelAppointmentTaskResult,
  CallState
> {
  constructor(chatCtx: llm.ChatContext, state: CallState) {
    super({
      chatCtx,
      instructions: buildTaskPrompt({
        mode: "cancel",
        stateSummary: buildWorkingStateSummary(state, "cancel"),
      }),
      tools: {
        confirm_and_cancel_original_appointment: llm.tool({
          description:
            "Use this after the new appointment has been booked and the caller clearly wants the original appointment cancelled.",
          execute: async (_, { ctx }) => {
            const current = ctx.userData as CallState;
            const appointmentId = current.scheduling.targetAppointmentId;
            if (!appointmentId) {
              return "ERROR: No original appointment is selected yet.";
            }

            const result = await (cancel_appt as any).execute(
              { appointmentId },
              { ctx },
            );

            if (
              typeof result === "string" &&
              result.startsWith("ERROR:")
            ) {
              return result;
            }

            current.workflow.activeFlow = "none";
            this.complete({ cancelled: true });
            return result;
          },
        }),
      },
    });
  }

  override async onEnter(): Promise<void> {
    this.session.generateReply({
      instructions:
        "Now that the replacement appointment is booked, cancel the original appointment once the caller confirms that is what they want.",
    });
  }
}
