import { getOfficeProfileByPhone } from "./customers/abita/profile.js";
import type { VoiceLanguage } from "./runtime/voice-language.js";

export function getRimeTtsOptionsByLanguage(trunkPhone: string) {
  const office = getOfficeProfileByPhone(trunkPhone);
  return {
    en: office.speechFor("en"),
    es: office.speechFor("es"),
  } as const;
}

export function getRimeTtsOptions(input: {
  language?: VoiceLanguage;
  trunkPhone: string;
}) {
  const languageOptions = getOfficeProfileByPhone(input.trunkPhone).speechFor(
    input.language ?? "en",
  );

  return {
    modelId: "coda",
    speaker: languageOptions.speaker,
    lang: languageOptions.lang,
    useWebsocket: true,
    segment: "never",
    baseURL: "wss://users-east-ws.rime.ai",
    samplingRate: 16000,
  } as const;
}
