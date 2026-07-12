import { tool } from "@livekit/agents";
import { z } from "zod";
import { transferCallerToOffice } from "./handoff.js";
import { getState } from "./session.js";

export const transfer_call = tool({
  name: "transfer_call",
  description:
    "Transfer the caller to office staff only when their request truly needs a live human or is outside the agent's front-desk scope. " +
    "If they ask for a human, representative, staff, or the office without saying why, ask what they are calling about before calling this tool. " +
    "Before calling this tool, briefly tell the caller you're transferring them now. " +
    "Call this for emergency or urgent symptoms, suspected medication reactions, dosage or medication instructions, clinical advice, medical decisions, returned missed calls or received calls from this number, failed staff task creation, or when the caller still insists after you try to help. " +
    "If create_staff_task is available, use that instead for safe non-live office work like billing questions, records/forms requests, optical order status, named-person messages, or routine medication and prescription requests such as refills, status checks, and pharmacy updates. " +
    "Do not call for scheduling, insurance checks, availability, patient verification, cancellations, or office facts. ",
  parameters: z.object({}),
  execute: async (_, { ctx }) => {
    const state = getState(ctx);
    ctx.disallowInterruptions();

    if (state.runtime.transferred) {
      return "Transfer already started.";
    }
    if (!state.runtime.sipRoomName || !state.runtime.sipParticipantIdentity) {
      return "Could not transfer because there is no active SIP session.";
    }

    try {
      await ctx.waitForPlayout();
      const { handoffOfficeKey } = await transferCallerToOffice(state);
      state.runtime.transferred = true;
      return `Transfer started to the ${handoffOfficeKey} office.`;
    } catch (err) {
      console.error("[tools] Transfer failed:", err);
      return "Could not transfer the call.";
    }
  },
});
