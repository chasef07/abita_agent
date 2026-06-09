import type { BasetenLLMOptions } from "@livekit/agents-plugin-baseten";

export const primaryLLMOptions = {
  model: "zai-org/GLM-4.7",
} as const satisfies BasetenLLMOptions;

export const fallbackLLMOptions = {
  model: "nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B",
} as const satisfies BasetenLLMOptions;
