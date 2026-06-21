import { stt } from "@livekit/agents";
import { describe, expect, it, vi } from "vitest";
import {
  LANGUAGE_SWITCH_CONFIDENCE_THRESHOLD,
  SttLanguageDetector,
  observeSttLanguage,
} from "../stt-language-detector.js";

function speechEvent(
  type: stt.SpeechEventType,
  language: string,
  languageConfidence: number | null = 0.95,
  text = "caller transcript",
): stt.SpeechEvent {
  return {
    type,
    alternatives: [
      {
        confidence: 0.95,
        endTime: 1,
        language,
        startTime: 0,
        text,
        ...(languageConfidence === null
          ? {}
          : { metadata: { assemblyai: { languageConfidence } } }),
      },
    ],
  };
}

describe("SttLanguageDetector", () => {
  it("ignores interim and preflight language codes", () => {
    const detector = new SttLanguageDetector();

    expect(
      detector.updateFromSpeechEvent(
        speechEvent(stt.SpeechEventType.INTERIM_TRANSCRIPT, "es", 0.99),
      ),
    ).toMatchObject({ action: "keep", reason: "non_final" });
    expect(
      detector.updateFromSpeechEvent(
        speechEvent(stt.SpeechEventType.PREFLIGHT_TRANSCRIPT, "es", 0.99),
      ),
    ).toMatchObject({ action: "keep", reason: "non_final" });

    expect(detector.telemetry.currentLanguage).toBe("en");
    expect(detector.telemetry.languageSwitches).toBe(0);
  });

  it("normalizes supported provider language codes", () => {
    const detector = new SttLanguageDetector();

    const decision = detector.updateFromSpeechEvent(
      speechEvent(stt.SpeechEventType.FINAL_TRANSCRIPT, "es-MX", 0.95),
    );

    expect(decision).toMatchObject({
      action: "switch",
      from: "en",
      providerCode: "es-MX",
      to: "es",
    });
    expect(detector.telemetry.currentLanguage).toBe("es");
  });

  it("keeps the current language for unsupported language codes", () => {
    const detector = new SttLanguageDetector();

    const decision = detector.updateFromSpeechEvent(
      speechEvent(stt.SpeechEventType.FINAL_TRANSCRIPT, "fr", 0.99),
    );

    expect(decision).toMatchObject({
      action: "keep",
      providerCode: "fr",
      reason: "unsupported",
    });
    expect(detector.telemetry.currentLanguage).toBe("en");
  });

  it("keeps the current language when language confidence is missing", () => {
    const detector = new SttLanguageDetector();

    const decision = detector.updateFromSpeechEvent(
      speechEvent(stt.SpeechEventType.FINAL_TRANSCRIPT, "es", null),
    );

    expect(decision).toMatchObject({
      action: "keep",
      observedLanguage: "es",
      reason: "missing_confidence",
    });
    expect(detector.telemetry.currentLanguage).toBe("en");
  });

  it("keeps the current language below the confidence threshold", () => {
    const detector = new SttLanguageDetector();

    const decision = detector.updateFromSpeechEvent(
      speechEvent(
        stt.SpeechEventType.FINAL_TRANSCRIPT,
        "es",
        LANGUAGE_SWITCH_CONFIDENCE_THRESHOLD - 0.01,
      ),
    );

    expect(decision).toMatchObject({
      action: "keep",
      confidence: 0.69,
      observedLanguage: "es",
      reason: "low_confidence",
    });
    expect(detector.telemetry.currentLanguage).toBe("en");
  });

  it("switches to Spanish from the first strong Spanish final turn", () => {
    const detector = new SttLanguageDetector();

    const decision = detector.updateFromSpeechEvent(
      speechEvent(stt.SpeechEventType.FINAL_TRANSCRIPT, "es", 0.95),
    );

    expect(decision).toMatchObject({
      action: "switch",
      confidence: 0.95,
      from: "en",
      to: "es",
    });
    expect(detector.telemetry).toMatchObject({
      acceptedLanguages: ["en", "es"],
      currentLanguage: "es",
      languageChanged: true,
      languageSwitches: 1,
    });
  });

  it("switches to Spanish from an explicit English request", () => {
    const detector = new SttLanguageDetector();

    const decision = detector.updateFromSpeechEvent(
      speechEvent(
        stt.SpeechEventType.FINAL_TRANSCRIPT,
        "en-US",
        0.95,
        "Spanish please",
      ),
    );

    expect(decision).toMatchObject({
      action: "switch",
      from: "en",
      providerCode: "en-US",
      reason: "explicit_request",
      to: "es",
    });
    expect(detector.telemetry.switchEvents[0]).toMatchObject({
      reason: "explicit_request",
      to: "es",
    });
  });

  it("treats do-you-speak-Spanish phrasing as an explicit request", () => {
    const detector = new SttLanguageDetector();

    const decision = detector.updateFromSpeechEvent(
      speechEvent(
        stt.SpeechEventType.FINAL_TRANSCRIPT,
        "en-US",
        0.95,
        "Do you speak Spanish?",
      ),
    );

    expect(decision).toMatchObject({
      action: "switch",
      reason: "explicit_request",
      to: "es",
    });
  });

  it("does not switch from a negated Spanish mention", () => {
    const detector = new SttLanguageDetector();

    const decision = detector.updateFromSpeechEvent(
      speechEvent(
        stt.SpeechEventType.FINAL_TRANSCRIPT,
        "en-US",
        0.95,
        "I don't speak Spanish",
      ),
    );

    expect(decision).toMatchObject({
      action: "keep",
      currentLanguage: "en",
      observedLanguage: "en",
      reason: "same_language",
    });
  });

  it("requires two consecutive strong English final turns before switching back from Spanish", () => {
    const detector = new SttLanguageDetector();

    detector.updateFromSpeechEvent(
      speechEvent(stt.SpeechEventType.FINAL_TRANSCRIPT, "es", 0.95),
    );
    const firstEnglish = detector.updateFromSpeechEvent(
      speechEvent(stt.SpeechEventType.FINAL_TRANSCRIPT, "en", 0.95),
    );
    const decision = detector.updateFromSpeechEvent(
      speechEvent(stt.SpeechEventType.FINAL_TRANSCRIPT, "en-US", 0.96),
    );

    expect(firstEnglish).toMatchObject({
      action: "keep",
      candidateLanguage: "en",
      candidateTurns: 1,
      reason: "sticky_window",
    });
    expect(decision).toMatchObject({
      action: "switch",
      confidence: 0.96,
      from: "es",
      providerCode: "en-US",
      to: "en",
    });
    expect(detector.telemetry.acceptedLanguages).toEqual(["en", "es", "en"]);
  });

  it("switches back to English immediately from an explicit request", () => {
    const detector = new SttLanguageDetector();

    detector.updateFromSpeechEvent(
      speechEvent(stt.SpeechEventType.FINAL_TRANSCRIPT, "es", 0.95),
    );
    const decision = detector.updateFromSpeechEvent(
      speechEvent(
        stt.SpeechEventType.FINAL_TRANSCRIPT,
        "es",
        0.95,
        "English please",
      ),
    );

    expect(decision).toMatchObject({
      action: "switch",
      from: "es",
      reason: "explicit_request",
      to: "en",
    });
    expect(detector.telemetry.acceptedLanguages).toEqual(["en", "es", "en"]);
  });

  it("resets a pending English candidate on same-language Spanish evidence", () => {
    const detector = new SttLanguageDetector();

    detector.updateFromSpeechEvent(
      speechEvent(stt.SpeechEventType.FINAL_TRANSCRIPT, "es", 0.95),
    );
    detector.updateFromSpeechEvent(
      speechEvent(stt.SpeechEventType.FINAL_TRANSCRIPT, "en", 0.95),
    );
    const decision = detector.updateFromSpeechEvent(
      speechEvent(stt.SpeechEventType.FINAL_TRANSCRIPT, "es", 0.96),
    );

    expect(decision).toMatchObject({
      action: "keep",
      currentLanguage: "es",
      observedLanguage: "es",
      reason: "same_language",
    });
    expect(detector.telemetry.currentLanguage).toBe("es");
    expect(detector.telemetry.candidateLanguage).toBeNull();
    expect(detector.telemetry.candidateTurns).toBe(0);
  });

  it("does not include transcript text in telemetry", () => {
    const detector = new SttLanguageDetector();

    detector.updateFromSpeechEvent(
      speechEvent(stt.SpeechEventType.FINAL_TRANSCRIPT, "es", 0.95),
    );
    detector.updateFromSpeechEvent(
      speechEvent(stt.SpeechEventType.FINAL_TRANSCRIPT, "es", 0.96),
    );

    expect(JSON.stringify(detector.telemetry)).not.toContain(
      "caller transcript",
    );
  });

  it("observes a speech event stream without changing the upstream values", async () => {
    const detector = new SttLanguageDetector();
    const onDecision = vi.fn();
    const finalEvent = speechEvent(stt.SpeechEventType.FINAL_TRANSCRIPT, "es");
    const upstream = new ReadableStream<stt.SpeechEvent | string>({
      start(controller) {
        controller.enqueue(finalEvent);
        controller.enqueue("passthrough");
        controller.close();
      },
    });

    const observed = observeSttLanguage(upstream, detector, onDecision);
    const values = [];
    for await (const value of observed) values.push(value);

    expect(values).toEqual([finalEvent, "passthrough"]);
    expect(onDecision).toHaveBeenCalledWith(
      expect.objectContaining({ action: "switch", to: "es" }),
    );
  });

  it("cancels the upstream speech event reader without canceling a locked stream", async () => {
    const cancelUpstream = vi.fn();
    const detector = new SttLanguageDetector();
    const upstream = new ReadableStream<stt.SpeechEvent | string>({
      cancel: cancelUpstream,
    });
    const observed = observeSttLanguage(upstream, detector);
    const reader = observed.getReader();

    await expect(reader.cancel("caller disconnected")).resolves.toBeUndefined();

    expect(cancelUpstream).toHaveBeenCalledWith("caller disconnected");
  });
});
