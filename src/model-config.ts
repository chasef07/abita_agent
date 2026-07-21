import { inference } from "@livekit/agents";
import * as baseten from "@livekit/agents-plugin-baseten";
import type { BasetenLLMOptions } from "@livekit/agents-plugin-baseten";

export const primaryLLMOptions = {
  model: "openai/gpt-5.6-luna",
  modelOptions: {
    max_completion_tokens: 512,
    parallel_tool_calls: false,
  },
} as const satisfies ConstructorParameters<typeof inference.LLM>[0];

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
    primary: new inference.LLM(options.primary),
    fallback: new baseten.LLM(options.fallback),
  } as const;
}
