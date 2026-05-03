import { describe, expect, it } from "vitest";
import {
  fallbackLLMOptions,
  primaryLLMOptions,
  rimeTTSOptions,
} from "../model-config.js";

describe("model config", () => {
  it("uses GLM as the primary Baseten model with MiniMax fallback", () => {
    expect(primaryLLMOptions.model).toBe("zai-org/GLM-4.7");
    expect(fallbackLLMOptions.model).toBe("MiniMaxAI/MiniMax-M2.5");
  });

  it("keeps voice-agent generation options aligned across primary and fallback models", () => {
    expect(primaryLLMOptions.parallelToolCalls).toBe(false);
    expect(fallbackLLMOptions.parallelToolCalls).toBe(false);
    expect(primaryLLMOptions.temperature).toBe(fallbackLLMOptions.temperature);
    expect(primaryLLMOptions.topP).toBe(fallbackLLMOptions.topP);
  });

  it("uses the Rime plugin options for TTS", () => {
    expect(rimeTTSOptions).toMatchObject({
      modelId: "coda",
      speaker: "marlu",
      lang: "eng",
    });
  });
});
