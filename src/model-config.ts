import type { BasetenLLMOptions } from "@livekit/agents-plugin-baseten";
import {
  DEV_OFFICE_PHONE,
  normalizePhoneNumber,
  SPRING_HILL_813_TRUNK_PHONE,
  SPRING_HILL_OFFICE_PHONE,
} from "./customer/profile.js";

export const DEMO_LLM_TRUNK_PHONE = DEV_OFFICE_PHONE;
const SPRING_HILL_LLM_TRUNK_PHONES = [
  SPRING_HILL_OFFICE_PHONE,
  SPRING_HILL_813_TRUNK_PHONE,
].map(normalizePhoneNumber);

export const primaryLLMOptions = {
  model: "zai-org/GLM-4.7",
} as const satisfies BasetenLLMOptions;

export const demoPrimaryLLMOptions = {
  model: "zai-org/GLM-5.2",
} as const satisfies BasetenLLMOptions;

export const springHillPrimaryLLMOptions = {
  model: "zai-org/GLM-5.2",
} as const satisfies BasetenLLMOptions;

export const springHillFallbackLLMOptions = {
  model: "zai-org/GLM-4.7",
} as const satisfies BasetenLLMOptions;

export const fallbackLLMOptions = {
  model: "nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B",
} as const satisfies BasetenLLMOptions;

export function llmOptionsForTrunk(trunkPhone: string) {
  const normalizedTrunkPhone = normalizePhoneNumber(trunkPhone);
  if (SPRING_HILL_LLM_TRUNK_PHONES.includes(normalizedTrunkPhone)) {
    return {
      primary: springHillPrimaryLLMOptions,
      fallback: springHillFallbackLLMOptions,
    } as const;
  }

  const primary =
    normalizedTrunkPhone === normalizePhoneNumber(DEMO_LLM_TRUNK_PHONE)
      ? demoPrimaryLLMOptions
      : primaryLLMOptions;

  return {
    primary,
    fallback: fallbackLLMOptions,
  } as const;
}
