import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_INWORLD_TTS_VOICE,
  INWORLD_TTS_ENCODING,
  INWORLD_TTS_MODEL,
  INWORLD_TTS_SAMPLE_RATE,
  INWORLD_TTS_SPEAKING_RATE,
  INWORLD_TTS_TEXT_NORMALIZATION,
  SPANISH_INWORLD_TTS_VOICE,
  getInworldTtsOptions,
  getInworldTtsOptionsByLanguage,
} from "../tts-config.js";

const originalVoice = process.env.INWORLD_TTS_VOICE;
const originalSpanishVoice = process.env.INWORLD_TTS_SPANISH_VOICE;

afterEach(() => {
  if (originalVoice === undefined) {
    delete process.env.INWORLD_TTS_VOICE;
  } else {
    process.env.INWORLD_TTS_VOICE = originalVoice;
  }

  if (originalSpanishVoice === undefined) {
    delete process.env.INWORLD_TTS_SPANISH_VOICE;
  } else {
    process.env.INWORLD_TTS_SPANISH_VOICE = originalSpanishVoice;
  }
});

describe("TTS config", () => {
  it("uses direct Inworld plugin TTS by default", () => {
    delete process.env.INWORLD_TTS_VOICE;

    expect(getInworldTtsOptions()).toEqual({
      model: INWORLD_TTS_MODEL,
      voice: DEFAULT_INWORLD_TTS_VOICE,
      sampleRate: INWORLD_TTS_SAMPLE_RATE,
      encoding: INWORLD_TTS_ENCODING,
      speakingRate: INWORLD_TTS_SPEAKING_RATE,
      textNormalization: INWORLD_TTS_TEXT_NORMALIZATION,
    });
  });

  it("allows the Inworld voice to be changed without code changes", () => {
    process.env.INWORLD_TTS_VOICE = "Nate";

    expect(getInworldTtsOptions().voice).toBe("Nate");
  });

  it("uses the dedicated Spanish Inworld voice for Spanish turns", () => {
    expect(getInworldTtsOptionsByLanguage("english-voice")).toEqual({
      en: {
        voice: "english-voice",
      },
      es: {
        voice: SPANISH_INWORLD_TTS_VOICE,
      },
    });
  });

  it("allows the Spanish Inworld voice to be changed without code changes", () => {
    process.env.INWORLD_TTS_SPANISH_VOICE = "Jose";

    expect(getInworldTtsOptionsByLanguage("Nate").es.voice).toBe("Jose");
  });
});
