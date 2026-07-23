import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLlmPair,
  fallbackLLMOptions,
  getLlmOptions,
  primaryLLMOptions,
} from "../model-config.js";
import {
  CRYSTAL_RIVER_OFFICE_PHONE,
  DEV_OFFICE_PHONE,
  SPRING_HILL_813_TRUNK_PHONE,
  SPRING_HILL_OFFICE_PHONE,
} from "../customers/abita/profile.js";

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

  it("uses Inkling through Baseten for the demo and Spring Hill trunks", () => {
    vi.stubEnv("BASETEN_API_KEY", "test-key");

    const demo = createLlmPair(DEV_OFFICE_PHONE);
    const springHill = createLlmPair(SPRING_HILL_OFFICE_PHONE);
    const springHill813 = createLlmPair(SPRING_HILL_813_TRUNK_PHONE);
    const crystalRiver = createLlmPair(CRYSTAL_RIVER_OFFICE_PHONE);

    expect(demo.primary.label()).toBe("baseten.LLM");
    expect(demo.primary.model).toBe("thinkingmachines/inkling");
    expect(demo.fallback.model).toBe("zai-org/GLM-4.7");
    expect(springHill.primary.model).toBe("thinkingmachines/inkling");
    expect(springHill813.primary.model).toBe("thinkingmachines/inkling");
    expect(crystalRiver.primary.model).toBe("zai-org/GLM-5.2");
    expect(crystalRiver.fallback.model).toBe("zai-org/GLM-4.7");
  });

  it("uses the production models when no trunk override is provided", () => {
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
