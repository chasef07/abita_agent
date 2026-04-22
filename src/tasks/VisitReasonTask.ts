import { llm, voice } from "@livekit/agents";
import { z } from "zod";
import { buildTaskPrompt } from "../prompt.js";
import { buildWorkingStateSummary, type CallState } from "../tools.js";

export interface VisitReasonTaskResult {
  reasonForVisit: string;
}

export class VisitReasonTask extends voice.AgentTask<
  VisitReasonTaskResult,
  CallState
> {
  constructor(chatCtx: llm.ChatContext, state: CallState) {
    super({
      chatCtx,
      instructions: buildTaskPrompt({
        mode: "schedule",
        stateSummary: buildWorkingStateSummary(state, "schedule"),
      }),
      tools: {
        record_visit_reason: llm.tool({
          description:
            "Record the caller's reason for the visit once it is clear enough to choose the correct scheduling path.",
          parameters: z.object({
            reasonForVisit: z
              .string()
              .describe("Short normalized summary of the visit reason"),
          }),
          execute: async ({ reasonForVisit }, { ctx }) => {
            const current = ctx.userData as CallState;
            current.scheduling.reasonForVisit = reasonForVisit;
            current.workflow.activeFlow = "availability";
            this.complete({ reasonForVisit });
          },
        }),
      },
    });
  }

  override async onEnter(): Promise<void> {
    this.session.generateReply({
      instructions:
        "Get the reason for the visit before scheduling. Once you know it clearly enough to continue, record it and move on.",
    });
  }
}
