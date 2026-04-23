import { describe, expect, it } from "vitest";
import {
  FALLBACK_LLM_MODEL,
  LLM_GENERATION_OPTIONS,
  PRIMARY_LLM_MODEL,
} from "../model-config.js";

describe("LLM model configuration", () => {
  it("uses GLM 5 as the primary Baseten model", () => {
    expect(PRIMARY_LLM_MODEL).toBe("zai-org/GLM-5");
  });

  it("keeps MiniMax as the fallback model", () => {
    expect(FALLBACK_LLM_MODEL).toBe("MiniMaxAI/MiniMax-M2.5");
  });

  it("uses voice-agent generation settings for both LLMs", () => {
    expect(LLM_GENERATION_OPTIONS).toEqual({
      parallelToolCalls: false,
      temperature: 1.0,
      topP: 0.9,
    });
  });
});
