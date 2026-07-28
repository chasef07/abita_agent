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
    "Use for emergency, urgent, or clinical concerns, suspected medication reactions or medication instructions, returned calls from this number, or a caller who still wants live staff after one attempt to help. " +
    "Ask what they need first when the request is vague. " +
    "For safe, non-urgent work, offer create_staff_task first; transfer only if the tool is unavailable, fails, or the caller declines. " +
    "Do not transfer a request captured by create_staff_task unless a new urgent concern arises. " +
    "Tell the caller before starting the transfer. " +
    "Do not use solely for scheduling, insurance, availability, patient verification, cancellations, or office facts.",
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
