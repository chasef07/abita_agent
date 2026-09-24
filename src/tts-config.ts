import { normalizeLanguage } from "@livekit/agents";
import { getOfficeProfileByPhone } from "./customers/abita/profile.js";
import type { VoiceLanguage } from "./runtime/voice-language.js";

export function getRimeTtsOptionsByLanguage(trunkPhone: string) {
  const office = getOfficeProfileByPhone(trunkPhone);
  return {
    en: {
      voice: office.speechFor("en").speaker,
      language: normalizeLanguage("en"),
    },
    es: {
      voice: office.speechFor("es").speaker,
      language: normalizeLanguage("es"),
    },
  } as const;
}

export function getRimeTtsOptions(input: {
  language?: VoiceLanguage;
  trunkPhone: string;
}) {
  return {
    model: "rime/coda",
    ...getRimeTtsOptionsByLanguage(input.trunkPhone)[input.language ?? "en"],
    sampleRate: 16000,
  } as const;
}
