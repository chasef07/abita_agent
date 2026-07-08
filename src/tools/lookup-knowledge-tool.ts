import { tool } from "@livekit/agents";
import { z } from "zod";
import { activeOfficeKey } from "../state/call-state.js";
import { lookupOfficeKnowledge } from "./knowledge.js";
import { getState } from "./session.js";

export const lookup_knowledge = tool({
  name: "lookup_knowledge",
  description:
    "Look up office facts before answering general practice questions about address, hours, providers, services, what to bring, phone, fax, or appointment expectations. ",
  parameters: z.object({
    question: z.string().describe("The caller's office-fact question"),
  }),
  execute: async ({ question }, { ctx }) => {
    const state = getState(ctx);
    ctx.disallowInterruptions();
    return lookupOfficeKnowledge(activeOfficeKey(state), question);
  },
});
