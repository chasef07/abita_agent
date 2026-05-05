import { stt } from "@livekit/agents";
import { describe, expect, it, vi } from "vitest";
import { VoiceLanguageRuntime } from "../language-runtime.js";
import { SPANISH_INWORLD_TTS_VOICE } from "../tts-config.js";

function speechEvent(
  type: stt.SpeechEventType,
  language: string,
): stt.SpeechEvent {
  return {
    type,
    alternatives: [
      {
        language,
        text: "hola",
        startTime: 0,
        endTime: 1,
        confidence: 0.95,
      },
    ],
  };
}

describe("VoiceLanguageRuntime", () => {
  it("switches Inworld TTS to Spanish from AssemblyAI speech events", () => {
    const updateOptions = vi.fn();
    const runtime = new VoiceLanguageRuntime(
      { updateOptions },
      {
        ttsOptionsByLanguage: {
          es: {
            voice: SPANISH_INWORLD_TTS_VOICE,
          },
        },
      },
    );

    runtime.updateFromSpeechEvent(
      speechEvent(stt.SpeechEventType.FINAL_TRANSCRIPT, "es"),
    );

    expect(updateOptions).toHaveBeenCalledWith({
      voice: SPANISH_INWORLD_TTS_VOICE,
    });
    expect(runtime.telemetry).toEqual({
      initialLanguage: "en",
      currentLanguage: "es",
      languageSwitches: 1,
      observedLanguages: ["en", "es"],
    });
  });

  it("switches back to English when the caller switches back", () => {
    const updateOptions = vi.fn();
    const englishVoice = "english-voice-id";
    const runtime = new VoiceLanguageRuntime(
      { updateOptions },
      {
        ttsOptionsByLanguage: {
          en: {
            voice: englishVoice,
          },
          es: {
            voice: SPANISH_INWORLD_TTS_VOICE,
          },
        },
      },
    );

    runtime.updateFromSpeechEvent(
      speechEvent(stt.SpeechEventType.FINAL_TRANSCRIPT, "es-US"),
    );
    runtime.updateFromSpeechEvent(
      speechEvent(stt.SpeechEventType.FINAL_TRANSCRIPT, "en-US"),
    );

    expect(updateOptions).toHaveBeenNthCalledWith(1, {
      voice: SPANISH_INWORLD_TTS_VOICE,
    });
    expect(updateOptions).toHaveBeenNthCalledWith(2, {
      voice: englishVoice,
    });
    expect(runtime.telemetry.currentLanguage).toBe("en");
    expect(runtime.telemetry.languageSwitches).toBe(2);
  });

  it("ignores unsupported or non-transcript events", () => {
    const updateOptions = vi.fn();
    const runtime = new VoiceLanguageRuntime({ updateOptions });

    runtime.updateFromSpeechEvent(
      speechEvent(stt.SpeechEventType.INTERIM_TRANSCRIPT, "es"),
    );
    runtime.updateFromSpeechEvent(
      speechEvent(stt.SpeechEventType.FINAL_TRANSCRIPT, "fr"),
    );

    expect(updateOptions).not.toHaveBeenCalled();
    expect(runtime.telemetry.currentLanguage).toBe("en");
  });
});
