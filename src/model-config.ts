import type { BasetenLLMOptions } from "@livekit/agents-plugin-baseten";
import type { TTSOptions as CartesiaTTSOptions } from "@livekit/agents-plugin-cartesia";

export const cartesiaTTSOptions = {
  model: "sonic-3",
  voice: "9626c31c-bec5-4cca-baa8-f8ba9e84c8bc",
  sampleRate: 16000,
  speed: 0.92,
  volume: 0.85,
  apiVersion: "2026-03-01",
} as const satisfies Partial<CartesiaTTSOptions>;

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
