import type { BasetenLLMOptions } from "@livekit/agents-plugin-baseten";

const sharedVoiceAgentOptions = {
  parallelToolCalls: false,
} as const satisfies Pick<BasetenLLMOptions, "parallelToolCalls">;

const glm47GenerationOptions = {
  temperature: 0.3,
  topP: 0.9,
} as const satisfies Pick<BasetenLLMOptions, "temperature" | "topP">;

export const primaryLLMOptions = {
  model: "zai-org/GLM-4.7",
  ...sharedVoiceAgentOptions,
  ...glm47GenerationOptions,
} as const satisfies BasetenLLMOptions;

export const fallbackLLMOptions = {
  model: "zai-org/GLM-5",
  ...sharedVoiceAgentOptions,
} as const satisfies BasetenLLMOptions;
