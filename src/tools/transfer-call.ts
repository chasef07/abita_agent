import { ToolError, tool } from "@livekit/agents";
import { z } from "zod";
import { getOfficeProfileByPhone } from "../customers/abita/profile.js";
import {
  markTransferAmbiguous,
  transferIsAccepted,
  transferIsAmbiguous,
  transferStatus,
} from "../state/call-lifecycle.js";
import {
  HandoffConflictError,
  HandoffError,
  HandoffTaskError,
  validateHandoffTask,
  transferCallerToOffice,
} from "./handoff.js";
import { getState } from "./session.js";
import { domainOutcomesForTool } from "../state/observability.js";

type TransferOutcomeStatus = "success" | "blocked" | "ambiguous" | "failed";

export const transfer_call = tool({
  name: "transfer_call",
  onDuplicate: "reject",
  description:
    "Transfer the caller to human staff only when current office policy requires it. " +
    "Call immediately without announcing the transfer; the tool speaks the announcement. " +
    "Retry only when the result explicitly offers one retry.",
  parameters: z.object({
    taskId: z
      .string()
      .uuid()
      .nullable()
      .describe(
        "Task reference returned by create_staff_task, only when transferring that same patient request. Use null for a separate request or when no Task was created. Never invent a reference.",
      ),
  }),
  execute: async (input, { ctx, toolCallId }): Promise<string> => {
    const taskId = input.taskId ?? undefined;
    const state = getState(ctx);
    ctx.disallowInterruptions();
    const outcomes = domainOutcomesForTool(state, toolCallId, "transfer_call");
    const record = (
      status: TransferOutcomeStatus,
      evidence?: Record<string, unknown>,
    ) =>
      outcomes.record({
        outcome: transferDomainOutcome(status),
        status,
        ...(evidence ? { evidence } : {}),
      });
    const reply = (status: TransferOutcomeStatus, message: string) => {
      record(status);
      return message;
    };
    if (transferIsAmbiguous(state)) {
      return reply("ambiguous", "The transfer may already be in progress.");
    }
    if (transferStatus(state) === "pending") {
      return reply("blocked", "Transfer already in progress.");
    }
    if (transferIsAccepted(state)) {
      return reply("success", "Transfer already started.");
    }
    if (!state.runtime.sipRoomName || !state.runtime.sipParticipantIdentity) {
      return reply(
        "failed",
        "I couldn't transfer because the call is no longer active.",
      );
    }

    try {
      validateHandoffTask(state, taskId);
      await ctx.waitForPlayout();
      const office = getOfficeProfileByPhone(state.runtime.trunkPhone);
      const language = state.runtime.voiceLanguage?.current ?? "en";
      const announcement = ctx.session.say(
        office.humanTransferAnnouncement(language),
        { allowInterruptions: false },
      );
      await announcement.waitForPlayout();
      const { handoffOfficeKey } = await transferCallerToOffice(state, taskId);
      record("success", { officeKey: handoffOfficeKey });
      return `Transfer started to the ${handoffOfficeKey} office.`;
    } catch (error) {
      if (error instanceof HandoffTaskError) {
        record("failed");
        throw new ToolError(error.message);
      }
      console.error(
        `[tools] Transfer failed (state=${transferStatus(state)}).`,
      );
      if (transferIsAmbiguous(state)) {
        return reply("ambiguous", "The transfer may already be in progress.");
      }
      if (error instanceof HandoffConflictError) {
        markTransferAmbiguous(state);
        return reply("ambiguous", "The transfer may already be in progress.");
      }
      if (error instanceof HandoffError) {
        record("failed");
        throw new ToolError(
          "I couldn't transfer the call. I can try once more.",
        );
      }
      record("failed");
      throw error;
    }
  },
});

function transferDomainOutcome(status: TransferOutcomeStatus) {
  return status === "success"
    ? ("transfer_started" as const)
    : status === "blocked"
      ? ("transfer_blocked" as const)
      : status === "ambiguous"
        ? ("transfer_ambiguous" as const)
        : ("transfer_failed" as const);
}
