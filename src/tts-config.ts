import type { VoiceLanguage } from "./stt-language-detector.js";
import {
  SWEETWATER_TRUNK_PHONES,
  normalizePhoneNumber,
} from "./customer/profile.js";

export const RIME_TTS_MODEL = "coda";
export const DEFAULT_RIME_TTS_SPEAKER = "wawona";
export const SWEETWATER_RIME_TTS_SPEAKER = "luz";
export const SPANISH_RIME_TTS_SPEAKER = "luz";
export const RIME_TTS_LANGUAGE = "eng";
export const SPANISH_RIME_TTS_LANGUAGE = "spa";
export const RIME_TTS_SAMPLE_RATE = 16000;
export const RIME_TTS_BASE_URL = "wss://users-east-ws.rime.ai";
export const RIME_TTS_SEGMENT = "bySentence";

export type RimeTtsLanguageCode =
  | typeof RIME_TTS_LANGUAGE
  | typeof SPANISH_RIME_TTS_LANGUAGE;

export type RimeTtsLanguageOptions = {
  lang: RimeTtsLanguageCode;
  speaker: string;
};

export function isSweetwaterTtsTrunk(trunkPhone: string): boolean {
  const normalizedTrunkPhone = normalizePhoneNumber(trunkPhone);
  return SWEETWATER_TRUNK_PHONES.some(
    (sweetwaterTrunkPhone) =>
      normalizePhoneNumber(sweetwaterTrunkPhone) === normalizedTrunkPhone,
  );
}

export function getRimeTtsLanguageOptions(input: {
  language: VoiceLanguage;
  trunkPhone: string;
}): RimeTtsLanguageOptions {
  if (input.language === "es") {
    return {
      lang: SPANISH_RIME_TTS_LANGUAGE,
      speaker: SPANISH_RIME_TTS_SPEAKER,
    };
  }

  return {
    lang: RIME_TTS_LANGUAGE,
    speaker: isSweetwaterTtsTrunk(input.trunkPhone)
      ? SWEETWATER_RIME_TTS_SPEAKER
      : DEFAULT_RIME_TTS_SPEAKER,
  };
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
