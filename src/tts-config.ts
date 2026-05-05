import type { TTSOptions as InworldTtsOptions } from "@livekit/agents-plugin-inworld";

export const INWORLD_TTS_MODEL = "inworld-tts-2";
export const DEFAULT_INWORLD_TTS_VOICE = "Nate";
export const SPANISH_INWORLD_TTS_VOICE = "Diego";
export const INWORLD_TTS_SAMPLE_RATE = 16000;
export const INWORLD_TTS_ENCODING =
  "PCM" satisfies InworldTtsOptions["encoding"];
export const INWORLD_TTS_SPEAKING_RATE = 1.0;
export const INWORLD_TTS_TEXT_NORMALIZATION =
  "ON" satisfies InworldTtsOptions["textNormalization"];

export function getInworldTtsOptions(): Partial<InworldTtsOptions> {
  return {
    model: INWORLD_TTS_MODEL,
    voice: process.env.INWORLD_TTS_VOICE ?? DEFAULT_INWORLD_TTS_VOICE,
    sampleRate: INWORLD_TTS_SAMPLE_RATE,
    encoding: INWORLD_TTS_ENCODING,
    speakingRate: INWORLD_TTS_SPEAKING_RATE,
    textNormalization: INWORLD_TTS_TEXT_NORMALIZATION,
  };
}

export function getInworldTtsOptionsByLanguage(
  englishVoice = process.env.INWORLD_TTS_VOICE ?? DEFAULT_INWORLD_TTS_VOICE,
) {
  return {
    en: {
      voice: englishVoice,
    },
    es: {
      voice: process.env.INWORLD_TTS_SPANISH_VOICE ?? SPANISH_INWORLD_TTS_VOICE,
    },
  } as const;
}
