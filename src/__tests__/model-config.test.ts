import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLlmPair,
  fallbackLLMOptions,
  primaryLLMOptions,
} from "../model-config.js";

describe("LLM model config", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("uses GLM 5.2 with GLM 4.7 fallback through Baseten", () => {
    vi.stubEnv("BASETEN_API_KEY", "test-key");

    const { primary, fallback } = createLlmPair();

    expect(primary.label()).toBe("baseten.LLM");
    expect(primary.model).toBe("zai-org/GLM-5.2");
    expect(fallback.label()).toBe("baseten.LLM");
    expect(fallback.model).toBe("zai-org/GLM-4.7");
  });

  it("caps spoken response length and disables parallel tool calls", () => {
    expect(primaryLLMOptions.maxTokens).toBe(512);
    expect(primaryLLMOptions.parallelToolCalls).toBe(false);
    expect(fallbackLLMOptions.maxTokens).toBe(512);
    expect(fallbackLLMOptions.parallelToolCalls).toBe(false);
    expect(Object.keys(primaryLLMOptions)).toEqual([
      "maxTokens",
      "model",
      "parallelToolCalls",
    ]);
    expect(Object.keys(fallbackLLMOptions)).toEqual([
      "maxTokens",
      "model",
      "parallelToolCalls",
    ]);
  });
});
