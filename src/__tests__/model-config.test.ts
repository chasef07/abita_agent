import { describe, expect, it } from "vitest";
import { fallbackLLMOptions, primaryLLMOptions } from "../model-config.js";

describe("LLM model config", () => {
  it("uses Nemotron as the primary Baseten model with GLM 4.7 fallback", () => {
    expect(primaryLLMOptions.model).toBe(
      "nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B",
    );
    expect(fallbackLLMOptions.model).toBe("zai-org/GLM-4.7");
  });

  it("does not set custom generation or parallel tool-call parameters", () => {
    expect(Object.keys(primaryLLMOptions)).toEqual(["model"]);
    expect(Object.keys(fallbackLLMOptions)).toEqual(["model"]);
  });
});
