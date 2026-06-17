import { describe, expect, it } from "vitest";
import {
  DEV_OFFICE_PHONE,
  SPRING_HILL_813_TRUNK_PHONE,
  SPRING_HILL_OFFICE_PHONE,
} from "../customer/profile.js";
import {
  demoPrimaryLLMOptions,
  fallbackLLMOptions,
  llmOptionsForTrunk,
  primaryLLMOptions,
  springHillFallbackLLMOptions,
  springHillPrimaryLLMOptions,
} from "../model-config.js";

describe("LLM model config", () => {
  it("uses GLM 4.7 as the default primary Baseten model with Nemotron Ultra fallback", () => {
    expect(primaryLLMOptions.model).toBe("zai-org/GLM-4.7");
    expect(fallbackLLMOptions.model).toBe(
      "nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B",
    );
  });

  it("uses GLM 5.2 primary and GLM 4.7 fallback for Spring Hill trunks", () => {
    expect(springHillPrimaryLLMOptions.model).toBe("zai-org/GLM-5.2");
    expect(springHillFallbackLLMOptions.model).toBe("zai-org/GLM-4.7");
    expect(llmOptionsForTrunk(SPRING_HILL_OFFICE_PHONE).primary.model).toBe(
      "zai-org/GLM-5.2",
    );
    expect(llmOptionsForTrunk(SPRING_HILL_OFFICE_PHONE).fallback.model).toBe(
      "zai-org/GLM-4.7",
    );
    expect(llmOptionsForTrunk(SPRING_HILL_813_TRUNK_PHONE).primary.model).toBe(
      "zai-org/GLM-5.2",
    );
    expect(llmOptionsForTrunk(SPRING_HILL_813_TRUNK_PHONE).fallback.model).toBe(
      "zai-org/GLM-4.7",
    );
  });

  it("keeps GLM 5.2 as the primary model for the demo trunk", () => {
    expect(demoPrimaryLLMOptions.model).toBe("zai-org/GLM-5.2");
    expect(llmOptionsForTrunk(DEV_OFFICE_PHONE).primary.model).toBe(
      "zai-org/GLM-5.2",
    );
    expect(llmOptionsForTrunk("14843989071").primary.model).toBe(
      "zai-org/GLM-5.2",
    );
    expect(llmOptionsForTrunk(DEV_OFFICE_PHONE).fallback.model).toBe(
      "nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B",
    );
  });

  it("does not set custom generation or parallel tool-call parameters", () => {
    expect(Object.keys(primaryLLMOptions)).toEqual(["model"]);
    expect(Object.keys(demoPrimaryLLMOptions)).toEqual(["model"]);
    expect(Object.keys(springHillPrimaryLLMOptions)).toEqual(["model"]);
    expect(Object.keys(springHillFallbackLLMOptions)).toEqual(["model"]);
    expect(Object.keys(fallbackLLMOptions)).toEqual(["model"]);
  });
});
