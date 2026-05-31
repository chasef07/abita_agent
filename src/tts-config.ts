export const CARTESIA_TTS_MODEL = "sonic-3.5";
export const DEFAULT_CARTESIA_TTS_VOICE =
  "5ee9feff-1265-424a-9d7f-8e4d431a12c7";
export const SPANISH_CARTESIA_TTS_VOICE =
  "079e3a17-5545-4bc5-93e3-e11df6fe37b8";
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
