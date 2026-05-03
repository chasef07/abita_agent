export const CARTESIA_TTS_MODEL = "sonic-3-latest";
export const DEFAULT_CARTESIA_TTS_VOICE =
  "a167e0f3-df7e-4d52-a9c3-f949145efdab";
export const CARTESIA_TTS_LANGUAGE = "en";
export const CARTESIA_TTS_SAMPLE_RATE = 16000;

export function getCartesiaTtsOptions() {
  return {
    model: CARTESIA_TTS_MODEL,
    voice: process.env.CARTESIA_TTS_VOICE ?? DEFAULT_CARTESIA_TTS_VOICE,
    language: CARTESIA_TTS_LANGUAGE,
    sampleRate: CARTESIA_TTS_SAMPLE_RATE,
  };
}
