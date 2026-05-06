import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_RIME_TTS_SPEAKER,
  RIME_TTS_BASE_URL,
  RIME_TTS_MODEL_ID,
  RIME_TTS_SAMPLE_RATE,
  getRimeTtsOptions,
} from "../tts-config.js";

const originalModel = process.env.RIME_TTS_MODEL_ID;
const originalSpeaker = process.env.RIME_TTS_SPEAKER;
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
      samplingRate: RIME_TTS_SAMPLE_RATE,
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
});
