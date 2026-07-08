import { describe, expect, it } from "vitest";
import {
  fallbackLLMOptions,
  getLlmOptions,
  primaryLLMOptions,
} from "../model-config.js";

describe("LLM model config", () => {
  it("uses GLM 5.2 as the primary Baseten model with GLM 4.7 fallback", () => {
    expect(primaryLLMOptions.model).toBe("zai-org/GLM-5.2");
    expect(fallbackLLMOptions.model).toBe("zai-org/GLM-4.7");
  });

  it("uses the same primary and fallback models for every trunk", () => {
    expect(getLlmOptions().primary).toBe(primaryLLMOptions);
    expect(getLlmOptions().fallback).toBe(fallbackLLMOptions);
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
