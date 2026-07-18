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
    "Transfer the caller to office staff only when their request truly needs a live human or is outside the agent's front-desk scope. " +
    "If they ask for a human, representative, staff, or the office without saying why, ask what they are calling about before calling this tool. " +
    "Before calling this tool, briefly tell the caller you're transferring them now. " +
    "Call this for emergency or urgent symptoms, suspected medication reactions, dosage or medication instructions, clinical advice, medical decisions, returned missed calls or received calls from this number, or when the caller still insists after you try to help. " +
    "Do not call for scheduling, insurance checks, availability, patient verification, cancellations, or office facts. ",
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
