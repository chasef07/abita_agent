export const INWORLD_TTS_MODEL_ID = "inworld/inworld-tts-2";
export const DEFAULT_INWORLD_TTS_VOICE = "Sarah";
export const SPANISH_INWORLD_TTS_VOICE = "Sarah";
export const INWORLD_TTS_SAMPLE_RATE = 16000;
export const INWORLD_TTS_SPEAKING_RATE = 0.85;
export const INWORLD_TTS_ENGLISH_LANGUAGE = "en";
export const INWORLD_TTS_SPANISH_LANGUAGE = "es";

export type InworldTtsModelOptions = {
  speaking_rate: number;
};

export type InworldTtsOptions = {
  model: string;
  voice: string;
  language: string;
  sampleRate: number;
  modelOptions: InworldTtsModelOptions;
};

export type InworldTtsLanguageOptions = Omit<
  InworldTtsOptions,
  "sampleRate" | "modelOptions"
>;

export function getInworldTtsOptions(): InworldTtsOptions {
  return {
    model: process.env.INWORLD_TTS_MODEL_ID ?? INWORLD_TTS_MODEL_ID,
    voice: process.env.INWORLD_TTS_VOICE ?? DEFAULT_INWORLD_TTS_VOICE,
    language: INWORLD_TTS_ENGLISH_LANGUAGE,
    sampleRate: INWORLD_TTS_SAMPLE_RATE,
    modelOptions: {
      speaking_rate: INWORLD_TTS_SPEAKING_RATE,
    },
  };
}

export function getInworldTtsOptionsByLanguage(
  englishVoice = process.env.INWORLD_TTS_VOICE ?? DEFAULT_INWORLD_TTS_VOICE,
  model = process.env.INWORLD_TTS_MODEL_ID ?? INWORLD_TTS_MODEL_ID,
): Record<"en" | "es", InworldTtsLanguageOptions> {
  return {
    en: {
      model,
      voice: englishVoice,
      language: INWORLD_TTS_ENGLISH_LANGUAGE,
    },
    es: {
      model,
      voice: process.env.INWORLD_TTS_SPANISH_VOICE ?? SPANISH_INWORLD_TTS_VOICE,
      language: INWORLD_TTS_SPANISH_LANGUAGE,
    },
  };
}
