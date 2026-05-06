import { stt } from "@livekit/agents";
import { describe, expect, it, vi } from "vitest";
import { VoiceLanguageRuntime } from "../language-runtime.js";

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
  it("switches TTS options to Spanish from AssemblyAI speech events", () => {
    const updateOptions = vi.fn();
    const runtime = new VoiceLanguageRuntime(
      { updateOptions },
      {
        ttsOptionsByLanguage: {
          es: {
            speaker: "spanish-speaker",
          },
        },
      },
    );

    runtime.updateFromSpeechEvent(
      speechEvent(stt.SpeechEventType.FINAL_TRANSCRIPT, "es"),
    );

    expect(updateOptions).toHaveBeenCalledWith({
      speaker: "spanish-speaker",
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
    const englishSpeaker = "english-speaker";
    const runtime = new VoiceLanguageRuntime(
      { updateOptions },
      {
        ttsOptionsByLanguage: {
          en: {
            speaker: englishSpeaker,
          },
          es: {
            speaker: "spanish-speaker",
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
      speaker: "spanish-speaker",
    });
    expect(updateOptions).toHaveBeenNthCalledWith(2, {
      speaker: englishSpeaker,
    });
    expect(runtime.telemetry.currentLanguage).toBe("en");
    expect(runtime.telemetry.languageSwitches).toBe(2);
  });

  it("tracks language changes without updating TTS when no options are configured", () => {
    const updateOptions = vi.fn();
    const runtime = new VoiceLanguageRuntime({ updateOptions });

    runtime.updateFromSpeechEvent(
      speechEvent(stt.SpeechEventType.FINAL_TRANSCRIPT, "es"),
    );

    expect(updateOptions).not.toHaveBeenCalled();
    expect(runtime.telemetry.currentLanguage).toBe("es");
    expect(runtime.telemetry.languageSwitches).toBe(1);
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
