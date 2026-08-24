import { inference } from "@livekit/agents";

type InferenceLLMOptions = ConstructorParameters<typeof inference.LLM>[0];

export const primaryLLMOptions = {
  model: "google/gemma-4-31b-it",
  modelOptions: {
    max_completion_tokens: 512,
    parallel_tool_calls: false,
  },
  strictToolSchema: true,
} as const satisfies InferenceLLMOptions;

export const fallbackLLMOptions = {
  model: "xai/grok-4.5",
  modelOptions: {
    max_completion_tokens: 512,
    parallel_tool_calls: false,
  },
  strictToolSchema: true,
} as const satisfies InferenceLLMOptions;

export function createLlmPair() {
  return {
    primary: new inference.LLM(primaryLLMOptions),
    fallback: new inference.LLM(fallbackLLMOptions),
  } as const;
}
