import { llm } from "@livekit/agents";
import { z } from "zod";
import { SPRING_HILL_OFFICE_PHONE } from "../customer/profile.js";
import { clearAvailabilitySelection } from "../state/call-state.js";
import { getState } from "./session.js";

export const route_to_spring_hill = llm.tool({
  description:
    "Switch scheduling to Spring Hill without transferring the caller. " +
    "Call this from Crystal River after the caller agrees to schedule a Spring Hill-only visit, such as pediatrics, cataract care, routine vision, or insurance accepted at Spring Hill but not Crystal River.",
  parameters: z.object({}),
  execute: async (_, { ctx }) => {
    const state = getState(ctx);
    ctx.speechHandle.allowInterruptions = false;

    state.runtime.officePhoneOverrides = {
      ...(state.runtime.officePhoneOverrides ?? {}),
      "spring-hill": SPRING_HILL_OFFICE_PHONE,
    };
    clearAvailabilitySelection(state);
    state.officeKey = "spring-hill";
    state.scheduling.routing = "all_three";

    return "Scheduling is now routed to Spring Hill. Continue without transferring the caller.";
  },
});
