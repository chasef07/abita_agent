import { DEV_OFFICE_PHONE, normalizePhoneNumber } from "./customer/profile.js";

export const CARTESIA_TTS_MODEL = "sonic-3.5";
export const DEFAULT_CARTESIA_TTS_VOICE =
  "9626c31c-bec5-4cca-baa8-f8ba9e84c8bc";
export const SPANISH_CARTESIA_TTS_VOICE =
  "b4b8e2af-6139-466e-a93a-30c20d2e1fc5";
export const CARTESIA_TTS_LANGUAGE = "en";
export const CARTESIA_TTS_SAMPLE_RATE = 16000;
export const RIME_TTS_DEMO_TRUNK_PHONE = DEV_OFFICE_PHONE;
export const RIME_TTS_MODEL = "coda";
export const DEFAULT_RIME_TTS_SPEAKER = "luz";
export const RIME_TTS_LANGUAGE = "eng";
export const RIME_TTS_SAMPLE_RATE = 16000;
export const RIME_TTS_BASE_URL = "wss://users-east-ws.rime.ai";
export const RIME_TTS_SEGMENT = "bySentence";

export type TtsProvider = "cartesia" | "rime";

function configuredEnglishVoice() {
  return process.env.CARTESIA_TTS_VOICE?.trim() || DEFAULT_CARTESIA_TTS_VOICE;
}

function configuredRimeSpeaker() {
  return process.env.RIME_TTS_SPEAKER?.trim() || DEFAULT_RIME_TTS_SPEAKER;
}

export function getCartesiaTtsOptions(voice = configuredEnglishVoice()) {
  return {
    model: CARTESIA_TTS_MODEL,
    voice,
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

export function ttsProviderForTrunk(trunkPhone: string): TtsProvider {
  return normalizePhoneNumber(trunkPhone) ===
    normalizePhoneNumber(RIME_TTS_DEMO_TRUNK_PHONE)
    ? "rime"
    : "cartesia";
}

export function getRimeTtsOptions(speaker = configuredRimeSpeaker()) {
  return {
    modelId: RIME_TTS_MODEL,
    speaker,
    lang: RIME_TTS_LANGUAGE,
    useWebsocket: true,
    segment: RIME_TTS_SEGMENT,
    baseURL: RIME_TTS_BASE_URL,
    samplingRate: RIME_TTS_SAMPLE_RATE,
  };
}
