import {
  inference,
  normalizeLanguage,
  tts as ttsModule,
} from "@livekit/agents";
import type {
  VoiceLanguage,
  VoiceLanguageStateOptions,
  VoiceTtsProvider,
} from "./runtime/voice-language.js";
import { getRimeTtsOptions } from "./tts-config.js";

export type TtsRuntime = {
  optionsByLanguage: Record<VoiceLanguage, VoiceLanguageStateOptions>;
  provider: VoiceTtsProvider;
  tts: ttsModule.TTS;
  updateLanguage(language: VoiceLanguage): void;
};

export function createTtsRuntime(trunkPhone: string): TtsRuntime {
  const optionsByLanguage = {
    en: getRimeTtsOptions({ language: "en", trunkPhone }),
    es: getRimeTtsOptions({ language: "es", trunkPhone }),
  } as const;
  const tts = new inference.TTS(optionsByLanguage.en);
  return {
    optionsByLanguage: {
      en: inferenceLanguageState(optionsByLanguage.en),
      es: inferenceLanguageState(optionsByLanguage.es),
    },
    provider: "rime-inference",
    tts,
    updateLanguage(language) {
      const options = optionsByLanguage[language];
      tts.updateOptions({
        language: normalizeLanguage(options.language),
        voice: options.voice,
      });
    },
  };
}

function inferenceLanguageState(options: {
  language: VoiceLanguage;
  voice: string;
}): VoiceLanguageStateOptions {
  return { speaker: options.voice, ttsLanguage: options.language };
}
