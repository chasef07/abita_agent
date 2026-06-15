import { stt } from "@livekit/agents";
import { describe, expect, it, vi } from "vitest";
import {
  VoiceLanguageRuntime,
  type VoiceLanguageTtsOptions,
} from "../language-runtime.js";

const ENGLISH_TTS_OPTIONS = {
  speaker: "english-speaker",
  lang: "eng",
} satisfies VoiceLanguageTtsOptions;

const SPANISH_TTS_OPTIONS = {
  speaker: "spanish-speaker",
  lang: "spa",
} satisfies VoiceLanguageTtsOptions;

function speechEvent(
  type: stt.SpeechEventType,
  language: string,
  text = "necesito ayuda con mi cita",
  languageConfidence: number | null = 0.95,
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
        ...(languageConfidence === null
          ? {}
          : { metadata: { languageConfidence } }),
      },
    ],
  };
}

function createRuntime(
  options: ConstructorParameters<typeof VoiceLanguageRuntime>[1] = {
    ttsOptionsByLanguage: {
      es: SPANISH_TTS_OPTIONS,
    },
  },
) {
  const updateOptions = vi.fn();
  const runtime = new VoiceLanguageRuntime({ updateOptions }, options);
  return { runtime, updateOptions };
}

function createBilingualRuntime() {
  return createRuntime({
    ttsOptionsByLanguage: {
      en: ENGLISH_TTS_OPTIONS,
      es: SPANISH_TTS_OPTIONS,
    },
  });
}

