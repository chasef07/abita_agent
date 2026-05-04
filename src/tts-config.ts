export const CARTESIA_TTS_MODEL = "sonic-3-latest";
export const DEFAULT_CARTESIA_TTS_VOICE =
  "a167e0f3-df7e-4d52-a9c3-f949145efdab";
export const SPANISH_CARTESIA_TTS_VOICE =
  "079e3a17-5545-4bc5-93e3-e11df6fe37b8";
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

export function getCartesiaTtsOptionsByLanguage(
  englishVoice = process.env.CARTESIA_TTS_VOICE ?? DEFAULT_CARTESIA_TTS_VOICE,
) {
  return {
    en: {
      language: "en",
      voice: englishVoice,
    },
    es: {
      language: "es",
      voice: SPANISH_CARTESIA_TTS_VOICE,
    },
  } as const;
}
