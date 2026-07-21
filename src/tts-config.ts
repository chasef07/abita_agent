import { getOfficeProfileByPhone } from "./customers/abita/profile.js";
import type {
  SttLanguageDecision,
  VoiceLanguage,
} from "./stt-language-detector.js";

export const RIME_TTS_MODEL = "coda";
export const RIME_TTS_LANGUAGE = "eng";
export const SPANISH_RIME_TTS_LANGUAGE = "spa";
export const RIME_TTS_SAMPLE_RATE = 16000;
export const RIME_TTS_BASE_URL = "wss://users-east-ws.rime.ai";
export const RIME_TTS_SEGMENT = "bySentence";

export type RimeTtsLanguageCode =
  typeof RIME_TTS_LANGUAGE | typeof SPANISH_RIME_TTS_LANGUAGE;

export type RimeTtsLanguageOptions = {
  lang: RimeTtsLanguageCode;
  speaker: string;
};

export interface RuntimeVoiceLanguageState {
  current: VoiceLanguage;
  ttsProvider: "rime";
  ttsLanguage: RimeTtsLanguageCode;
  speaker: string;
  confidence?: number;
  providerCode?: string;
  updatedAt?: string;
}

export function createRimeVoiceLanguageState(input: {
  decision?: Extract<SttLanguageDecision, { action: "switch" }>;
  language: VoiceLanguage;
  options: RimeTtsLanguageOptions;
}): RuntimeVoiceLanguageState {
  return {
    current: input.language,
    speaker: input.options.speaker,
    ttsLanguage: input.options.lang,
    ttsProvider: "rime",
    ...(input.decision
      ? {
          providerCode: input.decision.providerCode,
          updatedAt: new Date().toISOString(),
          ...(input.decision.confidence !== undefined
            ? { confidence: input.decision.confidence }
            : {}),
        }
      : {}),
  };
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
