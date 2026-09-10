import { type ToolOptions } from "@livekit/agents";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSearchOfficeKnowledgeTool } from "../tools/search-office-knowledge.js";
import { createTestCallState } from "./support/call-state.js";
import { createToolContext } from "./support/tool-context.js";

function options(
  state = createTestCallState(),
  signal = new AbortController().signal,
) {
  return {
    ctx: createToolContext(state),
    toolCallId: "knowledge-test",
    abortSignal: signal,
  } as unknown as ToolOptions;
}
const result = {
  outcome: "found",
  revisionId: "revision-1",
  passages: [
    {
      revisionId: "revision-1",
      sectionId: "hours",
      title: "Hours",
      text: "Monday–Friday 8:30 AM–4:30 PM. Closed weekends.",
    },
  ],
};

describe("Portal office knowledge tool", () => {
  beforeEach(() => {
    vi.stubEnv("ACUITY_PRODUCT_KNOWLEDGE_PILOT", "spring-hill");
    vi.stubEnv(
      "ACUITY_PRODUCT_KNOWLEDGE_URL",
      "https://product.example/v1/agent/knowledge/search",
    );
    vi.stubEnv("ABITA_EYE_GROUP_PRODUCT_SERVICE_SECRET", "test-service-secret");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  it("sends only the question under the trusted active office and tenant credential", async () => {
    vi.stubEnv("ACUITY_PRODUCT_KNOWLEDGE_PILOT", "spring-hill");
    vi.stubEnv(
      "ACUITY_PRODUCT_KNOWLEDGE_URL",
      "https://product.example/v1/agent/knowledge/search",
    );
    vi.stubEnv("ABITA_EYE_GROUP_PRODUCT_SERVICE_SECRET", "test-service-secret");
    const fetch = vi.fn().mockResolvedValue(Response.json(result));
    vi.stubGlobal("fetch", fetch);
    const answer = JSON.parse(
      await createSearchOfficeKnowledgeTool().execute(
        { query: "When does everyone head home for the day?" },
        options(),
      ),
    );
    expect(answer.outcome).toBe("found");
    expect(answer.passages).toEqual(result.passages);
    const [url, request] = fetch.mock.calls[0]!;
    expect(url).toBe("https://product.example/v1/agent/knowledge/search");
    expect(request.headers).toMatchObject({
      Authorization: "Bearer test-service-secret",
      "X-Office-Key": "spring-hill",
    });
    expect(JSON.parse(request.body)).toEqual({
      query: "When does everyone head home for the day?",
    });
    expect(answer.guidance).toContain("untrusted");
  });
  it.each(["network", "http", "invalid", "mixed-revision"])(
    "keeps failure visible without file fallback: %s",
    async (failure) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation(async () => {
          if (failure === "network")
            throw new Error("provider error with sensitive details");
          if (failure === "http")
            return new Response("sensitive backend details", { status: 503 });
          if (failure === "invalid")
            return Response.json({ outcome: "found", passages: [] });
          return Response.json({ ...result, revisionId: "other-revision" });
        }),
      );
      const state = createTestCallState();
      const answer = JSON.parse(
        await createSearchOfficeKnowledgeTool().execute(
          { query: "What are your hours?" },
          options(state),
        ),
      );
      expect(answer.outcome).toBe("temporary_failure");
      expect(answer.passages).toEqual([]);
      expect(JSON.stringify(answer)).not.toContain("4:30");
      expect(JSON.stringify(state.runtime.knowledgeRetrievals)).not.toContain(
        "hours?",
      );
    },
  );

  it("distinguishes no relevant information from temporary failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          outcome: "no_relevant_information",
          revisionId: "revision-1",
          passages: [],
        }),
      ),
    );
    const answer = JSON.parse(
      await createSearchOfficeKnowledgeTool().execute(
        { query: "Do you offer valet parking?" },
        options(),
      ),
    );
    expect(answer.outcome).toBe("no_relevant_information");
  });

  it("bounds the network request by a four-second deadline", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation(
          (_url, init) =>
            new Promise((_resolve, reject) =>
              init.signal.addEventListener("abort", () =>
                reject(new Error("aborted")),
              ),
            ),
        ),
    );
    // AbortSignal.timeout uses Node's native timer, so spy only on the deadline factory.
    const deadline = new AbortController();
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(deadline.signal);
    try {
      const pending = createSearchOfficeKnowledgeTool().execute(
        { query: "What are your hours?" },
        options(),
      );
      expect(timeout).toHaveBeenCalledWith(4000);
      deadline.abort();
      expect(JSON.parse(await pending).outcome).toBe("temporary_failure");
    } finally {
      timeout.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each(["call-ended", "office-changed", "office-changed-back"])(
    "discards late results after %s",
    async (reason) => {
      const { activateOffice } = await import("../state/call-lifecycle.js");
      const { getOfficeProfile } =
        await import("../customers/abita/profile.js");
      const state = createTestCallState();
      const controller = new AbortController();
      let finish!: (response: Response) => void;
      const fetch = vi.fn().mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      );
      vi.stubGlobal("fetch", fetch);
      const pending = createSearchOfficeKnowledgeTool().execute(
        { query: "What are your hours?" },
        options(state, controller.signal),
      );
      if (reason === "call-ended") controller.abort();
      else {
        activateOffice(state, getOfficeProfile("crystal-river"));
        if (reason === "office-changed-back")
          activateOffice(state, getOfficeProfile("spring-hill"));
      }
      expect(fetch.mock.calls[0]![1].signal.aborted).toBe(true);
      finish(Response.json(result));
      expect(JSON.parse(await pending).outcome).toBe("temporary_failure");
      expect(state.runtime.knowledgeRetrievals[0]!.sectionCount).toBe(0);
    },
  );

  it.each([
    "Email jane@example.test about hours",
    "Hours for 01/01/1980",
    "Call +1 555 010 1234",
    "x".repeat(501),
  ])(
    "rejects identifiers or excessive query content before network access",
    async (query) => {
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      expect(
        JSON.parse(
          await createSearchOfficeKnowledgeTool().execute({ query }, options()),
        ).outcome,
      ).toBe("temporary_failure");
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("rejects a non-pilot runtime office before network access", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const state = createTestCallState({ officeKey: "crystal-river" });
    expect(
      JSON.parse(
        await createSearchOfficeKnowledgeTool().execute(
          { query: "What are your hours?" },
          options(state),
        ),
      ).outcome,
    ).toBe("temporary_failure");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("Portal authority at the agent boundary", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("exposes the query-only tool and removes file facts only for the explicit pilot", async () => {
    const { createVoiceAgent } = await import("../agent.js");
    const { SPRING_HILL_OFFICE_PHONE, CRYSTAL_RIVER_OFFICE_PHONE } =
      await import("../customers/abita/profile.js");
    const { InMemoryOwnedMiddleware } =
      await import("./support/owned-middleware.js");
    const { isFunctionTool } = await import("@livekit/agents");
    vi.stubEnv("ACUITY_PRODUCT_KNOWLEDGE_PILOT", "spring-hill");
    const pilot = createVoiceAgent(SPRING_HILL_OFFICE_PHONE, {
      ownedMiddleware: new InMemoryOwnedMiddleware(),
      suppressGreeting: true,
    }).agent;
    const other = createVoiceAgent(CRYSTAL_RIVER_OFFICE_PHONE, {
      ownedMiddleware: new InMemoryOwnedMiddleware(),
      suppressGreeting: true,
    }).agent;
    const search = pilot.toolCtx.tools.find(
      (t) => isFunctionTool(t) && t.name === "search_office_knowledge",
    );
    expect(search).toBeDefined();
    expect(pilot.instructions).toContain(
      "call search_office_knowledge before answering",
    );
    expect(pilot.instructions).not.toContain("We are closed on weekends");
    expect(pilot.instructions).not.toContain("readiness text confirms");
    expect(
      other.toolCtx.tools.some(
        (t) => isFunctionTool(t) && t.name === "search_office_knowledge",
      ),
    ).toBe(false);
    expect(other.instructions).toContain("We are closed on weekends");
  });
});
