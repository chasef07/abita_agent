import { getOfficeProfileByPhone } from "./customers/abita/profile.js";
import type { VoiceLanguage } from "./runtime/voice-language.js";

export const FISH_AUDIO_TTS_MODEL = "fishaudio/s2.1-pro-free";
export const FISH_AUDIO_HANNAH_VOICE = "9a9cf47702da476aa4629e2506d4a857";
export const FISH_AUDIO_TTS_SAMPLE_RATE = 16000;
export const FISH_AUDIO_TELEPHONY_OPTIONS = {
  chunk_length: 100,
  condition_on_previous_chunks: true,
  latency: "balanced",
  normalize: true,
  normalize_loudness: true,
} as const;
export const FISH_AUDIO_TTS_BY_LANGUAGE = {
  en: { language: "en", voice: FISH_AUDIO_HANNAH_VOICE },
  es: { language: "es", voice: FISH_AUDIO_HANNAH_VOICE },
} as const;
export const RIME_TTS_MODEL = "coda";
export const RIME_TTS_LANGUAGE = "eng";
export const SPANISH_RIME_TTS_LANGUAGE = "spa";
export const RIME_TTS_SAMPLE_RATE = 16000;
export const RIME_TTS_BASE_URL = "wss://users-east-ws.rime.ai";
export const RIME_TTS_SEGMENT = "never";

export type RimeTtsLanguageCode =
  typeof RIME_TTS_LANGUAGE | typeof SPANISH_RIME_TTS_LANGUAGE;

export type RimeTtsLanguageOptions = {
  lang: RimeTtsLanguageCode;
  speaker: string;
};

export function getFishAudioTtsOptions(language: VoiceLanguage = "en") {
  return {
    ...FISH_AUDIO_TTS_BY_LANGUAGE[language],
    model: FISH_AUDIO_TTS_MODEL,
    modelOptions: FISH_AUDIO_TELEPHONY_OPTIONS,
    sampleRate: FISH_AUDIO_TTS_SAMPLE_RATE,
  } as const;
}

export function getRimeTtsLanguageOptions(input: {
  language: VoiceLanguage;
  trunkPhone: string;
}): RimeTtsLanguageOptions {
  return getOfficeProfileByPhone(input.trunkPhone).speechFor(input.language);
}

export function getRimeTtsOptionsByLanguage(trunkPhone: string) {
  return {
    en: getRimeTtsLanguageOptions({ language: "en", trunkPhone }),
    es: getRimeTtsLanguageOptions({ language: "es", trunkPhone }),
  } as const satisfies Record<VoiceLanguage, RimeTtsLanguageOptions>;
}

export function getRimeTtsOptions(input: {
  language?: VoiceLanguage;
  trunkPhone: string;
}) {
  const languageOptions = getRimeTtsLanguageOptions({
    language: input.language ?? "en",
    trunkPhone: input.trunkPhone,
  });

  return {
    modelId: RIME_TTS_MODEL,
    speaker: languageOptions.speaker,
    lang: languageOptions.lang,
    useWebsocket: true,
    segment: RIME_TTS_SEGMENT,
    baseURL: RIME_TTS_BASE_URL,
    samplingRate: RIME_TTS_SAMPLE_RATE,
  };
}
