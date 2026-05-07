import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_INWORLD_TTS_VOICE,
  INWORLD_TTS_ENGLISH_LANGUAGE,
  INWORLD_TTS_MODEL_ID,
  INWORLD_TTS_SAMPLE_RATE,
  INWORLD_TTS_SPANISH_LANGUAGE,
  SPANISH_INWORLD_TTS_VOICE,
  getInworldTtsOptions,
  getInworldTtsOptionsByLanguage,
} from "../tts-config.js";

const originalModel = process.env.INWORLD_TTS_MODEL_ID;
const originalVoice = process.env.INWORLD_TTS_VOICE;
const originalSpanishVoice = process.env.INWORLD_TTS_SPANISH_VOICE;

afterEach(() => {
  if (originalModel === undefined) {
    delete process.env.INWORLD_TTS_MODEL_ID;
  } else {
    process.env.INWORLD_TTS_MODEL_ID = originalModel;
  }

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
  it("uses LiveKit Inference Inworld TTS by default", () => {
    delete process.env.INWORLD_TTS_MODEL_ID;
    delete process.env.INWORLD_TTS_VOICE;

    expect(getInworldTtsOptions()).toEqual({
      model: INWORLD_TTS_MODEL_ID,
      voice: DEFAULT_INWORLD_TTS_VOICE,
      language: INWORLD_TTS_ENGLISH_LANGUAGE,
      sampleRate: INWORLD_TTS_SAMPLE_RATE,
    });
  });

  it("allows the Inworld model and voice to be changed without code changes", () => {
    process.env.INWORLD_TTS_MODEL_ID = "inworld/inworld-tts-1.5-max";
    process.env.INWORLD_TTS_VOICE = "Ashley";

    expect(getInworldTtsOptions()).toMatchObject({
      model: "inworld/inworld-tts-1.5-max",
      voice: "Ashley",
    });
  });

  it("uses Sarah for Spanish turns and restores the English Inworld voice", () => {
    delete process.env.INWORLD_TTS_SPANISH_VOICE;

    expect(getInworldTtsOptionsByLanguage("english-voice")).toEqual({
      en: {
        model: INWORLD_TTS_MODEL_ID,
        voice: "english-voice",
        language: INWORLD_TTS_ENGLISH_LANGUAGE,
      },
      es: {
        model: INWORLD_TTS_MODEL_ID,
        voice: SPANISH_INWORLD_TTS_VOICE,
        language: INWORLD_TTS_SPANISH_LANGUAGE,
      },
    });
  });

  it("allows the Spanish Inworld voice to be changed without code changes", () => {
    process.env.INWORLD_TTS_SPANISH_VOICE = "Ashley";

    expect(getInworldTtsOptionsByLanguage("Sarah").es.voice).toBe("Ashley");
  });

  it("uses the configured Inworld model for every language update", () => {
    process.env.INWORLD_TTS_MODEL_ID = "inworld/inworld-tts-1.5-mini";
    delete process.env.INWORLD_TTS_SPANISH_VOICE;

    expect(getInworldTtsOptionsByLanguage("Sarah").es).toMatchObject({
      model: "inworld/inworld-tts-1.5-mini",
      voice: SPANISH_INWORLD_TTS_VOICE,
      language: INWORLD_TTS_SPANISH_LANGUAGE,
    });
  });
});
