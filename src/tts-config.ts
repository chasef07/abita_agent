import type { TTSOptions as RimeTtsOptions } from "@livekit/agents-plugin-rime";

export const RIME_TTS_MODEL_ID = "arcana";
export const DEFAULT_RIME_TTS_SPEAKER = "vespera";
export const SPANISH_RIME_TTS_SPEAKER = "luz";
export const RIME_TTS_BASE_URL = "https://users-east.rime.ai/v1/rime-tts";
export const RIME_TTS_SAMPLE_RATE = 16000;
export const RIME_TTS_SPEED_ALPHA = 0.85;
export const RIME_TTS_ENGLISH_LANGUAGE = "eng";
export const RIME_TTS_SPANISH_LANGUAGE = "spa";

export function getRimeTtsOptions(): Partial<RimeTtsOptions> {
  return {
    modelId: process.env.RIME_TTS_MODEL_ID ?? RIME_TTS_MODEL_ID,
    speaker: process.env.RIME_TTS_SPEAKER ?? DEFAULT_RIME_TTS_SPEAKER,
    baseURL: process.env.RIME_TTS_BASE_URL ?? RIME_TTS_BASE_URL,
    lang: RIME_TTS_ENGLISH_LANGUAGE,
    samplingRate: RIME_TTS_SAMPLE_RATE,
    speedAlpha: RIME_TTS_SPEED_ALPHA,
  };
}

export function getRimeTtsOptionsByLanguage(
  englishSpeaker = process.env.RIME_TTS_SPEAKER ?? DEFAULT_RIME_TTS_SPEAKER,
) {
  return {
    en: {
      speaker: englishSpeaker,
      lang: RIME_TTS_ENGLISH_LANGUAGE,
    },
    es: {
      speaker: process.env.RIME_TTS_SPANISH_SPEAKER ?? SPANISH_RIME_TTS_SPEAKER,
      lang: RIME_TTS_SPANISH_LANGUAGE,
    },
  } as const;
}
