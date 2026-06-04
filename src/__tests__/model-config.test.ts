import { describe, expect, it } from "vitest";
import { fallbackLLMOptions, primaryLLMOptions } from "../model-config.js";

describe("LLM model config", () => {
  it("uses GLM 4.7 as the primary Baseten model with GLM 5 fallback", () => {
    expect(primaryLLMOptions.model).toBe("zai-org/GLM-4.7");
    expect(fallbackLLMOptions.model).toBe("zai-org/GLM-5");
  });

  it("keeps tool-call behavior aligned while applying sampling params to GLM 4.7", () => {
    expect(primaryLLMOptions.parallelToolCalls).toBe(false);
    expect(fallbackLLMOptions.parallelToolCalls).toBe(false);
    expect(primaryLLMOptions.temperature).toBe(0.3);
    expect(primaryLLMOptions.topP).toBe(0.9);
    expect("temperature" in fallbackLLMOptions).toBe(false);
    expect("topP" in fallbackLLMOptions).toBe(false);
  });
});
