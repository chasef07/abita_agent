import {
  inference,
  normalizeLanguage,
  tts as ttsModule,
} from "@livekit/agents";
import * as rime from "@livekit/agents-plugin-rime";
import { getOfficeProfileByPhone } from "./customers/abita/profile.js";
import type {
  VoiceLanguage,
  VoiceLanguageStateOptions,
  VoiceTtsProvider,
} from "./runtime/voice-language.js";
import {
  FISH_AUDIO_TTS_BY_LANGUAGE,
  getFishAudioTtsOptions,
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
  if (getOfficeProfileByPhone(trunkPhone).key === "dev") {
    const tts = new inference.TTS(getFishAudioTtsOptions());
    return {
      optionsByLanguage: {
        en: fishAudioLanguageState("en"),
        es: fishAudioLanguageState("es"),
      },
      provider: "fishaudio",
      tts,
      updateLanguage(language) {
        const options = FISH_AUDIO_TTS_BY_LANGUAGE[language];
        tts.updateOptions({
          language: normalizeLanguage(options.language),
          voice: options.voice,
        });
      },
    };
  }

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

function fishAudioLanguageState(
  language: VoiceLanguage,
): VoiceLanguageStateOptions {
  const options = FISH_AUDIO_TTS_BY_LANGUAGE[language];
  return { speaker: options.voice, ttsLanguage: options.language };
}

function rimeLanguageState(options: {
  lang: string;
  speaker: string;
}): VoiceLanguageStateOptions {
  return { speaker: options.speaker, ttsLanguage: options.lang };
}
