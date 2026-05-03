import { afterEach, describe, expect, it } from "vitest";
import {
  CARTESIA_TTS_LANGUAGE,
  CARTESIA_TTS_MODEL,
  DEFAULT_CARTESIA_TTS_VOICE,
  getCartesiaTtsOptions,
} from "../tts-config.js";

const originalVoice = process.env.CARTESIA_TTS_VOICE;

afterEach(() => {
  if (originalVoice === undefined) {
    delete process.env.CARTESIA_TTS_VOICE;
  } else {
    process.env.CARTESIA_TTS_VOICE = originalVoice;
  }
});

describe("TTS config", () => {
  it("uses LiveKit Inference Cartesia TTS by default", () => {
    delete process.env.CARTESIA_TTS_VOICE;

    expect(getCartesiaTtsOptions()).toEqual({
      model: CARTESIA_TTS_MODEL,
      voice: DEFAULT_CARTESIA_TTS_VOICE,
      language: CARTESIA_TTS_LANGUAGE,
    });
  });

  it("allows the Cartesia voice to be changed without code changes", () => {
    process.env.CARTESIA_TTS_VOICE = "blake";

    expect(getCartesiaTtsOptions().voice).toBe("blake");
  });
});
