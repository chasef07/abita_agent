import { inference } from "@livekit/agents";
import * as openai from "@livekit/agents-plugin-openai";

type InferenceLLMOptions = ConstructorParameters<typeof inference.LLM>[0];

export const primaryLLMOptions = {
  model: "zai-org/GLM-5.3-Flash",
  baseURL: "https://inference.baseten.co/v1",
  reasoningEffort: "low",
  maxCompletionTokens: 512,
  parallelToolCalls: false,
  strictToolSchema: true,
} as const satisfies openai.LLMOptions;

export const fallbackLLMOptions = {
  model: "google/gemma-4-31b-it",
  modelOptions: {
    max_completion_tokens: 512,
    parallel_tool_calls: false,
  },
  strictToolSchema: true,
} as const satisfies InferenceLLMOptions;

export function createLlmPair() {
  const apiKey = process.env.BASETEN_API_KEY;
  if (!apiKey) {
    throw new Error("BASETEN_API_KEY is required for the primary LLM");
  }

  return {
    primary: new openai.LLM({ ...primaryLLMOptions, apiKey }),
    fallback: new inference.LLM(fallbackLLMOptions),
  } as const;
}
