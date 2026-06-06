import { describe, expect, it } from "vitest";
import { fallbackLLMOptions, primaryLLMOptions } from "../model-config.js";

describe("LLM model config", () => {
  it("uses GLM 5.1 as the primary Baseten model with GLM 4.7 fallback", () => {
    expect(primaryLLMOptions.model).toBe("zai-org/GLM-5.1");
    expect(fallbackLLMOptions.model).toBe("zai-org/GLM-4.7");
  });

  it("keeps tool-call behavior aligned while applying sampling params only to GLM 4.7", () => {
    expect(primaryLLMOptions.parallelToolCalls).toBe(false);
    expect(fallbackLLMOptions.parallelToolCalls).toBe(false);
    expect("temperature" in primaryLLMOptions).toBe(false);
    expect("topP" in primaryLLMOptions).toBe(false);
    expect(fallbackLLMOptions.temperature).toBe(0.3);
    expect(fallbackLLMOptions.topP).toBe(0.9);
  });
});
