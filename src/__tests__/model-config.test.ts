import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLlmPair,
  fallbackLLMOptions,
  getLlmOptions,
  primaryLLMOptions,
} from "../model-config.js";

describe("LLM model config", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("uses Luna 5.6 through LiveKit Inference with GLM 4.7 fallback", () => {
    vi.stubEnv("LIVEKIT_API_KEY", "test-key");
    vi.stubEnv("LIVEKIT_API_SECRET", "test-secret");
    vi.stubEnv("BASETEN_API_KEY", "test-key");

    const { primary, fallback } = createLlmPair();

    expect(primary.label()).toBe("inference.LLM");
    expect(primary.model).toBe("openai/gpt-5.6-luna");
    expect(fallback.label()).toBe("baseten.LLM");
    expect(fallback.model).toBe("zai-org/GLM-4.7");
  });

  it("uses the same primary and fallback models for every trunk", () => {
    expect(getLlmOptions().primary).toBe(primaryLLMOptions);
    expect(getLlmOptions().fallback).toBe(fallbackLLMOptions);
  });

  it("caps spoken response length and disables parallel tool calls", () => {
    expect(primaryLLMOptions.modelOptions).toEqual({
      max_completion_tokens: 512,
      parallel_tool_calls: false,
    });
    expect(fallbackLLMOptions.maxTokens).toBe(512);
    expect(fallbackLLMOptions.parallelToolCalls).toBe(false);
    expect(Object.keys(primaryLLMOptions)).toEqual(["model", "modelOptions"]);
    expect(Object.keys(fallbackLLMOptions)).toEqual([
      "maxTokens",
      "model",
      "parallelToolCalls",
    ]);
  });
});
