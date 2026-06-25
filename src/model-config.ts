import type { BasetenLLMOptions } from "@livekit/agents-plugin-baseten";

export const primaryLLMOptions = {
  maxTokens: 512,
  model: "zai-org/GLM-4.7",
  parallelToolCalls: false,
} as const satisfies BasetenLLMOptions;

export const fallbackLLMOptions = {
  maxTokens: 512,
  model: "zai-org/GLM-5.1",
  parallelToolCalls: false,
} as const satisfies BasetenLLMOptions;

export function getLlmOptions() {
  return {
    primary: primaryLLMOptions,
    fallback: fallbackLLMOptions,
  } as const;
}
