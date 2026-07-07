import type { VoiceLanguage } from "./stt-language-detector.js";
import {
  NORTH_MIAMI_BEACH_OPTICAL_OFFICE_PHONE,
  SWEETWATER_TRUNK_PHONES,
  normalizePhoneNumber,
} from "./customer/profile.js";

export const RIME_TTS_MODEL = "coda";
export const DEFAULT_RIME_TTS_SPEAKER = "wawona";
export const LATIN_RIME_TTS_SPEAKER = "luz";
export const SWEETWATER_RIME_TTS_SPEAKER = LATIN_RIME_TTS_SPEAKER;
export const SPANISH_RIME_TTS_SPEAKER = LATIN_RIME_TTS_SPEAKER;
export const RIME_TTS_LANGUAGE = "eng";
export const SPANISH_RIME_TTS_LANGUAGE = "spa";
export const RIME_TTS_SAMPLE_RATE = 16000;
export const RIME_TTS_BASE_URL = "wss://users-east-ws.rime.ai";
export const RIME_TTS_SEGMENT = "bySentence";

export type RimeTtsLanguageCode =
  typeof RIME_TTS_LANGUAGE | typeof SPANISH_RIME_TTS_LANGUAGE;

export type RimeTtsLanguageOptions = {
  language: RimeTtsLanguageCode;
  speaker: string;
};

export function isSweetwaterTtsTrunk(trunkPhone: string): boolean {
  const normalizedTrunkPhone = normalizePhoneNumber(trunkPhone);
  return SWEETWATER_TRUNK_PHONES.some(
    (sweetwaterTrunkPhone) =>
      normalizePhoneNumber(sweetwaterTrunkPhone) === normalizedTrunkPhone,
  );
}

function usesLatinEnglishVoice(trunkPhone: string): boolean {
  return (
    isSweetwaterTtsTrunk(trunkPhone) ||
    normalizePhoneNumber(trunkPhone) ===
      normalizePhoneNumber(NORTH_MIAMI_BEACH_OPTICAL_OFFICE_PHONE)
  );
}

export function getRimeTtsLanguageOptions(input: {
  language: VoiceLanguage;
  trunkPhone: string;
}): RimeTtsLanguageOptions {
  if (input.language === "es") {
    return {
      language: SPANISH_RIME_TTS_LANGUAGE,
      speaker: SPANISH_RIME_TTS_SPEAKER,
    };
  }

  return {
    language: RIME_TTS_LANGUAGE,
    speaker: usesLatinEnglishVoice(input.trunkPhone)
      ? LATIN_RIME_TTS_SPEAKER
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
    language: languageOptions.language,
    useWebsocket: true,
    segment: RIME_TTS_SEGMENT,
    baseURL: RIME_TTS_BASE_URL,
    samplingRate: RIME_TTS_SAMPLE_RATE,
  };
}
