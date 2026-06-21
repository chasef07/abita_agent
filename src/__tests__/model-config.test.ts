import { describe, expect, it } from "vitest";
import {
  WAFER_LLM_BASE_URL,
  WAFER_ZDR_HEADER,
  WAFER_ZDR_VALUE,
  fallbackLLMOptions,
  getLlmOptions,
  primaryLLMOptions,
  requireWaferApiKey,
} from "../model-config.js";

describe("LLM model config", () => {
  it("uses GLM 5.2 on Wafer as the primary model with GLM 4.7 fallback", () => {
    expect(primaryLLMOptions.model).toBe("GLM-5.2");
    expect(fallbackLLMOptions.model).toBe("GLM-4.7");
  });

  it("uses the same primary and fallback models for every trunk", () => {
    expect(getLlmOptions().primary).toBe(primaryLLMOptions);
    expect(getLlmOptions().fallback).toBe(fallbackLLMOptions);
  });

  it("does not set custom generation or parallel tool-call parameters", () => {
    expect(Object.keys(primaryLLMOptions)).toEqual(["model"]);
    expect(Object.keys(fallbackLLMOptions)).toEqual(["model"]);
  });

  it("configures Wafer's OpenAI-compatible endpoint and ZDR header", () => {
    expect(WAFER_LLM_BASE_URL).toBe("https://pass.wafer.ai/v1");
    expect(WAFER_ZDR_HEADER).toBe("Wafer-ZDR");
    expect(WAFER_ZDR_VALUE).toBe("required");
  });

  it("requires a Wafer API key", () => {
    expect(requireWaferApiKey({ WAFER_API_KEY: " wafer-key " })).toBe(
      "wafer-key",
    );
    expect(() => requireWaferApiKey({})).toThrow("WAFER_API_KEY is required.");
  });
});
