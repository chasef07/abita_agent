import { stt } from "@livekit/agents";
import { describe, expect, it, vi } from "vitest";
import { VoiceLanguageRuntime } from "../language-runtime.js";

function speechEvent(
  type: stt.SpeechEventType,
  language: string,
  text = "necesito ayuda con mi cita",
): stt.SpeechEvent {
  return {
    type,
    alternatives: [
      {
        language,
        text,
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
            lang: "spa",
          },
        },
      },
    );

    runtime.updateFromSpeechEvent(
      speechEvent(stt.SpeechEventType.FINAL_TRANSCRIPT, "es"),
    );

    expect(updateOptions).toHaveBeenCalledWith({
      speaker: "spanish-speaker",
      lang: "spa",
    });
    expect(runtime.telemetry).toEqual({
      initialLanguage: "en",
      currentLanguage: "es",
      languageSwitches: 1,
      observedLanguages: ["en", "es"],
    });
  });

  it("switches from AssemblyAI interim events before final transcript", () => {
    const updateOptions = vi.fn();
    const runtime = new VoiceLanguageRuntime(
      { updateOptions },
      {
        ttsOptionsByLanguage: {
          es: {
            speaker: "spanish-speaker",
            lang: "spa",
          },
        },
      },
    );

    runtime.updateFromSpeechEvent(
      speechEvent(stt.SpeechEventType.INTERIM_TRANSCRIPT, "es", "si"),
    );

    expect(updateOptions).toHaveBeenCalledWith({
      speaker: "spanish-speaker",
      lang: "spa",
    });
    expect(runtime.telemetry.currentLanguage).toBe("es");
  });

  it("switches from AssemblyAI preflight events before final transcript", () => {
    const updateOptions = vi.fn();
    const runtime = new VoiceLanguageRuntime(
      { updateOptions },
      {
        ttsOptionsByLanguage: {
          es: {
            speaker: "spanish-speaker",
            lang: "spa",
          },
        },
      },
    );

    runtime.updateFromSpeechEvent(
      speechEvent(stt.SpeechEventType.PREFLIGHT_TRANSCRIPT, "es"),
    );

    expect(updateOptions).toHaveBeenCalledWith({
      speaker: "spanish-speaker",
      lang: "spa",
    });
    expect(runtime.telemetry.currentLanguage).toBe("es");
  });

  it("switches to Spanish from explicit requests even when STT detects English", () => {
    const updateOptions = vi.fn();
    const runtime = new VoiceLanguageRuntime(
      { updateOptions },
      {
        ttsOptionsByLanguage: {
          es: {
            speaker: "spanish-speaker",
            lang: "spa",
          },
        },
      },
    );

    runtime.updateFromSpeechEvent(
      speechEvent(
        stt.SpeechEventType.FINAL_TRANSCRIPT,
        "en-US",
        "Do you speak Spanish?",
      ),
    );

    expect(updateOptions).toHaveBeenCalledWith({
      speaker: "spanish-speaker",
      lang: "spa",
    });
    expect(runtime.telemetry.currentLanguage).toBe("es");
  });

  it("handles negated language requests without matching bare language names", () => {
    const updateOptions = vi.fn();
    const runtime = new VoiceLanguageRuntime(
      { updateOptions },
      {
        ttsOptionsByLanguage: {
          en: {
            speaker: "english-speaker",
            lang: "eng",
          },
          es: {
            speaker: "spanish-speaker",
            lang: "spa",
          },
        },
      },
    );

    runtime.updateFromSpeechEvent(
      speechEvent(
        stt.SpeechEventType.FINAL_TRANSCRIPT,
        "en",
        "No hablo inglés",
      ),
    );
    runtime.updateFromSpeechEvent(
      speechEvent(
        stt.SpeechEventType.FINAL_TRANSCRIPT,
        "en",
        "I don't speak Spanish",
      ),
    );

    expect(updateOptions).toHaveBeenNthCalledWith(1, {
      speaker: "spanish-speaker",
      lang: "spa",
    });
    expect(updateOptions).toHaveBeenNthCalledWith(2, {
      speaker: "english-speaker",
      lang: "eng",
    });
    expect(runtime.telemetry.currentLanguage).toBe("en");
  });

  it("switches back to English from the next English transcript", () => {
    const updateOptions = vi.fn();
    const englishSpeaker = "english-speaker";
    const runtime = new VoiceLanguageRuntime(
      { updateOptions },
      {
        ttsOptionsByLanguage: {
          en: {
            speaker: englishSpeaker,
            lang: "eng",
          },
          es: {
            speaker: "spanish-speaker",
            lang: "spa",
          },
        },
      },
    );

    runtime.updateFromSpeechEvent(
      speechEvent(
        stt.SpeechEventType.FINAL_TRANSCRIPT,
        "es-US",
        "necesito ayuda con mi cita",
      ),
    );
    runtime.updateFromSpeechEvent(
      speechEvent(
        stt.SpeechEventType.FINAL_TRANSCRIPT,
        "en-US",
        "I need help scheduling the appointment",
      ),
    );

    expect(updateOptions).toHaveBeenNthCalledWith(1, {
      speaker: "spanish-speaker",
      lang: "spa",
    });
    expect(updateOptions).toHaveBeenNthCalledWith(2, {
      speaker: englishSpeaker,
      lang: "eng",
    });
    expect(runtime.telemetry.currentLanguage).toBe("en");
    expect(runtime.telemetry.languageSwitches).toBe(2);
  });

  it("does not let interim English fallback pull an active Spanish call back to English", () => {
    const updateOptions = vi.fn();
    const runtime = new VoiceLanguageRuntime(
      { updateOptions },
      {
        ttsOptionsByLanguage: {
          en: {
            speaker: "english-speaker",
            lang: "eng",
          },
          es: {
            speaker: "spanish-speaker",
            lang: "spa",
          },
        },
      },
    );

    runtime.updateFromSpeechEvent(
      speechEvent(
        stt.SpeechEventType.FINAL_TRANSCRIPT,
        "es",
        "necesito ayuda con mi cita",
      ),
    );
    runtime.updateFromSpeechEvent(
      speechEvent(
        stt.SpeechEventType.INTERIM_TRANSCRIPT,
        "en",
        "necesito ayuda",
      ),
    );

    expect(updateOptions).toHaveBeenCalledTimes(1);
    expect(updateOptions).toHaveBeenCalledWith({
      speaker: "spanish-speaker",
      lang: "spa",
    });
    expect(runtime.telemetry.currentLanguage).toBe("es");
    expect(runtime.telemetry.languageSwitches).toBe(1);
  });

  it("does not reassert TTS options on transcript events in the current language", () => {
    const updateOptions = vi.fn();
    const runtime = new VoiceLanguageRuntime(
      { updateOptions },
      {
        ttsOptionsByLanguage: {
          en: {
            speaker: "english-speaker",
            lang: "eng",
          },
          es: {
            speaker: "spanish-speaker",
            lang: "spa",
          },
        },
      },
    );

    runtime.updateFromSpeechEvent(
      speechEvent(
        stt.SpeechEventType.FINAL_TRANSCRIPT,
        "es",
        "prefiero hablar en espanol",
      ),
    );
    runtime.updateFromSpeechEvent(
      speechEvent(
        stt.SpeechEventType.PREFLIGHT_TRANSCRIPT,
        "es",
        "necesito una cita",
      ),
    );
    runtime.updateFromSpeechEvent(
      speechEvent(
        stt.SpeechEventType.FINAL_TRANSCRIPT,
        "es",
        "necesito una cita",
      ),
    );

    expect(updateOptions).toHaveBeenCalledTimes(1);
    expect(updateOptions).toHaveBeenCalledWith({
      speaker: "spanish-speaker",
      lang: "spa",
    });
    expect(runtime.telemetry.currentLanguage).toBe("es");
    expect(runtime.telemetry.languageSwitches).toBe(1);
  });

  it("applies same-language TTS options once when they have not already been applied", () => {
    const updateOptions = vi.fn();
    const runtime = new VoiceLanguageRuntime(
      { updateOptions },
      {
        defaultLanguage: "es",
        ttsOptionsByLanguage: {
          es: {
            speaker: "spanish-speaker",
            lang: "spa",
          },
        },
      },
    );

    runtime.updateFromSpeechEvent(
      speechEvent(
        stt.SpeechEventType.FINAL_TRANSCRIPT,
        "es",
        "necesito una cita",
      ),
    );
    runtime.updateFromSpeechEvent(
      speechEvent(
        stt.SpeechEventType.FINAL_TRANSCRIPT,
        "es",
        "tambien necesito lentes",
      ),
    );

    expect(updateOptions).toHaveBeenCalledTimes(1);
    expect(updateOptions).toHaveBeenCalledWith({
      speaker: "spanish-speaker",
      lang: "spa",
    });
    expect(runtime.telemetry.currentLanguage).toBe("es");
    expect(runtime.telemetry.languageSwitches).toBe(0);
  });

  it("does not update TTS for same-language transcripts when startup options are already applied", () => {
    const updateOptions = vi.fn();
    const runtime = new VoiceLanguageRuntime(
      { updateOptions },
      {
        appliedTtsLanguage: "en",
        ttsOptionsByLanguage: {
          en: {
            speaker: "english-speaker",
            lang: "eng",
          },
        },
      },
    );

    runtime.updateFromSpeechEvent(
      speechEvent(
        stt.SpeechEventType.FINAL_TRANSCRIPT,
        "en",
        "I need help scheduling",
      ),
    );

    expect(updateOptions).not.toHaveBeenCalled();
    expect(runtime.telemetry.currentLanguage).toBe("en");
    expect(runtime.telemetry.languageSwitches).toBe(0);
  });

  it("switches from short Spanish turns when AssemblyAI detects Spanish", () => {
    const updateOptions = vi.fn();
    const runtime = new VoiceLanguageRuntime(
      { updateOptions },
      {
        ttsOptionsByLanguage: {
          en: {
            speaker: "english-speaker",
            lang: "eng",
          },
          es: {
            speaker: "spanish-speaker",
            lang: "spa",
          },
        },
      },
    );

    runtime.updateFromSpeechEvent(
      speechEvent(stt.SpeechEventType.INTERIM_TRANSCRIPT, "es", "si"),
    );

    expect(updateOptions).toHaveBeenCalledTimes(1);
    expect(updateOptions).toHaveBeenCalledWith({
      speaker: "spanish-speaker",
      lang: "spa",
    });
    expect(runtime.telemetry.currentLanguage).toBe("es");
    expect(runtime.telemetry.languageSwitches).toBe(1);
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
      speechEvent(stt.SpeechEventType.START_OF_SPEECH, "es"),
    );
    runtime.updateFromSpeechEvent(
      speechEvent(stt.SpeechEventType.FINAL_TRANSCRIPT, "fr"),
    );

    expect(updateOptions).not.toHaveBeenCalled();
    expect(runtime.telemetry.currentLanguage).toBe("en");
  });
});
