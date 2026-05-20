import { describe, expect, it } from "vitest";
import { fallbackLLMOptions, primaryLLMOptions } from "../model-config.js";

describe("LLM model config", () => {
  it("uses GLM 5.1 as the primary Baseten model with DeepSeek fallback", () => {
    expect(primaryLLMOptions.model).toBe("zai-org/GLM-5.1");
    expect(fallbackLLMOptions.model).toBe("deepseek-ai/DeepSeek-V4-Pro");
  });

  it("keeps voice-agent generation options aligned across primary and fallback models", () => {
    expect(primaryLLMOptions.parallelToolCalls).toBe(false);
    expect(fallbackLLMOptions.parallelToolCalls).toBe(false);
    expect(primaryLLMOptions.temperature).toBe(fallbackLLMOptions.temperature);
    expect(primaryLLMOptions.topP).toBe(fallbackLLMOptions.topP);
  });
});
