import { tool } from "@livekit/agents";
import { z } from "zod";
import {
  transferIsAccepted,
  transferIsAmbiguous,
  transferStatus,
} from "../state/call-lifecycle.js";
import { transferCallerToOffice } from "./handoff.js";
import { getState } from "./session.js";

export const transfer_call = tool({
  name: "transfer_call",
  description:
    "Transfer to office staff for synchronous human help or work outside the agent's front-desk scope. " +
    "Ask the reason once for a vague human, representative, staff, or office request. " +
    "Transfer immediately for emergency or urgent symptoms, suspected medication reactions, dosage or medication instructions, clinical advice, medical decisions, returned missed or received calls from this number, or a caller choosing live staff instead of follow-up. " +
    "For other safe non-live work, offer one available follow-up; transfer only if unavailable, failed, or declined. " +
    "Never transfer a request another tool completed unless the caller raises a new urgent concern. " +
    "Before calling, tell the caller you're transferring them now. " +
    "Do not transfer solely for scheduling, insurance, availability, patient verification, cancellations, or office facts.",
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
      return "Could not transfer because there is no active SIP session.";
    }

    try {
      await ctx.waitForPlayout();
      const { handoffOfficeKey } = await transferCallerToOffice(state);
      return `Transfer started to the ${handoffOfficeKey} office.`;
    } catch {
      console.error(
        `[tools] Transfer failed (state=${transferStatus(state)}).`,
      );
      if (transferIsAmbiguous(state)) {
        return "The transfer may already be in progress. Do not try again.";
      }
      return "Could not transfer the call.";
    }
  },
});
