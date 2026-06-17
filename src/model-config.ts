import type { BasetenLLMOptions } from "@livekit/agents-plugin-baseten";

export const primaryLLMOptions = {
  model: "zai-org/GLM-5.2",
} as const satisfies BasetenLLMOptions;

export const fallbackLLMOptions = {
  model: "zai-org/GLM-4.7",
} as const satisfies BasetenLLMOptions;

export function getLlmOptions() {
  return {
    primary: primaryLLMOptions,
    fallback: fallbackLLMOptions,
  } as const;
}