describe("VoiceLanguageRuntime", () => {
  it("switches TTS options to Spanish from the first strong Spanish speech event", () => {
    const { runtime, updateOptions } = createRuntime();

    runtime.updateFromSpeechEvent(
      speechEvent(stt.SpeechEventType.FINAL_TRANSCRIPT, "es"),
    );

    expect(updateOptions).toHaveBeenCalledWith(SPANISH_TTS_OPTIONS);
    expect(runtime.telemetry).toEqual({
      acceptedLanguages: ["en", "es"],
      currentLanguage: "es",
      initialLanguage: "en",
      languageChanged: true,
      languageSwitches: 1,
      observedLanguages: ["en", "es"],
      switchEvents: [
        expect.objectContaining({
          detectedLanguage: "es",
          from: "en",
          reason: "strong_text_evidence",
          to: "es",
        }),
      ],
    });
  });

  it("switches to Spanish from strong text evidence when STT omits language", () => {
    const { runtime, updateOptions } = createRuntime();

    runtime.updateFromSpeechEvent(
      speechEvent(
        stt.SpeechEventType.FINAL_TRANSCRIPT,
        "",
        "si necesito la direccion por favor",
        null,
      ),
    );

    expect(updateOptions).toHaveBeenCalledWith(SPANISH_TTS_OPTIONS);
    expect(runtime.telemetry.currentLanguage).toBe("es");
    expect(runtime.telemetry.languageSwitches).toBe(1);
  });

  it("ignores automatic language switches from interim transcripts", () => {
    const { runtime, updateOptions } = createRuntime();

    runtime.updateFromSpeechEvent(
      speechEvent(stt.SpeechEventType.INTERIM_TRANSCRIPT, "es", "si"),
    );

    expect(updateOptions).not.toHaveBeenCalled();
    expect(runtime.telemetry.currentLanguage).toBe("en");
  });

  it("does not switch from AssemblyAI preflight events before final transcript", () => {
    const { runtime, updateOptions } = createRuntime();

    runtime.updateFromSpeechEvent(
      speechEvent(stt.SpeechEventType.PREFLIGHT_TRANSCRIPT, "es"),
    );

    expect(updateOptions).not.toHaveBeenCalled();
    expect(runtime.telemetry.currentLanguage).toBe("en");
  });

  it("does not switch to Spanish from explicit interim requests", () => {
    const { runtime, updateOptions } = createRuntime();

    runtime.updateFromSpeechEvent(
      speechEvent(
        stt.SpeechEventType.INTERIM_TRANSCRIPT,
        "en-US",
        "Spanish please",
      ),
    );

    expect(updateOptions).not.toHaveBeenCalled();
    expect(runtime.telemetry.currentLanguage).toBe("en");
  });

  it("switches to Spanish from explicit requests even when STT detects English", () => {
    const { runtime, updateOptions } = createRuntime();

    runtime.updateFromSpeechEvent(
      speechEvent(
        stt.SpeechEventType.FINAL_TRANSCRIPT,
        "en-US",
        "Do you speak Spanish?",
      ),
    );

    expect(updateOptions).toHaveBeenCalledWith(SPANISH_TTS_OPTIONS);
    expect(runtime.telemetry.currentLanguage).toBe("es");
  });

  it("handles negated language requests without matching bare language names", () => {
    const { runtime, updateOptions } = createBilingualRuntime();

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

    expect(updateOptions).toHaveBeenNthCalledWith(1, SPANISH_TTS_OPTIONS);
    expect(updateOptions).toHaveBeenNthCalledWith(2, ENGLISH_TTS_OPTIONS);
    expect(runtime.telemetry.currentLanguage).toBe("en");
  });

  it("requires two strong English turns before switching back from Spanish", () => {
    const { runtime, updateOptions } = createBilingualRuntime();

    runtime.updateFromSpeechEvent(
      speechEvent(
        stt.SpeechEventType.FINAL_TRANSCRIPT,
        "en-US",
        "Spanish please",
      ),
    );
    runtime.updateFromSpeechEvent(
      speechEvent(
        stt.SpeechEventType.FINAL_TRANSCRIPT,
        "en-US",
        "I need help scheduling the appointment",
      ),
    );
    runtime.updateFromSpeechEvent(
      speechEvent(
        stt.SpeechEventType.FINAL_TRANSCRIPT,
        "en-US",
        "Can you help me finish the appointment",
      ),
    );

    expect(updateOptions).toHaveBeenNthCalledWith(1, SPANISH_TTS_OPTIONS);
    expect(updateOptions).toHaveBeenNthCalledWith(2, ENGLISH_TTS_OPTIONS);
    expect(runtime.telemetry.currentLanguage).toBe("en");
    expect(runtime.telemetry.languageSwitches).toBe(2);
  });

  it("does not count preflight and final transcripts as two English turns", () => {
    const { runtime, updateOptions } = createBilingualRuntime();

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
        "en",
        "I need help scheduling the appointment",
      ),
    );
    runtime.updateFromSpeechEvent(
      speechEvent(
        stt.SpeechEventType.FINAL_TRANSCRIPT,
        "en",
        "I need help scheduling the appointment",
      ),
    );

    expect(updateOptions).toHaveBeenCalledTimes(1);
    expect(runtime.telemetry.currentLanguage).toBe("es");
    expect(runtime.telemetry.languageSwitches).toBe(1);
  });

  it("does not let interim English fallback pull an active Spanish call back to English", () => {
    const { runtime, updateOptions } = createBilingualRuntime();

    runtime.updateFromSpeechEvent(
      speechEvent(
        stt.SpeechEventType.FINAL_TRANSCRIPT,
        "es",
        "prefiero hablar en espanol",
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
    expect(updateOptions).toHaveBeenCalledWith(SPANISH_TTS_OPTIONS);
    expect(runtime.telemetry.currentLanguage).toBe("es");
    expect(runtime.telemetry.languageSwitches).toBe(1);
  });

  it("does not reassert TTS options on transcript events in the current language", () => {
    const { runtime, updateOptions } = createBilingualRuntime();

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
    expect(updateOptions).toHaveBeenCalledWith(SPANISH_TTS_OPTIONS);
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
          es: SPANISH_TTS_OPTIONS,
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
    expect(updateOptions).toHaveBeenCalledWith(SPANISH_TTS_OPTIONS);
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
          en: ENGLISH_TTS_OPTIONS,
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

  it("does not switch from short ambiguous Spanish detections", () => {
    const { runtime, updateOptions } = createBilingualRuntime();

    runtime.updateFromSpeechEvent(
      speechEvent(stt.SpeechEventType.FINAL_TRANSCRIPT, "es", "si"),
    );

    expect(updateOptions).not.toHaveBeenCalled();
    expect(runtime.telemetry.currentLanguage).toBe("en");
    expect(runtime.telemetry.languageSwitches).toBe(0);
  });

  it("does not switch to Spanish when detected Spanish contradicts English text", () => {
    const { runtime, updateOptions } = createBilingualRuntime();

    runtime.updateFromSpeechEvent(
      speechEvent(
        stt.SpeechEventType.FINAL_TRANSCRIPT,
        "es",
        "I need help scheduling my appointment",
      ),
    );

    expect(updateOptions).not.toHaveBeenCalled();
    expect(runtime.telemetry.currentLanguage).toBe("en");
    expect(runtime.telemetry.languageSwitches).toBe(0);
  });

  it("does not switch when language confidence is below the threshold", () => {
    const { runtime, updateOptions } = createRuntime();

    runtime.updateFromSpeechEvent(
      speechEvent(
        stt.SpeechEventType.FINAL_TRANSCRIPT,
        "es",
        "necesito ayuda con mi cita",
        0.7,
      ),
    );
    runtime.updateFromSpeechEvent(
      speechEvent(
        stt.SpeechEventType.FINAL_TRANSCRIPT,
        "es",
        "quiero programar una cita",
        0.7,
      ),
    );

    expect(updateOptions).not.toHaveBeenCalled();
    expect(runtime.telemetry.currentLanguage).toBe("en");
    expect(runtime.telemetry.languageSwitches).toBe(0);
  });

  it("falls back to sticky final-turn detection when language confidence is missing", () => {
    const { runtime, updateOptions } = createRuntime();

    runtime.updateFromSpeechEvent(
      speechEvent(
        stt.SpeechEventType.FINAL_TRANSCRIPT,
        "es",
        "necesito ayuda con mi cita",
        null,
      ),
    );
    runtime.updateFromSpeechEvent(
      speechEvent(
        stt.SpeechEventType.FINAL_TRANSCRIPT,
        "es",
        "quiero programar una cita",
        null,
      ),
    );

    expect(updateOptions).toHaveBeenCalledWith(SPANISH_TTS_OPTIONS);
    expect(runtime.telemetry.currentLanguage).toBe("es");
    expect(runtime.telemetry.languageSwitches).toBe(1);
  });

  it("tracks language changes without updating TTS when no options are configured", () => {
    const updateOptions = vi.fn();
    const runtime = new VoiceLanguageRuntime({ updateOptions });

    runtime.updateFromSpeechEvent(
      speechEvent(stt.SpeechEventType.FINAL_TRANSCRIPT, "es"),
    );
    runtime.updateFromSpeechEvent(
      speechEvent(stt.SpeechEventType.FINAL_TRANSCRIPT, "es"),
    );

    expect(updateOptions).not.toHaveBeenCalled();
    expect(runtime.telemetry.currentLanguage).toBe("es");
    expect(runtime.telemetry.languageSwitches).toBe(1);
  });

  it("exposes languageChanged only after an accepted switch", () => {
    const updateOptions = vi.fn();
    const runtime = new VoiceLanguageRuntime({ updateOptions });

    expect(runtime.telemetry.languageChanged).toBe(false);
    expect(runtime.telemetry.acceptedLanguages).toEqual(["en"]);
    expect(runtime.telemetry.switchEvents).toEqual([]);

    runtime.updateFromSpeechEvent(
      speechEvent(stt.SpeechEventType.FINAL_TRANSCRIPT, "es", "si", 0.3),
    );

    expect(runtime.telemetry.observedLanguages).toEqual(["en", "es"]);
    expect(runtime.telemetry.languageChanged).toBe(false);
    expect(runtime.telemetry.acceptedLanguages).toEqual(["en"]);
    expect(runtime.telemetry.switchEvents).toEqual([]);
  });

  it("records accepted language switch history for evals", () => {
    const updateOptions = vi.fn();
    const runtime = new VoiceLanguageRuntime({ updateOptions });

    runtime.updateFromSpeechEvent(
      speechEvent(stt.SpeechEventType.FINAL_TRANSCRIPT, "es", "spanish please"),
    );
    runtime.updateFromSpeechEvent(
      speechEvent(stt.SpeechEventType.FINAL_TRANSCRIPT, "en", "english please"),
    );

    expect(runtime.telemetry.languageChanged).toBe(true);
    expect(runtime.telemetry.languageSwitches).toBe(2);
    expect(runtime.telemetry.acceptedLanguages).toEqual(["en", "es", "en"]);
    expect(runtime.telemetry.switchEvents).toEqual([
      expect.objectContaining({
        from: "en",
        reason: "explicit_request",
        to: "es",
      }),
      expect.objectContaining({
        from: "es",
        reason: "explicit_request",
        to: "en",
      }),
    ]);
    expect(JSON.stringify(runtime.telemetry.switchEvents)).not.toContain(
      "transcriptSample",
    );
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

  it("cancels the upstream speech event reader without canceling a locked stream", async () => {
    const cancelUpstream = vi.fn();
    const runtime = new VoiceLanguageRuntime({ updateOptions: vi.fn() });
    const upstream = new ReadableStream<stt.SpeechEvent | string>({
      cancel: cancelUpstream,
    });
    const observed = runtime.observeSpeechEvents(upstream);
    const reader = observed.getReader();

    await expect(reader.cancel("caller disconnected")).resolves.toBeUndefined();

    expect(cancelUpstream).toHaveBeenCalledWith("caller disconnected");
  });
});
