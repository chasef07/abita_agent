import type { BasetenLLMOptions } from "@livekit/agents-plugin-baseten";
import { DEV_OFFICE_PHONE, normalizePhoneNumber } from "./customer/profile.js";

export const DEMO_LLM_TRUNK_PHONE = DEV_OFFICE_PHONE;

export const primaryLLMOptions = {
  model: "zai-org/GLM-4.7",
} as const satisfies BasetenLLMOptions;

export const demoPrimaryLLMOptions = {
  model: "zai-org/GLM-5.2",
} as const satisfies BasetenLLMOptions;

export const fallbackLLMOptions = {
  model: "nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B",
} as const satisfies BasetenLLMOptions;

export function llmOptionsForTrunk(trunkPhone: string) {
  const primary =
    normalizePhoneNumber(trunkPhone) ===
    normalizePhoneNumber(DEMO_LLM_TRUNK_PHONE)
      ? demoPrimaryLLMOptions
      : primaryLLMOptions;

  return {
    primary,
    fallback: fallbackLLMOptions,
  } as const;
}
