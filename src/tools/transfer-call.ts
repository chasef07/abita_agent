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
  transferCallerToOffice,
} from "./handoff.js";
import { getState } from "./session.js";
import { recordDomainOutcome } from "../state/observability.js";

export const transfer_call = tool({
  name: "transfer_call",
  onDuplicate: "reject",
  description:
    "Transfer the caller to human office staff when the transfer policy requires it. Call this tool immediately without announcing the transfer first; the tool speaks the transfer announcement.",
  parameters: z.object({}),
  execute: async (_, { ctx, toolCallId }) => {
    const state = getState(ctx);
    ctx.disallowInterruptions();

    if (transferIsAmbiguous(state)) {
      return "The transfer may already be in progress. Do not try again.";
    }
    if (transferStatus(state) === "pending") {
      return "Transfer already in progress.";
    }
    if (transferIsAccepted(state)) {
      return "Transfer already started.";
    }
    if (!state.runtime.sipRoomName || !state.runtime.sipParticipantIdentity) {
      return "I couldn't transfer because the call is no longer active.";
    }

    try {
      await ctx.waitForPlayout();
      const office = getOfficeProfileByPhone(state.runtime.trunkPhone);
      const language = state.runtime.voiceLanguage?.current ?? "en";
      const announcement = ctx.session.say(
        office.humanTransferAnnouncement(language),
        { allowInterruptions: false },
      );
      await announcement.waitForPlayout();
      const { handoffOfficeKey } = await transferCallerToOffice(state);
      recordDomainOutcome(state, {
        callId: toolCallId,
        toolName: "transfer_call",
        outcome: "transfer_started",
        status: "success",
        evidence: { officeKey: handoffOfficeKey },
      });
      return `Transfer started to the ${handoffOfficeKey} office.`;
    } catch (error) {
      console.error(
        `[tools] Transfer failed (state=${transferStatus(state)}).`,
      );
      if (transferIsAmbiguous(state)) {
        recordDomainOutcome(state, {
          callId: toolCallId,
          toolName: "transfer_call",
          outcome: "transfer_ambiguous",
          status: "ambiguous",
        });
        return "The transfer may already be in progress. Do not try again.";
      }
      if (error instanceof HandoffConflictError) {
        markTransferAmbiguous(state);
        recordDomainOutcome(state, {
          callId: toolCallId,
          toolName: "transfer_call",
          outcome: "transfer_ambiguous",
          status: "ambiguous",
        });
        return "The transfer may already be in progress. Do not try again.";
      }
      if (error instanceof HandoffError) {
        throw new ToolError(
          "I couldn't transfer the call. I can try once more.",
        );
      }
      throw error;
    }
  },
});
