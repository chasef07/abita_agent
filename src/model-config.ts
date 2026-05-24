import type { BasetenLLMOptions } from "@livekit/agents-plugin-baseten";

const voiceAgentGenerationOptions = {
  parallelToolCalls: true,
  temperature: 1.0,
  topP: 0.9,
} as const satisfies Pick<
  BasetenLLMOptions,
  "parallelToolCalls" | "temperature" | "topP"
>;

export const primaryLLMOptions = {
  model: "zai-org/GLM-4.7",
  ...voiceAgentGenerationOptions,
} as const satisfies BasetenLLMOptions;

export const fallbackLLMOptions = {
  model: "MiniMaxAI/MiniMax-M2.5",
  ...voiceAgentGenerationOptions,
} as const satisfies BasetenLLMOptions;
