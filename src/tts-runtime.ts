import { tts as ttsModule } from "@livekit/agents";
import * as rime from "@livekit/agents-plugin-rime";
import type {
  VoiceLanguage,
  VoiceLanguageStateOptions,
  VoiceTtsProvider,
} from "./runtime/voice-language.js";
import {
  getRimeTtsOptions,
  getRimeTtsOptionsByLanguage,
} from "./tts-config.js";

export type TtsRuntime = {
  optionsByLanguage: Record<VoiceLanguage, VoiceLanguageStateOptions>;
  provider: VoiceTtsProvider;
  tts: ttsModule.TTS;
  updateLanguage(language: VoiceLanguage): void;
};

export function createTtsRuntime(trunkPhone: string): TtsRuntime {
  const optionsByLanguage = getRimeTtsOptionsByLanguage(trunkPhone);
  const tts = new rime.TTS(getRimeTtsOptions({ language: "en", trunkPhone }));
  return {
    optionsByLanguage: {
      en: rimeLanguageState(optionsByLanguage.en),
      es: rimeLanguageState(optionsByLanguage.es),
    },
    provider: "rime",
    tts,
    updateLanguage(language) {
      tts.updateOptions(optionsByLanguage[language]);
    },
  };
}

function rimeLanguageState(options: {
  lang: string;
  speaker: string;
}): VoiceLanguageStateOptions {
  return { speaker: options.speaker, ttsLanguage: options.lang };
}
