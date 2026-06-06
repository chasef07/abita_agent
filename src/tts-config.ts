export const CARTESIA_TTS_MODEL = "sonic-3.5";
export const DEFAULT_CARTESIA_TTS_VOICE =
  "9626c31c-bec5-4cca-baa8-f8ba9e84c8bc";
export const SPANISH_CARTESIA_TTS_VOICE =
  "b4b8e2af-6139-466e-a93a-30c20d2e1fc5";
export const CARTESIA_TTS_LANGUAGE = "en";
export const CARTESIA_TTS_SAMPLE_RATE = 16000;

function configuredEnglishVoice() {
  return process.env.CARTESIA_TTS_VOICE?.trim() || DEFAULT_CARTESIA_TTS_VOICE;
}

export function getCartesiaTtsOptions() {
  return {
    model: CARTESIA_TTS_MODEL,
    voice: configuredEnglishVoice(),
    language: CARTESIA_TTS_LANGUAGE,
    sampleRate: CARTESIA_TTS_SAMPLE_RATE,
  };
}

export function getCartesiaTtsOptionsByLanguage(
  englishVoice = configuredEnglishVoice(),
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
