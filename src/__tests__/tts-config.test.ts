import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_RIME_TTS_SPEAKER,
  RIME_TTS_MODEL_ID,
  RIME_TTS_SAMPLE_RATE,
  getRimeTtsOptions,
} from "../tts-config.js";

const originalModel = process.env.RIME_TTS_MODEL_ID;
const originalSpeaker = process.env.RIME_TTS_SPEAKER;

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
});

describe("TTS config", () => {
  it("uses direct Rime plugin TTS by default", () => {
    delete process.env.RIME_TTS_MODEL_ID;
    delete process.env.RIME_TTS_SPEAKER;

    expect(getRimeTtsOptions()).toEqual({
      modelId: RIME_TTS_MODEL_ID,
      speaker: DEFAULT_RIME_TTS_SPEAKER,
      samplingRate: RIME_TTS_SAMPLE_RATE,
    });
  });

  it("allows the Rime model and speaker to be changed without code changes", () => {
    process.env.RIME_TTS_MODEL_ID = "arcana";
    process.env.RIME_TTS_SPEAKER = "luna";

    expect(getRimeTtsOptions()).toMatchObject({
      modelId: "arcana",
      speaker: "luna",
    });
  });
});
