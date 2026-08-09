import { stt } from "@livekit/agents";
import { describe, expect, it, vi } from "vitest";
import {
  VoiceLanguageRuntime,
  type VoiceLanguageStateOptions,
  type RuntimeVoiceLanguageState,
} from "../runtime/voice-language.js";

const OPTIONS_BY_LANGUAGE = {
  en: { speaker: "wawona", ttsLanguage: "eng" },
  es: { speaker: "luz", ttsLanguage: "spa" },
} as const satisfies Record<"en" | "es", VoiceLanguageStateOptions>;

function speechEvent(
  language: string,
  confidence: number | null = 0.95,
  text = "caller transcript",
  type = stt.SpeechEventType.FINAL_TRANSCRIPT,
): stt.SpeechEvent {
  return {
    type,
    alternatives: [
      {
        confidence: 0.95,
        endTime: 1,
        language,
        ...(confidence === null
          ? {}
          : { metadata: { assemblyai: { languageConfidence: confidence } } }),
        startTime: 0,
        text,
      },
    ],
  };
}

function createRuntime() {
  const state: RuntimeVoiceLanguageState = {
    current: "en",
    speaker: "wawona",
    ttsLanguage: "eng",
    ttsProvider: "rime",
  };
  const updateOptions = vi.fn();
  const runtime = new VoiceLanguageRuntime({
    optionsByLanguage: OPTIONS_BY_LANGUAGE,
    state,
    tts: { updateLanguage: updateOptions },
  });
  return { runtime, state, updateOptions };
}

async function observe(
  runtime: VoiceLanguageRuntime,
  events: Array<stt.SpeechEvent | string>,
) {
  const upstream = new ReadableStream<stt.SpeechEvent | string>({
    start(controller) {
      for (const event of events) controller.enqueue(event);
      controller.close();
    },
  });
  const observed = [];
  for await (const event of runtime.observe(upstream)) observed.push(event);
  return observed;
}

