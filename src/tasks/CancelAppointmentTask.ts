import { llm, voice } from "@livekit/agents";
import { buildTaskPrompt } from "../prompt.js";
import {
  buildWorkingStateSummary,
  cancel_appt,
  type CallState,
} from "../tools.js";

export interface CancelAppointmentTaskResult {
  cancelled: boolean;
}

export class CancelAppointmentTask extends voice.AgentTask<
  CancelAppointmentTaskResult,
  CallState
> {
  private readonly enterInstructions: string;

  constructor(
    chatCtx: llm.ChatContext,
    state: CallState,
    mode: "cancel" | "reschedule" = "cancel",
  ) {
    const toolDescription =
      mode === "reschedule"
        ? "Use this after the replacement appointment has been booked and the caller clearly wants the original appointment cancelled."
        : "Use this after the caller clearly confirms they want the selected appointment cancelled.";
    const enterInstructions =
      mode === "reschedule"
        ? "Now that the replacement appointment is booked, cancel the original appointment once the caller confirms that is what they want."
        : "Confirm that the caller wants the selected appointment cancelled, then cancel it.";

    super({
      chatCtx,
      instructions: buildTaskPrompt({
        mode: "cancel",
        stateSummary: buildWorkingStateSummary(state, "cancel"),
        officeKey: state.officeKey,
        effectiveOfficeKey: state.effectiveOfficeKey,
      }),
      tools: {
        confirm_and_cancel_original_appointment: llm.tool({
          description: toolDescription,
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

            if (typeof result === "string" && result.startsWith("ERROR:")) {
              return result;
            }

            this.complete({ cancelled: true });
            return result;
          },
        }),
      },
    });
    this.enterInstructions = enterInstructions;
  }

  override async onEnter(): Promise<void> {
    this.session.generateReply({
      instructions: this.enterInstructions,
    });
  }
}
