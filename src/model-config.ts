import * as baseten from "@livekit/agents-plugin-baseten";
import type { BasetenLLMOptions } from "@livekit/agents-plugin-baseten";
import {
  DEV_OFFICE_PHONE,
  normalizePhoneNumber,
} from "./customers/abita/profile.js";

export const primaryLLMOptions = {
  maxTokens: 512,
  model: "zai-org/GLM-5.2",
  parallelToolCalls: false,
} as const satisfies BasetenLLMOptions;

export const fallbackLLMOptions = {
  maxTokens: 512,
  model: "zai-org/GLM-4.7",
  parallelToolCalls: false,
} as const satisfies BasetenLLMOptions;

const demoPrimaryLLMOptions = {
  maxTokens: 512,
  model: "thinkingmachines/inkling",
  parallelToolCalls: false,
} as const satisfies BasetenLLMOptions;

export function getLlmOptions(trunkPhone?: string) {
  return {
    primary:
      trunkPhone &&
      normalizePhoneNumber(trunkPhone) ===
        normalizePhoneNumber(DEV_OFFICE_PHONE)
        ? demoPrimaryLLMOptions
        : primaryLLMOptions,
    fallback: fallbackLLMOptions,
  } as const;
}

export function createLlmPair(trunkPhone?: string) {
  const options = getLlmOptions(trunkPhone);
  return {
    primary: new baseten.LLM(options.primary),
    fallback: new baseten.LLM(options.fallback),
  } as const;
}
