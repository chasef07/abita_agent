import type { BasetenLLMOptions } from "@livekit/agents-plugin-baseten";

const voiceAgentGenerationOptions = {
  parallelToolCalls: false,
  temperature: 1.0,
  topP: 0.9,
} as const satisfies Pick<
  BasetenLLMOptions,
  "parallelToolCalls" | "temperature" | "topP"
>;

export const primaryLLMOptions = {
  model: "deepseek-ai/DeepSeek-V4-Pro",
  ...voiceAgentGenerationOptions,
} as const satisfies BasetenLLMOptions;

export const fallbackLLMOptions = {
  model: "zai-org/GLM-4.7",
  ...voiceAgentGenerationOptions,
} as const satisfies BasetenLLMOptions;
