import type { BasetenLLMOptions } from "@livekit/agents-plugin-baseten";
import type { TTSOptions as RimeTTSOptions } from "@livekit/agents-plugin-rime";

export const rimeTTSOptions = {
  modelId: "coda",
  speaker: "marlu",
  lang: "eng",
} as const satisfies Partial<RimeTTSOptions>;

const voiceAgentGenerationOptions = {
  parallelToolCalls: false,
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
