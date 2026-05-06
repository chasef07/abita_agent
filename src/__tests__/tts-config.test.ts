import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_RIME_TTS_SPEAKER,
  RIME_TTS_BASE_URL,
  RIME_TTS_ENGLISH_LANGUAGE,
  RIME_TTS_MODEL_ID,
  RIME_TTS_SAMPLE_RATE,
  RIME_TTS_SPANISH_LANGUAGE,
  RIME_TTS_SPEED_ALPHA,
  SPANISH_RIME_TTS_SPEAKER,
  getRimeTtsOptions,
  getRimeTtsOptionsByLanguage,
} from "../tts-config.js";

const originalModel = process.env.RIME_TTS_MODEL_ID;
const originalSpeaker = process.env.RIME_TTS_SPEAKER;
const originalSpanishSpeaker = process.env.RIME_TTS_SPANISH_SPEAKER;
const originalBaseUrl = process.env.RIME_TTS_BASE_URL;

afterEach(() => {
  if (originalModel === undefined) {
    delete process.env.RIME_TTS_MODEL_ID;
  } else {
    process.env.RIME_TTS_MODEL_ID = originalModel;
  }

  if (originalSpeaker === undefined) {
    delete process.env.RIME_TTS_SPEAKER;
  } else {
    process.env.RIME_TTS_SPEAKER = originalSpeaker;
  }

  if (originalSpanishSpeaker === undefined) {
    delete process.env.RIME_TTS_SPANISH_SPEAKER;
  } else {
    process.env.RIME_TTS_SPANISH_SPEAKER = originalSpanishSpeaker;
  }

  if (originalBaseUrl === undefined) {
    delete process.env.RIME_TTS_BASE_URL;
  } else {
    process.env.RIME_TTS_BASE_URL = originalBaseUrl;
  }
});

describe("TTS config", () => {
  it("uses direct Rime plugin TTS by default", () => {
    delete process.env.RIME_TTS_MODEL_ID;
    delete process.env.RIME_TTS_SPEAKER;
    delete process.env.RIME_TTS_BASE_URL;

    expect(getRimeTtsOptions()).toEqual({
      modelId: RIME_TTS_MODEL_ID,
      speaker: DEFAULT_RIME_TTS_SPEAKER,
      baseURL: RIME_TTS_BASE_URL,
      lang: RIME_TTS_ENGLISH_LANGUAGE,
      samplingRate: RIME_TTS_SAMPLE_RATE,
      speedAlpha: RIME_TTS_SPEED_ALPHA,
    });
  });

  it("allows the Rime model, speaker, and base URL to be changed without code changes", () => {
    process.env.RIME_TTS_MODEL_ID = "arcana";
    process.env.RIME_TTS_SPEAKER = "luna";
    process.env.RIME_TTS_BASE_URL = "https://users.rime.ai/v1/rime-tts";

    expect(getRimeTtsOptions()).toMatchObject({
      modelId: "arcana",
      speaker: "luna",
      baseURL: "https://users.rime.ai/v1/rime-tts",
    });
  });

  it("uses Luz for Spanish turns and restores the English Rime speaker", () => {
    delete process.env.RIME_TTS_SPANISH_SPEAKER;

    expect(getRimeTtsOptionsByLanguage("english-speaker")).toEqual({
      en: {
        modelId: RIME_TTS_MODEL_ID,
        speaker: "english-speaker",
        lang: RIME_TTS_ENGLISH_LANGUAGE,
      },
      es: {
        modelId: RIME_TTS_MODEL_ID,
        speaker: SPANISH_RIME_TTS_SPEAKER,
        lang: RIME_TTS_SPANISH_LANGUAGE,
      },
    });
  });

  it("allows the Spanish Rime speaker to be changed without code changes", () => {
    process.env.RIME_TTS_SPANISH_SPEAKER = "mari";

    expect(getRimeTtsOptionsByLanguage("vespera").es.speaker).toBe("mari");
  });

  it("uses the configured Rime model for every language update", () => {
    process.env.RIME_TTS_MODEL_ID = "mistv2";
    delete process.env.RIME_TTS_SPANISH_SPEAKER;

    expect(getRimeTtsOptionsByLanguage("vespera").es).toMatchObject({
      modelId: "mistv2",
      speaker: SPANISH_RIME_TTS_SPEAKER,
      lang: RIME_TTS_SPANISH_LANGUAGE,
    });
  });
});
