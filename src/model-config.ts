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

export function createLlmPair() {
  return {
    primary: new baseten.LLM(primaryLLMOptions),
    fallback: new baseten.LLM(fallbackLLMOptions),
  } as const;
}
