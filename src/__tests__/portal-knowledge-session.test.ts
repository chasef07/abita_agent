import {
  AgentSession,
  type ChatContext,
  initializeLogger,
  voice,
} from "@livekit/agents";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVoiceAgent } from "../agent.js";
import { getOfficeProfiles } from "../customers/abita/profile.js";
import { createTestCallState } from "./support/call-state.js";
import { InMemoryOwnedMiddleware } from "./support/owned-middleware.js";

class CapturingModel extends voice.testing.FakeLLM {
  readonly requests: ChatContext[] = [];
  override chat(options: Parameters<voice.testing.FakeLLM["chat"]>[0]) {
    this.requests.push(options.chatCtx.copy());
    return super.chat(options);
  }
  override lookup(input: string) {
    if (input.startsWith('"{\\"outcome\\":'))
      return { input, content: "The office closes at 4:30 PM on weekdays." };
    return super.lookup(input);
  }
}

describe("Portal knowledge through AgentSession", () => {
  initializeLogger({ pretty: false, level: "silent" });
  const sessions: AgentSession[] = [];
  afterEach(async () => {
    await Promise.all(sessions.splice(0).map((session) => session.close()));
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
  it.each(getOfficeProfiles())(
    "delivers $key current revision facts through the actual query-only tool to the next model request",
    async (office) => {
      vi.stubEnv(
        "ACUITY_PRODUCT_KNOWLEDGE_URL",
        "https://product.example/v1/agent/knowledge/search",
      );
      vi.stubEnv("ABITA_EYE_GROUP_PRODUCT_SERVICE_SECRET", "test-secret");
      vi.stubEnv("ACUITY_DEMO_PRODUCT_SERVICE_SECRET", "demo-secret");
      const fetch = vi.fn().mockResolvedValue(
        Response.json({
          outcome: "found",
          revisionId: "revision-1",
          passages: [
            {
              revisionId: "revision-1",
              sectionId: "hours",
              title: "Hours",
              text: "Monday–Friday 8:30 AM–4:30 PM. Closed Saturday and Sunday.",
            },
          ],
        }),
      );
      vi.stubGlobal("fetch", fetch);
      const query = "When does everyone head home for the day?";
      const llm = new CapturingModel([
        {
          input: query,
          toolCalls: [{ name: "search_office_knowledge", args: { query } }],
        },
      ]);
      const session = new AgentSession({ llm });
      sessions.push(session);
      session.userData = createTestCallState({
        officeKey: office.key,
        trunkPhone: office.trunkPhones[0]!,
        amdOfficePhone: office.amdOfficePhone,
      });
      await session.start({
        agent: createVoiceAgent(office.trunkPhones[0]!, {
          ownedMiddleware: new InMemoryOwnedMiddleware(),
          suppressGreeting: true,
        }).agent,
      });
      await session.run({ userInput: query }).wait();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch.mock.calls[0]![1].headers["X-Office-Key"]).toBe(office.key);
      const consumed = llm.requests.flatMap((request) =>
        request.items.filter(
          (item) =>
            item.type === "function_call_output" &&
            item.name === "search_office_knowledge",
        ),
      );
      expect(consumed.length).toBeGreaterThan(0);
      expect(JSON.stringify(consumed)).toContain("revision-1");
      expect(JSON.stringify(consumed)).toContain("4:30 PM");
      const beforeFollowup = llm.requests.length;
      await session.run({ userInput: "And Saturdays?" }).wait();
      const nextRequest = llm.requests[beforeFollowup]!;
      const retained = nextRequest.items.filter(
        (item) =>
          (item.type === "function_call" ||
            item.type === "function_call_output") &&
          item.name === "search_office_knowledge",
      );
      expect(retained.map((item) => item.type)).toEqual([
        "function_call",
        "function_call_output",
      ]);
      expect(JSON.stringify(retained)).toContain("revision-1");
      expect(JSON.stringify(retained)).toContain("Closed Saturday and Sunday");
      expect(
        session.currentAgent.chatCtx.items.some(
          (item) =>
            item.type === "message" &&
            item.role === "assistant" &&
            item.textContent?.includes("closes at 4:30 PM"),
        ),
      ).toBe(true);
    },
  );
});
