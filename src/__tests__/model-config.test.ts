import { describe, expect, it } from "vitest";
import {
  cartesiaTTSOptions,
  fallbackLLMOptions,
  primaryLLMOptions,
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

  it("uses the Cartesia plugin options for TTS", () => {
    expect(cartesiaTTSOptions).toMatchObject({
      model: "sonic-3",
      voice: "9626c31c-bec5-4cca-baa8-f8ba9e84c8bc",
      sampleRate: 16000,
      speed: 0.92,
      volume: 0.85,
      apiVersion: "2026-03-01",
    });
  });
});
