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
    vi.stubEnv("BASETEN_API_KEY", "");
    vi.stubEnv("LIVEKIT_API_KEY", "test-key");
    vi.stubEnv("LIVEKIT_API_SECRET", "test-secret");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("uses Gemma 4 with DeepSeek V4 Pro fallback through LiveKit Inference without Baseten credentials", () => {
    const { primary, fallback } = createLlmPair();

    expect(primary.label()).toBe("inference.LLM");
    expect(primary.model).toBe("google/gemma-4-31b-it");
    expect(fallback.label()).toBe("inference.LLM");
    expect(fallback.model).toBe("deepseek-ai/deepseek-v4-pro");
  });

  it("caps spoken responses and enables sequential strict tool calls", () => {
    expect(primaryLLMOptions).toEqual({
      model: "google/gemma-4-31b-it",
      modelOptions: {
        max_completion_tokens: 512,
        parallel_tool_calls: false,
      },
      strictToolSchema: true,
    });
    expect(fallbackLLMOptions).toEqual({
      model: "deepseek-ai/deepseek-v4-pro",
      modelOptions: {
        reasoning_effort: "low",
        max_tokens: 512,
        parallel_tool_calls: false,
      },
      strictToolSchema: true,
    });
  });

  it("sends the model and tool settings through the LiveKit adapters", async () => {
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
          body: JSON.parse(init?.body as string),
        };
      });
      expect(requests[0].body.model).toBe("google/gemma-4-31b-it");
      expect(requests[1].body.model).toBe("deepseek-ai/deepseek-v4-pro");
      expect(requests[0].body).not.toHaveProperty("reasoning_effort");
      expect(requests[1].body.reasoning_effort).toBe("low");
      expect(requests[0].body.max_completion_tokens).toBe(512);
      expect(requests[1].body.max_tokens).toBe(512);
      for (const { url } of requests) {
        expect(new URL(url).hostname).toBe("agent-gateway.livekit.cloud");
      }
      for (const { body } of requests) {
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
