export const INWORLD_TTS_MODEL = "inworld/inworld-tts-1.5-max";
export const DEFAULT_INWORLD_TTS_VOICE = "Edward";
export const INWORLD_TTS_LANGUAGE = "en";

export function getInworldTtsOptions() {
  return {
    model: INWORLD_TTS_MODEL,
    voice: process.env.INWORLD_TTS_VOICE ?? DEFAULT_INWORLD_TTS_VOICE,
    language: INWORLD_TTS_LANGUAGE,
  };
}
