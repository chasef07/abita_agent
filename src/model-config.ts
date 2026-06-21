import type { LLMOptions } from "@livekit/agents-plugin-openai";
import OpenAI from "openai";

export const WAFER_LLM_BASE_URL = "https://pass.wafer.ai/v1";
export const WAFER_ZDR_HEADER = "Wafer-ZDR";
export const WAFER_ZDR_VALUE = "required";

export const primaryLLMOptions = {
  model: "GLM-5.2",
  parallelToolCalls: false,
} as const satisfies LLMOptions;

export const fallbackLLMOptions = {
  model: "GLM-5.1",
  parallelToolCalls: false,
} as const satisfies LLMOptions;

export function getLlmOptions() {
  return {
    primary: primaryLLMOptions,
    fallback: fallbackLLMOptions,
  } as const;
}

export function requireWaferApiKey(env: NodeJS.ProcessEnv = process.env) {
  const apiKey = env.WAFER_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("WAFER_API_KEY is required.");
  }
  return apiKey;
}

export function createWaferClient(apiKey: string) {
  return new OpenAI({
    apiKey,
    baseURL: WAFER_LLM_BASE_URL,
    defaultHeaders: { [WAFER_ZDR_HEADER]: WAFER_ZDR_VALUE },
  });
}
