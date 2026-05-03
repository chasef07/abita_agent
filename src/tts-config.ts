export const CARTESIA_TTS_MODEL = "cartesia/sonic-3-2026-01-12";
export const DEFAULT_CARTESIA_TTS_VOICE = "asher";
export const CARTESIA_TTS_LANGUAGE = "en";

export function getCartesiaTtsOptions() {
  return {
    model: CARTESIA_TTS_MODEL,
    voice: process.env.CARTESIA_TTS_VOICE ?? DEFAULT_CARTESIA_TTS_VOICE,
    language: CARTESIA_TTS_LANGUAGE,
  };
}
