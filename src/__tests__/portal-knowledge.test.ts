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
  it.each([
    ["spring-hill", "production-secret"],
    ["crystal-river", "production-secret"],
    ["hollywood", "production-secret"],
    ["sweetwater", "production-secret"],
    ["north-miami-beach-optical", "production-secret"],
    ["ophthalmology-demo", "demo-secret"],
    ["new-tampa-demo", "demo-secret"],
    ["rheumatology-demo", "demo-secret"],
  ] as const)(
    "searches %s with its trusted route and tenant credential",
    async (officeKey, secret) => {
      vi.stubEnv("ABITA_EYE_GROUP_PRODUCT_SERVICE_SECRET", "production-secret");
      vi.stubEnv("ACUITY_DEMO_PRODUCT_SERVICE_SECRET", "demo-secret");
      const fetch = vi.fn().mockResolvedValue(Response.json(result));
      vi.stubGlobal("fetch", fetch);
      const answer = await createSearchOfficeKnowledgeTool().execute(
        { query: "What are your hours?" },
        options(createTestCallState({ officeKey })),
      );
      expect(answer).toBe(result.passages[0]!.text);
      expect(fetch.mock.calls[0]![1].headers).toMatchObject({
        Authorization: `Bearer ${secret}`,
        "X-Office-Key": officeKey,
      });
      expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({
        query: "What are your hours?",
      });
    },
  );
  it("keeps distinct demo routes separate despite their shared middleware phone", async () => {
    const { getOfficeProfile } = await import("../customers/abita/profile.js");
    const { activateOffice } = await import("../state/call-lifecycle.js");
    const first = getOfficeProfile("new-tampa-demo");
    const next = getOfficeProfile("ophthalmology-demo");
    expect(first.amdOfficePhone).toBe(next.amdOfficePhone);
    vi.stubEnv("ACUITY_DEMO_PRODUCT_SERVICE_SECRET", "demo-secret");
    const fetch = vi.fn().mockImplementation(async (_url, request) => {
      const revisionId = `revision-${request.headers["X-Office-Key"]}`;
      return Response.json({
        ...result,
        revisionId,
        passages: result.passages.map((passage) => ({
          ...passage,
          revisionId,
          text: `Hours for ${request.headers["X-Office-Key"]}.`,
        })),
      });
    });
    vi.stubGlobal("fetch", fetch);
    const state = createTestCallState({
      officeKey: first.key,
    });
    const tool = createSearchOfficeKnowledgeTool();
    const firstResult = await tool.execute(
      { query: "What are your hours?" },
      options(state),
    );
    activateOffice(state, next);
    const nextResult = await tool.execute(
      { query: "What are your hours?" },
      options(state),
    );
    expect(firstResult).toBe("Hours for new-tampa-demo.");
    expect(nextResult).toBe("Hours for ophthalmology-demo.");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("cannot widen the runtime route using extra model-supplied scope", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json(result));
    vi.stubGlobal("fetch", fetch);
    await createSearchOfficeKnowledgeTool().execute(
      {
        query: "What are your hours?",
        officeKey: "rheumatology-demo",
        practiceId: "other-practice",
      } as never,
      options(),
    );
    expect(fetch.mock.calls[0]![1].headers["X-Office-Key"]).toBe("spring-hill");
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({
      query: "What are your hours?",
    });
  });

  it("sends only the question under the trusted active office and tenant credential", async () => {
    vi.stubEnv(
      "ACUITY_PRODUCT_KNOWLEDGE_URL",
      "https://product.example/v1/agent/knowledge/search",
    );
    vi.stubEnv("ABITA_EYE_GROUP_PRODUCT_SERVICE_SECRET", "test-service-secret");
    const fetch = vi.fn().mockResolvedValue(Response.json(result));
    vi.stubGlobal("fetch", fetch);
    const answer = await createSearchOfficeKnowledgeTool().execute(
      { query: "When does everyone head home for the day?" },
      options(),
    );
    expect(answer).toBe(result.passages[0]!.text);
    const [url, request] = fetch.mock.calls[0]!;
    expect(url).toBe("https://product.example/v1/agent/knowledge/search");
    expect(request.headers).toMatchObject({
      Authorization: "Bearer test-service-secret",
      "X-Office-Key": "spring-hill",
    });
    expect(JSON.parse(request.body)).toEqual({
      query: "When does everyone head home for the day?",
    });
    expect(answer).not.toMatch(
      /revisionId|sectionId|officeKey|outcome|passages/,
    );
  });
  it.each(["available", "not-supplied", "not-offered"])(
    "returns only answer text while removing a legacy leading %s marker",
    async (status) => {
      const text =
        "This service is not offered. Status: available is part of an explanation.";
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          Response.json({
            ...result,
            passages: [
              { ...result.passages[0]!, text: `Status: ${status}\n${text}` },
            ],
          }),
        ),
      );
      expect(
        await createSearchOfficeKnowledgeTool().execute(
          { query: "Is this service offered?" },
          options(),
        ),
      ).toBe(text);
    },
  );

  it("does not report an empty answer after removing a legacy marker", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          ...result,
          passages: [{ ...result.passages[0]!, text: "Status: available" }],
        }),
      ),
    );
    expect(
      await createSearchOfficeKnowledgeTool().execute(
        { query: "What are your hours?" },
        options(),
      ),
    ).toBe("Office knowledge is temporarily unavailable.");
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
      const answer = await createSearchOfficeKnowledgeTool().execute(
        { query: "What are your hours?" },
        options(state),
      );
      expect(answer).toBe("Office knowledge is temporarily unavailable.");
      expect(answer).not.toContain("revision-1");
      expect(JSON.stringify(answer)).not.toContain("4:30");
      expect(JSON.stringify(answer)).not.toContain("hours?");
    },
  );

  it.each([8, 9])("validates the Product passage limit: %i", async (count) => {
    const passages = Array.from({ length: count }, (_, index) => ({
      ...result.passages[0]!,
      sectionId: `section-${index}`,
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ ...result, passages })),
    );
    const answer = await createSearchOfficeKnowledgeTool().execute(
      { query: "What are your office policies?" },
      options(),
    );
    expect(answer).toBe(
      count === 8
        ? passages.map((p) => p.text).join("\n")
        : "Office knowledge is temporarily unavailable.",
    );
  });

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
    const answer = await createSearchOfficeKnowledgeTool().execute(
      { query: "Do you offer valet parking?" },
      options(),
    );
    expect(answer).toBe(
      "No relevant office information was found for this question.",
    );
  });

  it("allows caller interruption while the read-only search is in flight", async () => {
    const ctx = createToolContext(createTestCallState());
    const controller = new AbortController();
    const fetch = vi.fn().mockImplementation(async () => {
      expect(ctx.speechHandle.allowInterruptions).toBe(true);
      controller.abort();
      return Response.json(result);
    });
    vi.stubGlobal("fetch", fetch);
    const answer = await createSearchOfficeKnowledgeTool().execute(
      { query: "What are your hours?" },
      {
        ctx,
        toolCallId: "knowledge-test",
        abortSignal: controller.signal,
      } as unknown as ToolOptions,
    );
    expect(answer).toBe("Office knowledge is temporarily unavailable.");
    expect(ctx.disallowInterruptions).not.toHaveBeenCalled();
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
      expect(await pending).toBe(
        "Office knowledge is temporarily unavailable.",
      );
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
      const answer = await pending;
      expect(answer).toBe("Office knowledge is temporarily unavailable.");
      expect(answer).not.toContain("revision-1");
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
        await createSearchOfficeKnowledgeTool().execute({ query }, options()),
      ).toBe("Office knowledge is temporarily unavailable.");
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("reports missing configuration without reading files", async () => {
    vi.stubEnv("ACUITY_PRODUCT_KNOWLEDGE_URL", "");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const state = createTestCallState({ officeKey: "crystal-river" });
    expect(
      await createSearchOfficeKnowledgeTool().execute(
        { query: "What are your hours?" },
        options(state),
      ),
    ).toBe("Office knowledge is temporarily unavailable.");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("Portal authority at the agent boundary", () => {
  it("exposes office knowledge with dedicated Frantz lookup guidance", async () => {
    const { createVoiceAgent } = await import("../agent.js");
    const { getOfficeProfiles } = await import("../customers/abita/profile.js");
    const { InMemoryOwnedMiddleware } =
      await import("./support/owned-middleware.js");
    const { isFunctionTool } = await import("@livekit/agents");
    for (const office of getOfficeProfiles()) {
      const agent = createVoiceAgent(office.trunkPhones[0]!, {
        ownedMiddleware: new InMemoryOwnedMiddleware(),
        suppressGreeting: true,
      }).agent;
      expect(
        agent.toolCtx.tools.some(
          (t) => isFunctionTool(t) && t.name === "search_office_knowledge",
        ),
        office.key,
      ).toBe(true);
      if (office.key === "ophthalmology-demo") {
        expect(agent.instructions).toContain(
          "call search_office_knowledge. Do not guess order readiness or office policies.",
        );
      } else {
        expect(agent.instructions).not.toContain("search_office_knowledge");
      }
    }
  });
});
