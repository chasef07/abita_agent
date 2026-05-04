export const RIME_TTS_MODEL_ID = "coda";
export const DEFAULT_RIME_TTS_SPEAKER = "walnut";
export const RIME_TTS_SAMPLE_RATE = 16000;

export function getRimeTtsOptions() {
  return {
    modelId: process.env.RIME_TTS_MODEL_ID ?? RIME_TTS_MODEL_ID,
    speaker: process.env.RIME_TTS_SPEAKER ?? DEFAULT_RIME_TTS_SPEAKER,
    samplingRate: RIME_TTS_SAMPLE_RATE,
  };
}
