import { describe, expect, it } from "vitest";
import {
  fallbackLLMOptions,
  getLlmOptions,
  primaryLLMOptions,
} from "../model-config.js";

describe("LLM model config", () => {
  it("uses GLM 5.2 as the primary Baseten model with GLM 4.7 fallback", () => {
    expect(primaryLLMOptions.model).toBe("zai-org/GLM-5.2");
    expect(fallbackLLMOptions.model).toBe("zai-org/GLM-4.7");
  });

  it("uses the same primary and fallback models for every trunk", () => {
    expect(getLlmOptions().primary).toBe(primaryLLMOptions);
    expect(getLlmOptions().fallback).toBe(fallbackLLMOptions);
  });

  it("does not set custom generation or parallel tool-call parameters", () => {
    expect(Object.keys(primaryLLMOptions)).toEqual(["model"]);
    expect(Object.keys(fallbackLLMOptions)).toEqual(["model"]);
  });
});
