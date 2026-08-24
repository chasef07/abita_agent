import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLlmPair,
  fallbackLLMOptions,
  primaryLLMOptions,
} from "../model-config.js";

describe("LLM model config", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("uses Gemma 4 with Grok 4.5 fallback through LiveKit Inference", () => {
    vi.stubEnv("LIVEKIT_API_KEY", "test-key");
    vi.stubEnv("LIVEKIT_API_SECRET", "test-secret");

    const { primary, fallback } = createLlmPair();

    expect(primary.label()).toBe("inference.LLM");
    expect(primary.model).toBe("google/gemma-4-31b-it");
    expect(fallback.label()).toBe("inference.LLM");
    expect(fallback.model).toBe("xai/grok-4.5");
  });

  it("caps spoken responses and enables sequential strict tool calls", () => {
    expect(primaryLLMOptions.modelOptions.max_completion_tokens).toBe(512);
    expect(primaryLLMOptions.modelOptions.parallel_tool_calls).toBe(false);
    expect(primaryLLMOptions.strictToolSchema).toBe(true);
    expect(fallbackLLMOptions.modelOptions.max_completion_tokens).toBe(512);
    expect(fallbackLLMOptions.modelOptions.parallel_tool_calls).toBe(false);
    expect(fallbackLLMOptions.strictToolSchema).toBe(true);
    expect(Object.keys(primaryLLMOptions)).toEqual([
      "model",
      "modelOptions",
      "strictToolSchema",
    ]);
    expect(Object.keys(fallbackLLMOptions)).toEqual([
      "model",
      "modelOptions",
      "strictToolSchema",
    ]);
  });
});