describe("VoiceLanguageRuntime", () => {
  it("reads flat AssemblyAI language confidence from Inference metadata", async () => {
    const { runtime, state, updateOptions } = createRuntime();
    const event = speechEvent("es-MX", null);
    event.alternatives![0].metadata = {
      language_confidence: 0.95,
    };

    await observe(runtime, [event]);

    expect(updateOptions).toHaveBeenCalledWith("es");
    expect(state.current).toBe("es");
  });

  it("keeps STT passthrough and switches TTS from English to Spanish and back", async () => {
    const { runtime, state, updateOptions } = createRuntime();
    const events = [speechEvent("es-MX"), "passthrough", speechEvent("en-US")];

    await expect(observe(runtime, events)).resolves.toEqual(events);

    expect(updateOptions.mock.calls).toEqual([["es"], ["en"]]);
    expect(state).toMatchObject({
      current: "en",
      speaker: "wawona",
      ttsLanguage: "eng",
      ttsProvider: "rime",
    });
    expect(runtime.snapshot()).toMatchObject({
      language: {
        acceptedLanguages: ["en", "es", "en"],
        currentLanguage: "en",
        languageChanged: true,
        languageSwitches: 2,
        observedLanguages: ["en", "es"],
      },
      voiceLanguage: {
        current: "en",
        speaker: "wawona",
        ttsLanguage: "eng",
      },
    });
  });

  it("switches immediately when the caller explicitly requests another language", async () => {
    const { runtime, state, updateOptions } = createRuntime();

    await observe(runtime, [
      speechEvent("en-US", 0.95, "Spanish please"),
      speechEvent("es", 0.95, "English please"),
    ]);

    expect(updateOptions.mock.calls).toEqual([["es"], ["en"]]);
    expect(state.current).toBe("en");
    expect(runtime.snapshot().language.switchEvents).toMatchObject([
      { from: "en", reason: "explicit_request", to: "es" },
      { from: "es", reason: "explicit_request", to: "en" },
    ]);
  });

  it("understands which language the caller rejects", async () => {
    const { runtime, state, updateOptions } = createRuntime();

    await observe(runtime, [
      speechEvent("en-US", 0.95, "I can't speak Spanish"),
      speechEvent("en-US", 0.95, "Don't switch to Spanish"),
      speechEvent("en-US", 0.95, "I don't speak English"),
    ]);

    expect(updateOptions.mock.calls).toEqual([["es"]]);
    expect(state.current).toBe("es");
    expect(runtime.snapshot().language.switchEvents).toMatchObject([
      { from: "en", reason: "explicit_request", to: "es" },
    ]);
  });

  it("does not treat bare not as a request to switch languages", async () => {
    const { runtime, state, updateOptions } = createRuntime();

    await observe(runtime, [
      speechEvent("en-US", 0.95, "I prefer not to speak Spanish"),
      speechEvent("en-US", 0.95, "Could you not speak Spanish?"),
      speechEvent("en-US", 0.95, "I do not want to switch to Spanish"),
      speechEvent("en-US", 0.95, "Don't, please, switch to Spanish"),
    ]);

    expect(updateOptions).not.toHaveBeenCalled();
    expect(state.current).toBe("en");
    expect(runtime.snapshot().language.switchEvents).toEqual([]);
  });

  it("scopes negation to the language request", async () => {
    const { runtime, state, updateOptions } = createRuntime();

    await observe(runtime, [
      speechEvent(
        "en-US",
        0.95,
        "I am not sure the last answer helped; could you continue in Spanish?",
      ),
    ]);

    expect(updateOptions).toHaveBeenCalledWith("es");
    expect(state.current).toBe("es");
  });

  it("evaluates separate request clauses independently", async () => {
    const { runtime, state, updateOptions } = createRuntime();

    await observe(runtime, [
      speechEvent(
        "en-US",
        0.95,
        "Could you not repeat that; could you speak Spanish?",
      ),
    ]);

    expect(updateOptions).toHaveBeenCalledWith("es");
    expect(state.current).toBe("es");
  });

  it("recognizes a coordinated request as a new clause", async () => {
    const { runtime, state, updateOptions } = createRuntime();

    await observe(runtime, [
      speechEvent(
        "en-US",
        0.95,
        "Could you not repeat that and could you switch to Spanish?",
      ),
    ]);

    expect(updateOptions).toHaveBeenCalledWith("es");
    expect(state.current).toBe("es");
  });

  it("recognizes a coordinated language preference as a new clause", async () => {
    const { runtime, state, updateOptions } = createRuntime();

    await observe(runtime, [
      speechEvent(
        "en-US",
        0.95,
        "I am not sure and I would like to speak Spanish",
      ),
    ]);

    expect(updateOptions).toHaveBeenCalledWith("es");
    expect(state.current).toBe("es");
  });

  it("recognizes conversational requests to speak another language", async () => {
    const { runtime, state, updateOptions } = createRuntime();

    await observe(runtime, [
      speechEvent("en-US", 0.95, "Do you speak Spanish?"),
      speechEvent("es", 0.95, "Can we continue in English?"),
    ]);

    expect(updateOptions.mock.calls).toEqual([["es"], ["en"]]);
    expect(state.current).toBe("en");
  });

  it("commits language only after TTS accepts it and retries on later evidence", async () => {
    const { runtime, state, updateOptions } = createRuntime();
    updateOptions.mockImplementationOnce(() => {
      throw new Error("invalid TTS options");
    });
    const events = [speechEvent("es"), speechEvent("es")];

    await expect(observe(runtime, events)).resolves.toEqual(events);

    expect(updateOptions.mock.calls).toEqual([["es"], ["es"]]);
    expect(state.current).toBe("es");
    expect(runtime.snapshot().language).toMatchObject({
      acceptedLanguages: ["en", "es"],
      currentLanguage: "es",
      keepEvents: [
        {
          currentLanguage: "en",
          observedLanguage: "es",
          reason: "apply_failed",
        },
      ],
      languageSwitches: 1,
    });
  });

  it("records sanitized reasons for final turns that do not switch", async () => {
    const { runtime } = createRuntime();

    await observe(runtime, [
      speechEvent(
        "es",
        0.99,
        "interim private transcript",
        stt.SpeechEventType.INTERIM_TRANSCRIPT,
      ),
      speechEvent("fr", 0.99, "unsupported private transcript"),
      speechEvent("es", null, "missing confidence private transcript"),
      speechEvent("es", 0.59, "low confidence private transcript"),
    ]);

    const telemetry = runtime.snapshot().language;
    expect(telemetry).toMatchObject({
      currentLanguage: "en",
      keepEvents: [
        { providerCode: "fr", reason: "unsupported" },
        {
          currentLanguage: "en",
          observedLanguage: "es",
          providerCode: "es",
          reason: "missing_confidence",
        },
        {
          confidence: 0.59,
          currentLanguage: "en",
          observedLanguage: "es",
          providerCode: "es",
          reason: "low_confidence",
        },
      ],
      observedLanguages: ["en", "es"],
    });
    expect(JSON.stringify(telemetry)).not.toContain("private transcript");
  });

  it("cancels the upstream STT reader when observation stops", async () => {
    const { runtime } = createRuntime();
    const cancelUpstream = vi.fn();
    const upstream = new ReadableStream<stt.SpeechEvent | string>({
      cancel: cancelUpstream,
    });
    const reader = runtime.observe(upstream).getReader();

    await expect(reader.cancel("caller disconnected")).resolves.toBeUndefined();

    expect(cancelUpstream).toHaveBeenCalledWith("caller disconnected");
  });
});
