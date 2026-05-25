import { describe, expect, it } from "vitest";
import { fallbackLLMOptions, primaryLLMOptions } from "../model-config.js";

describe("LLM model config", () => {
  it("uses GLM 5 as the primary Baseten model with MiniMax fallback", () => {
    expect(primaryLLMOptions.model).toBe("zai-org/GLM-5");
    expect(fallbackLLMOptions.model).toBe("MiniMaxAI/MiniMax-M2.5");
  });

  it("keeps voice-agent generation options aligned across primary and fallback models", () => {
    expect(primaryLLMOptions.parallelToolCalls).toBe(true);
    expect(fallbackLLMOptions.parallelToolCalls).toBe(true);
    expect(primaryLLMOptions.temperature).toBe(fallbackLLMOptions.temperature);
    expect(primaryLLMOptions.topP).toBe(fallbackLLMOptions.topP);
  });
});
