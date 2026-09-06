import { initializeLogger, llm } from "@livekit/agents";
import { z } from "zod";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  createLlmPair,
  fallbackLLMOptions,
  primaryLLMOptions,
} from "../model-config.js";

describe("LLM model config", () => {
  beforeAll(() => initializeLogger({ pretty: false, level: "silent" }));

  beforeEach(() => {
    vi.stubEnv("BASETEN_API_KEY", "test-baseten-key");
    vi.stubEnv("LIVEKIT_API_KEY", "test-key");
    vi.stubEnv("LIVEKIT_API_SECRET", "test-secret");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("uses GLM 5.3 Flash on Baseten with Gemma 4 fallback through LiveKit Inference", () => {
    const { primary, fallback } = createLlmPair();

    expect(primary.provider).toBe("inference.baseten.co");
    expect(primary.model).toBe("zai-org/GLM-5.3-Flash");
    expect(fallback.label()).toBe("inference.LLM");
    expect(fallback.model).toBe("google/gemma-4-31b-it");
  });

  it("requires Baseten credentials instead of using an OpenAI key", () => {
    vi.stubEnv("BASETEN_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "unrelated-key");
    expect(() => createLlmPair()).toThrow(
      "BASETEN_API_KEY is required for the primary LLM",
    );
  });

  it("caps spoken responses and enables sequential strict tool calls", () => {
    expect(primaryLLMOptions).toEqual({
      model: "zai-org/GLM-5.3-Flash",
      baseURL: "https://inference.baseten.co/v1",
      reasoningEffort: "low",
      maxCompletionTokens: 512,
      parallelToolCalls: false,
      strictToolSchema: true,
    });
    expect(fallbackLLMOptions).toEqual({
      model: "google/gemma-4-31b-it",
      modelOptions: {
        max_completion_tokens: 512,
        parallel_tool_calls: false,
      },
      strictToolSchema: true,
    });
  });

  it("sends low reasoning and the existing tool settings through the real provider adapters", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      const chunk = {
        id: "synthetic-completion",
        object: "chat.completion.chunk",
        created: 0,
        choices: [
          { index: 0, delta: { content: "Hello." }, finish_reason: "stop" },
        ],
      };
      return new Response(
        `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,
        {
          headers: { "Content-Type": "text/event-stream" },
        },
      );
    });
    vi.stubGlobal("fetch", fetch);
    const { primary, fallback } = createLlmPair();
    const chatCtx = llm.ChatContext.empty();
    chatCtx.addMessage({ role: "user", content: "Hello." });
    const toolCtx = {
      lookup: llm.tool({
        description: "Synthetic lookup",
        parameters: z.object({ query: z.string() }),
        execute: async () => "Found",
      }),
    };

    try {
      for (const model of [primary, fallback]) {
        const response = await model.chat({ chatCtx, toolCtx }).collect();
        expect(response.text).toBe("Hello.");
      }
      expect(fetch).toHaveBeenCalledTimes(2);
      const requests = fetch.mock.calls.map(([url, init]) => {
        return {
          url: String(url),
          headers: new Headers(init?.headers),
          body: JSON.parse(init?.body as string),
        };
      });
      expect(requests[0].url).toBe(
        "https://inference.baseten.co/v1/chat/completions",
      );
      expect(requests[0].headers.get("authorization")).toBe(
        "Bearer test-baseten-key",
      );
      expect(requests[0].body.model).toBe("zai-org/GLM-5.3-Flash");
      expect(requests[0].body.reasoning_effort).toBe("low");
      expect(requests[1].body.model).toBe("google/gemma-4-31b-it");
      expect(requests[1].body).not.toHaveProperty("reasoning_effort");
      for (const { body } of requests) {
        expect(body.max_completion_tokens).toBe(512);
        expect(body.parallel_tool_calls).toBe(false);
        expect(body.tools[0].function.strict).toBe(true);
        expect(body.tools[0].function.parameters.additionalProperties).toBe(
          false,
        );
        expect(body).not.toHaveProperty("temperature");
        expect(body).not.toHaveProperty("top_p");
      }
    } finally {
      await primary.aclose();
      await fallback.aclose();
    }
  });
});
