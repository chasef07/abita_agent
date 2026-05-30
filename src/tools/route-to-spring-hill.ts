import { llm } from "@livekit/agents";
import { z } from "zod";
import { SPRING_HILL_OFFICE_PHONE } from "../customer/profile.js";
import { clearAvailabilitySelection } from "../state/call-state.js";
import { disableInterruptionsForWrite, getState } from "./session.js";

export const route_to_spring_hill = llm.tool({
  description:
    "Switch the active scheduling office to Spring Hill without transferring the caller. " +
    "Use from Crystal River when the visit must be scheduled through Spring Hill, including pediatrics, cataract workup or surgery scheduling, routine vision, or insurance accepted there but not Crystal River. " +
    "Explain the routing and get agreement first. Returns the active Spring Hill office context.",
  parameters: z.object({}),
  execute: async (_, { ctx }) => {
    const state = getState(ctx);
    const speechReady = disableInterruptionsForWrite(ctx);
    if (!speechReady) {
      return {
        outcome: "not_allowed",
        speak:
          "Office routing was interrupted before it could be changed. Please confirm the routing again.",
        facts: { reason: "speech_interrupted" },
        retryable: true,
      };
    }
    const springHillOffice = SPRING_HILL_OFFICE_PHONE;
    state.runtime.officePhoneOverrides = {
      ...(state.runtime.officePhoneOverrides ?? {}),
      "spring-hill": springHillOffice,
    };
    clearAvailabilitySelection(state);
    state.officeKey = "spring-hill";
    state.scheduling.routing = "all_three";
    return {
      outcome: "success",
      speak: `AMD routing switched to Spring Hill (${springHillOffice}). Continue the call without transferring.`,
      facts: {
        officeKey: "spring-hill",
        amdOfficePhone: springHillOffice,
      },
      retryable: false,
    };
  },
});
