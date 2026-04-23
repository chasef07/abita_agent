import { llm, voice } from "@livekit/agents";
import { buildTaskPrompt } from "../prompt.js";
import { buildTaskEscapeTools } from "./escapeTools.js";
import { startTaskReply } from "./startTaskReply.js";
import {
  book_appt,
  buildWorkingStateSummary,
  type CallState,
} from "../tools.js";

export interface BookingTaskResult {
  booked: boolean;
}

export class BookingTask extends voice.AgentTask<BookingTaskResult, CallState> {
  constructor(
    chatCtx: llm.ChatContext,
    state: CallState,
    mode: "schedule" | "reschedule" = "schedule",
  ) {
    super({
      chatCtx,
      instructions: buildTaskPrompt({
        mode,
        stateSummary: buildWorkingStateSummary(state, mode),
        officeKey: state.officeKey,
        effectiveOfficeKey: state.effectiveOfficeKey,
      }),
      tools: {
        ...buildTaskEscapeTools((result) => this.complete(result as any)),
        confirm_and_book_selected_slot: llm.tool({
          description:
            "Use this after the caller clearly agrees to the selected slot. This books the slot already stored in workflow state and completes the task on success.",
          execute: async (_, { ctx }) => {
            const current = ctx.userData as CallState;
            const selectedSlot = current.scheduling.selectedSlot;
            if (!selectedSlot) {
              return "ERROR: No selected slot is stored yet. Choose a slot first before booking.";
            }

            const result = await (book_appt as any).execute(selectedSlot, {
              ctx,
            });

            if (typeof result === "string" && result.startsWith("ERROR:")) {
              return result;
            }

            this.complete({ booked: true });
            return result;
          },
        }),
      },
    });
  }

  override async onEnter(): Promise<void> {
    startTaskReply(
      this.session,
      "Confirm the selected slot briefly and book it once the caller agrees. Do not ask them to re-pick the slot unless they change their mind.",
    );
  }
}
