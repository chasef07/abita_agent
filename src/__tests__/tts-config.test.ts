import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_INWORLD_TTS_VOICE,
  getInworldTtsOptions,
  INWORLD_TTS_LANGUAGE,
  INWORLD_TTS_MODEL,
} from "../tts-config.js";

const originalVoice = process.env.INWORLD_TTS_VOICE;

afterEach(() => {
  if (originalVoice === undefined) {
    delete process.env.INWORLD_TTS_VOICE;
  } else {
    process.env.INWORLD_TTS_VOICE = originalVoice;
  }
});

describe("TTS config", () => {
  it("uses LiveKit Inference Inworld TTS by default", () => {
    delete process.env.INWORLD_TTS_VOICE;

    expect(getInworldTtsOptions()).toEqual({
      model: INWORLD_TTS_MODEL,
      voice: DEFAULT_INWORLD_TTS_VOICE,
      language: INWORLD_TTS_LANGUAGE,
    });
  });

  it("allows the Inworld voice to be changed without code changes", () => {
    process.env.INWORLD_TTS_VOICE = "Ashley";

    expect(getInworldTtsOptions().voice).toBe("Ashley");
  });
});
