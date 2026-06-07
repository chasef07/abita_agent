import { llm } from "@livekit/agents";
import { z } from "zod";
import { transferCallerToOffice } from "./handoff.js";
import { getState } from "./session.js";

const TRANSFER_NOTICE = "One moment while I transfer you.";

export const transfer_call = llm.tool({
  description:
    "Transfer the caller to office staff when they ask for a human, or when their request is outside the agent's front-desk scope. " +
    "Call this for prescription questions, medical records, surgery coordination, clinical or emergency symptoms, asking for a specific person, returning a missed call or received call from this number, status of glasses or contacts already ordered, or when the caller still insists after you try to help. " +
    "Do not call for scheduling, insurance checks, availability, patient verification, cancellations, office facts, or Crystal River-to-Spring Hill routing. ",
  parameters: z.object({}),
  execute: async (_, { ctx }) => {
    const state = getState(ctx);
    ctx.speechHandle.allowInterruptions = false;

    if (state.runtime.transferred) {
      return "Transfer already started.";
    }
    if (!state.runtime.sipRoomName || !state.runtime.sipParticipantIdentity) {
      return "Could not transfer because there is no active SIP session.";
    }

    try {
      const transferNotice = ctx.session.say(TRANSFER_NOTICE, {
        allowInterruptions: false,
      });
      await transferNotice.waitForPlayout();
      const { handoffOfficeKey } = await transferCallerToOffice(state);
      state.runtime.transferred = true;
      return `Transfer started to the ${handoffOfficeKey} office.`;
    } catch (err) {
      console.error("[tools] Transfer failed:", err);
      return "Could not transfer the call.";
    }
  },
});
