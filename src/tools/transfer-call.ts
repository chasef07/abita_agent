import { ToolError, tool } from "@livekit/agents";
import { z } from "zod";
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

export const transfer_call = tool({
  name: "transfer_call",
  description:
    "Call this tool whenever office policy selects a human transfer. " +
    "Treat a successful tool result as the start of the human transfer. " +
    "Handle scheduling, insurance, availability, patient verification, cancellations, and office facts with their dedicated tools. " +
    "Use for emergency, urgent, or clinical concerns, suspected medication reactions or medication instructions, returned calls from this number, or a caller who still wants live staff after one attempt to help. " +
    "Ask what they need first when the request is vague. " +
    "For safe, non-urgent work, offer create_staff_task first; transfer only if the tool is unavailable, fails, or the caller declines. " +
    "A successful create_staff_task completes that request; reserve a later transfer for a new urgent concern. " +
    "Use a neutral hold phrase, invoke this tool, then describe the transfer from its result.",
  parameters: z.object({}),
  execute: async (_, { ctx }) => {
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
      const { handoffOfficeKey } = await transferCallerToOffice(state);
      return `Transfer started to the ${handoffOfficeKey} office.`;
    } catch (error) {
      console.error(
        `[tools] Transfer failed (state=${transferStatus(state)}).`,
      );
      if (transferIsAmbiguous(state)) {
        return "The transfer may already be in progress. Do not try again.";
      }
      if (error instanceof HandoffConflictError) {
        markTransferAmbiguous(state);
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
