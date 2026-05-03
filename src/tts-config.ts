export const CARTESIA_TTS_MODEL = "sonic-3";
export const DEFAULT_CARTESIA_TTS_VOICE =
  "00967b2f-88a6-4a31-8153-110a92134b9f";
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
