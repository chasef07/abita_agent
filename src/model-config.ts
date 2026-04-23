// Baseten OpenAI-compatible model identifiers.
export const PRIMARY_LLM_MODEL = "zai-org/GLM-5";
export const FALLBACK_LLM_MODEL = "MiniMaxAI/MiniMax-M2.5";

export const LLM_GENERATION_OPTIONS = {
  parallelToolCalls: false,
  temperature: 1.0,
  topP: 0.9,
} as const;
