import { llm } from "@livekit/agents";
import { z } from "zod";
import { activeOfficeKey } from "../state/call-state.js";
import { lookupOfficeKnowledge } from "./knowledge.js";
import { getState } from "./session.js";

export const lookup_knowledge = llm.tool({
  description:
    "Look up practice facts before answering questions about address, hours, location, providers, services, what to bring, phone, fax, or appointment expectations. " +
    "Call this even mid-call. Returns office-specific facts; answer naturally using only the relevant part.",
  parameters: z.object({
    question: z
      .string()
      .describe(
        "What the caller is asking about (e.g. 'office hours', 'do you see kids', 'what should I bring')",
      ),
  }),
  execute: async ({ question }, { ctx }) => {
    const state = getState(ctx);
    return lookupOfficeKnowledge(activeOfficeKey(state), question);
  },
});
