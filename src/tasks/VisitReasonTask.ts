import { llm, voice } from "@livekit/agents";
import { z } from "zod";
import { buildTaskPrompt } from "../prompt.js";
import { buildTaskEscapeTools } from "./escapeTools.js";
import { startTaskReply } from "./startTaskReply.js";
import {
  buildWorkingStateSummary,
  type CallState,
  route_to_spring_hill,
  shouldExposeRouteToSpringHill,
} from "../tools.js";

export interface VisitReasonTaskResult {
  reasonForVisit: string;
}

export class VisitReasonTask extends voice.AgentTask<
  VisitReasonTaskResult,
  CallState
> {
  private readonly enterInstructions: string;

  constructor(
    chatCtx: llm.ChatContext,
    state: CallState,
    mode: "schedule" | "reschedule" = "schedule",
  ) {
    const enterInstructions =
      mode === "reschedule"
        ? "Get the reason for the replacement visit before checking availability. Once you know it clearly enough to continue, record it and move on."
        : "Get the reason for the visit before scheduling. Once you know it clearly enough to continue, record it and move on.";

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
        ...(shouldExposeRouteToSpringHill(state)
          ? { route_to_spring_hill }
          : {}),
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
            this.complete({ reasonForVisit });
          },
        }),
      },
    });
    this.enterInstructions = enterInstructions;
  }

  override async onEnter(): Promise<void> {
    startTaskReply(this.session, this.enterInstructions);
  }
}
