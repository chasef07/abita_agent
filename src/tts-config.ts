export type TtsProvider = "rime" | "cartesia";

export const DEFAULT_TTS_PROVIDER: TtsProvider = "cartesia";

export const RIME_TTS_MODEL = "coda";
export const DEFAULT_RIME_TTS_SPEAKER = "vespera";
export const SPANISH_RIME_TTS_SPEAKER = "vespero";
export const RIME_TTS_LANGUAGE = "eng";
export const SPANISH_RIME_TTS_LANGUAGE = "spa";
export const RIME_TTS_USE_WEBSOCKET = true;
export const RIME_TTS_SEGMENT = "bySentence";
export const RIME_TTS_EAST_BASE_URL = "wss://users-east-ws.rime.ai";

export const CARTESIA_TTS_MODEL = "sonic-3.5";
export const DEFAULT_CARTESIA_TTS_VOICE =
  "9626c31c-bec5-4cca-baa8-f8ba9e84c8bc";
export const SPANISH_CARTESIA_TTS_VOICE =
  "079e3a17-5545-4bc5-93e3-e11df6fe37b8";
export const CARTESIA_TTS_LANGUAGE = "en";
export const CARTESIA_TTS_SAMPLE_RATE = 16000;

export function getActiveTtsProvider(): TtsProvider {
  const provider = process.env.TTS_PROVIDER?.trim().toLowerCase();
  return provider === "rime" ? "rime" : DEFAULT_TTS_PROVIDER;
}

function configuredRimeSpeaker() {
  return process.env.RIME_TTS_SPEAKER?.trim() || DEFAULT_RIME_TTS_SPEAKER;
}

function configuredRimeBaseUrl() {
  const baseUrl = process.env.RIME_TTS_BASE_URL?.trim() || RIME_TTS_EAST_BASE_URL;
  return baseUrl.replace(/\/ws3\/?$/, "").replace(/\/+$/, "");
}

function configuredRimeApiKey() {
  return process.env.RIME_API_KEY?.trim();
}

function configuredEnglishVoice() {
  return process.env.CARTESIA_TTS_VOICE?.trim() || DEFAULT_CARTESIA_TTS_VOICE;
}

export function getRimeTtsOptions() {
  const apiKey = configuredRimeApiKey();
  return {
    modelId: RIME_TTS_MODEL,
    speaker: configuredRimeSpeaker(),
    lang: RIME_TTS_LANGUAGE,
    useWebsocket: RIME_TTS_USE_WEBSOCKET,
    segment: RIME_TTS_SEGMENT,
    baseURL: configuredRimeBaseUrl(),
    ...(apiKey ? { apiKey } : {}),
  };
}

export function getRimeTtsOptionsByLanguage(
  speaker = configuredRimeSpeaker(),
) {
  return {
    en: {
      lang: RIME_TTS_LANGUAGE,
      speaker,
    },
    es: {
      lang: SPANISH_RIME_TTS_LANGUAGE,
      speaker: SPANISH_RIME_TTS_SPEAKER,
    },
  } as const;
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
