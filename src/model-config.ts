import * as baseten from "@livekit/agents-plugin-baseten";
import type { BasetenLLMOptions } from "@livekit/agents-plugin-baseten";

export const primaryLLMOptions = {
  maxTokens: 512,
  model: "zai-org/GLM-5.2",
  parallelToolCalls: false,
} as const satisfies BasetenLLMOptions;

export const fallbackLLMOptions = {
  maxTokens: 512,
  model: "zai-org/GLM-4.7",
  parallelToolCalls: false,
} as const satisfies BasetenLLMOptions;

export function getLlmOptions() {
  return {
    primary: primaryLLMOptions,
    fallback: fallbackLLMOptions,
  } as const;
}

export function createLlmPair() {
  const options = getLlmOptions();
  return {
    primary: new baseten.LLM(options.primary),
    fallback: new baseten.LLM(options.fallback),
  } as const;
}
