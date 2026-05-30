import { llm } from "@livekit/agents";
import { z } from "zod";
import { transferCallerToOffice } from "./handoff.js";
import { disableInterruptionsForWrite, getState } from "./session.js";

export const transfer_call = llm.tool({
  description:
    "Transfer the SIP caller to the office. Before calling, say: \"I'm going to transfer you to the office now. " +
    'They may be with a patient, so please leave a message and we will get back to you as soon as possible." ' +
    "Then call this once. Do not call in parallel. " +
    "After success, the SIP session disconnects and your turn is over.",
  parameters: z.object({}),
  execute: async (_, { ctx }) => {
    const state = getState(ctx);
    const speechReady = disableInterruptionsForWrite(ctx);
    if (state.runtime.transferred || state.runtime.transferInFlight) {
      return {
        outcome: "success",
        speak: "Transfer already started. No action needed.",
        facts: { reason: "transfer_already_started" },
        retryable: false,
      };
    }
    if (state.runtime.transferAttempted) {
      return {
        outcome: "not_allowed",
        speak:
          "Transfer was already attempted. Do not call transfer_call again.",
        facts: { reason: "transfer_already_attempted" },
        retryable: false,
      };
    }
    if (!speechReady) {
      return {
        outcome: "not_allowed",
        speak:
          "Transfer was interrupted before it could start. Do not call transfer_call again until the caller asks for transfer again.",
        facts: { reason: "speech_interrupted" },
        retryable: false,
      };
    }
    state.runtime.transferAttempted = true;
    state.runtime.transferInFlight = true;
    try {
      await ctx.waitForPlayout();
      if (!state.runtime.sipRoomName || !state.runtime.sipParticipantIdentity) {
        state.runtime.transferInFlight = false;
        return {
          outcome: "error",
          speak: "Could not transfer - no active SIP session.",
          facts: { reason: "missing_sip_session" },
          retryable: false,
        };
      }
      const { handoffOfficeKey, handoffTarget } =
        await transferCallerToOffice(state);
      state.runtime.transferred = true;
      state.runtime.transferInFlight = false;
      console.log(
        `[tools] Transferred ${state.runtime.sipParticipantIdentity} to ${handoffTarget}`,
      );
      return {
        outcome: "success",
        speak: "Transfer initiated successfully.",
        facts: {
          handoffOfficeKey,
        },
        retryable: false,
      };
    } catch (err) {
      state.runtime.transferInFlight = false;
      console.error("[tools] Transfer failed:", err);
      return {
        outcome: "error",
        speak: "Could not transfer the call. Do not call transfer_call again.",
        facts: { reason: "transfer_failed" },
        retryable: false,
      };
    }
  },
});
