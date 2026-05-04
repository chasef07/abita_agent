export const RIME_TTS_MODEL_ID = "coda";
export const DEFAULT_RIME_TTS_SPEAKER = "pilaster";
export const RIME_TTS_BASE_URL = "https://users-east.rime.ai/v1/rime-tts";
export const RIME_TTS_SAMPLE_RATE = 16000;

export function getRimeTtsOptions() {
  return {
    modelId: process.env.RIME_TTS_MODEL_ID ?? RIME_TTS_MODEL_ID,
    speaker: process.env.RIME_TTS_SPEAKER ?? DEFAULT_RIME_TTS_SPEAKER,
    baseURL: process.env.RIME_TTS_BASE_URL ?? RIME_TTS_BASE_URL,
    samplingRate: RIME_TTS_SAMPLE_RATE,
  };
}
