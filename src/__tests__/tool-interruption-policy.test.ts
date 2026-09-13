import { ToolContext, type RunContext } from "@livekit/agents";
import { describe, expect, it } from "vitest";
import { getOfficeProfiles } from "../customers/abita/profile.js";
import { buildToolsForTrunk } from "../runtime/tool-registry.js";
import type { CallState } from "../state/call-state.js";
import { createTestCallState } from "./support/call-state.js";
import { InMemoryOwnedMiddleware } from "./support/owned-middleware.js";
import { createToolContext } from "./support/tool-context.js";

describe("tool interruption policy", () => {
  it.each(getOfficeProfiles())(
    "$key stateful tools disable interruptions before doing work",
    async (office) => {
      const tools = new ToolContext(
        buildToolsForTrunk(
          new InMemoryOwnedMiddleware(),
          office.trunkPhones[0],
        ),
      );
      const stop = new Error("interruptions disabled");
      const ctx = createToolContext(createTestCallState());
      ctx.disallowInterruptions.mockImplementation(() => {
        throw stop;
      });

      for (const registeredTool of Object.values(tools.functionTools)) {
        // LiveKit owns end_call. Knowledge search is read-only and cancellable;
        // every existing stateful tool retains the interruption guard.
        if (["end_call", "search_office_knowledge"].includes(registeredTool.id))
          continue;
        await expect(
          registeredTool.execute(
            {},
            {
              ctx: ctx as unknown as RunContext<CallState>,
              toolCallId: registeredTool.id,
              abortSignal: new AbortController().signal,
            },
          ),
          registeredTool.id,
        ).rejects.toBe(stop);
      }
    },
  );
});
