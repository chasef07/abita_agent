import { getOfficeProfileByPhone } from "./customers/abita/profile.js";
import type {
  RimeVoiceLanguageOptions,
  VoiceLanguage,
} from "./runtime/voice-language.js";

export const RIME_TTS_MODEL = "coda";
export const RIME_TTS_LANGUAGE = "eng";
export const SPANISH_RIME_TTS_LANGUAGE = "spa";
export const RIME_TTS_SAMPLE_RATE = 16000;
export const RIME_TTS_BASE_URL = "wss://users-east-ws.rime.ai";
export const RIME_TTS_SEGMENT = "never";

export type RimeTtsLanguageCode =
  typeof RIME_TTS_LANGUAGE | typeof SPANISH_RIME_TTS_LANGUAGE;

export type RimeTtsLanguageOptions = RimeVoiceLanguageOptions;

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
