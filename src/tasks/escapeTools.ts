import { llm } from "@livekit/agents";
import { z } from "zod";
import {
  lookup_knowledge,
  recordWorkflowInterruption,
  transfer_call,
  type CallState,
  type WorkflowInterruptionResult,
} from "../tools.js";

export function buildTaskEscapeTools(
  onInterrupt?: (result: WorkflowInterruptionResult) => void,
): llm.ToolContext<CallState> {
  return {
    lookup_knowledge,
    transfer_call,
    request_workflow_change: llm.tool({
      description:
        "Use this when the caller changes what they want during the current workflow, such as switching from scheduling to canceling, confirming, rescheduling, asking a quick office question, or requesting a transfer. This pauses the current workflow and returns control to the front-desk router.",
      parameters: z.object({
        requestedIntent: z
          .enum([
            "faq",
            "schedule",
            "confirm",
            "cancel",
            "reschedule",
            "transfer",
          ])
          .describe("The caller's new intent"),
        reason: z
          .string()
          .describe(
            "Short explanation of what changed in the caller's request",
          ),
      }),
      execute: async ({ requestedIntent, reason }, { ctx }) => {
        const state = ctx.userData as CallState;
        const result = recordWorkflowInterruption(
          state,
          requestedIntent,
          reason,
        );
        onInterrupt?.(result);
        return `Workflow paused for ${requestedIntent}: ${reason}`;
      },
    }),
  };
}
