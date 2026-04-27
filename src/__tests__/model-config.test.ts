import { describe, expect, it } from "vitest";
import { fallbackLLMOptions, primaryLLMOptions } from "../model-config.js";

describe("LLM model config", () => {
  it("uses DeepSeek V4 Pro as the primary Baseten model", () => {
    expect(primaryLLMOptions.model).toBe("deepseek-ai/DeepSeek-V4-Pro");
    expect(fallbackLLMOptions.model).toBe("MiniMaxAI/MiniMax-M2.5");
  });

  it("keeps voice-agent generation options aligned across primary and fallback models", () => {
    expect(primaryLLMOptions.parallelToolCalls).toBe(false);
    expect(fallbackLLMOptions.parallelToolCalls).toBe(false);
    expect(primaryLLMOptions.temperature).toBe(fallbackLLMOptions.temperature);
    expect(primaryLLMOptions.topP).toBe(fallbackLLMOptions.topP);
  });
});
