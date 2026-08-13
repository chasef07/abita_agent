import { getOfficeProfileByPhone } from "./customers/abita/profile.js";
import type { VoiceLanguage } from "./runtime/voice-language.js";

export const RIME_TTS_MODEL = "rime/coda";
export const RIME_TTS_SAMPLE_RATE = 16000;

export function getRimeTtsOptions(input: {
  language?: VoiceLanguage;
  trunkPhone: string;
}) {
  const language = input.language ?? "en";
  const options = getRimeTtsLanguageOptions({
    language,
    trunkPhone: input.trunkPhone,
  });

  return {
    language,
    model: RIME_TTS_MODEL,
    sampleRate: RIME_TTS_SAMPLE_RATE,
    voice: options.speaker,
  } as const;
}

function getRimeTtsLanguageOptions(input: {
  language: VoiceLanguage;
  trunkPhone: string;
}) {
  return getOfficeProfileByPhone(input.trunkPhone).speechFor(input.language);
}
