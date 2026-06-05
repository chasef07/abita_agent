import { afterEach, describe, expect, it } from "vitest";
import {
  CARTESIA_TTS_LANGUAGE,
  CARTESIA_TTS_MODEL,
  CARTESIA_TTS_SAMPLE_RATE,
  DEFAULT_RIME_TTS_SPEAKER,
  DEFAULT_CARTESIA_TTS_VOICE,
  DEFAULT_TTS_PROVIDER,
  RIME_TTS_EAST_BASE_URL,
  RIME_TTS_LANGUAGE,
  RIME_TTS_MODEL,
  RIME_TTS_SEGMENT,
  RIME_TTS_USE_WEBSOCKET,
  SPANISH_CARTESIA_TTS_VOICE,
  SPANISH_RIME_TTS_LANGUAGE,
  SPANISH_RIME_TTS_SPEAKER,
  getActiveTtsProvider,
  getCartesiaTtsOptions,
  getCartesiaTtsOptionsByLanguage,
  getRimeTtsOptions,
  getRimeTtsOptionsByLanguage,
} from "../tts-config.js";

const originalEnv = {
  CARTESIA_TTS_VOICE: process.env.CARTESIA_TTS_VOICE,
  RIME_API_KEY: process.env.RIME_API_KEY,
  RIME_TTS_BASE_URL: process.env.RIME_TTS_BASE_URL,
  RIME_TTS_SPEAKER: process.env.RIME_TTS_SPEAKER,
  TTS_PROVIDER: process.env.TTS_PROVIDER,
};

function restoreEnv(name: keyof typeof originalEnv) {
  const value = originalEnv[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

afterEach(() => {
  restoreEnv("CARTESIA_TTS_VOICE");
  restoreEnv("RIME_API_KEY");
  restoreEnv("RIME_TTS_BASE_URL");
  restoreEnv("RIME_TTS_SPEAKER");
  restoreEnv("TTS_PROVIDER");
});

describe("TTS config", () => {
  it("uses Cartesia by default", () => {
    delete process.env.TTS_PROVIDER;

    expect(DEFAULT_TTS_PROVIDER).toBe("cartesia");
    expect(getActiveTtsProvider()).toBe("cartesia");
  });

  it("allows Rime to be selected without code changes", () => {
    process.env.TTS_PROVIDER = "rime";

    expect(getActiveTtsProvider()).toBe("rime");
  });

  it("uses Rime coda websocket TTS on the east endpoint", () => {
    delete process.env.RIME_API_KEY;
    delete process.env.RIME_TTS_BASE_URL;
    delete process.env.RIME_TTS_SPEAKER;

    expect(RIME_TTS_MODEL).toBe("coda");
    expect(getRimeTtsOptions()).toEqual({
      modelId: RIME_TTS_MODEL,
      speaker: DEFAULT_RIME_TTS_SPEAKER,
      lang: RIME_TTS_LANGUAGE,
      useWebsocket: RIME_TTS_USE_WEBSOCKET,
      segment: RIME_TTS_SEGMENT,
      baseURL: RIME_TTS_EAST_BASE_URL,
    });
  });

  it("allows Rime voice and API key to be changed without code changes", () => {
    process.env.RIME_API_KEY = "rime-key";
    process.env.RIME_TTS_SPEAKER = "wawona";

    expect(getRimeTtsOptions()).toEqual(
      expect.objectContaining({
        apiKey: "rime-key",
        speaker: "wawona",
      }),
    );
  });

  it("normalizes Rime websocket base URLs before the plugin appends ws3", () => {
    process.env.RIME_TTS_BASE_URL = "wss://users-east-ws.rime.ai/ws3";

    expect(getRimeTtsOptions().baseURL).toBe(RIME_TTS_EAST_BASE_URL);
  });

  it("keeps Rime language options available for language switching", () => {
    expect(getRimeTtsOptionsByLanguage("vespera")).toEqual({
      en: {
        lang: RIME_TTS_LANGUAGE,
        speaker: "vespera",
      },
      es: {
        lang: SPANISH_RIME_TTS_LANGUAGE,
        speaker: SPANISH_RIME_TTS_SPEAKER,
      },
    });
  });

  it("keeps Cartesia Sonic 3.5 config available", () => {
    expect(CARTESIA_TTS_MODEL).toBe("sonic-3.5");
  });

  it("keeps direct Cartesia plugin TTS available", () => {
    delete process.env.CARTESIA_TTS_VOICE;

    expect(getCartesiaTtsOptions()).toEqual({
      model: CARTESIA_TTS_MODEL,
      voice: DEFAULT_CARTESIA_TTS_VOICE,
      language: CARTESIA_TTS_LANGUAGE,
      sampleRate: CARTESIA_TTS_SAMPLE_RATE,
    });
  });

  it("allows the Cartesia voice to be changed without code changes", () => {
    process.env.CARTESIA_TTS_VOICE = "blake";

    expect(getCartesiaTtsOptions().voice).toBe("blake");
  });

  it("ignores a blank Cartesia voice override", () => {
    process.env.CARTESIA_TTS_VOICE = "";

    expect(getCartesiaTtsOptions().voice).toBe(DEFAULT_CARTESIA_TTS_VOICE);
    expect(getCartesiaTtsOptionsByLanguage().en.voice).toBe(
      DEFAULT_CARTESIA_TTS_VOICE,
    );
  });

  it("uses the dedicated Spanish Cartesia voice for Spanish turns", () => {
    expect(SPANISH_CARTESIA_TTS_VOICE).toBe(
      "b4b8e2af-6139-466e-a93a-30c20d2e1fc5",
    );

    expect(getCartesiaTtsOptionsByLanguage("english-voice")).toEqual({
      en: {
        language: "en",
        voice: "english-voice",
      },
      es: {
        language: "es",
        voice: SPANISH_CARTESIA_TTS_VOICE,
      },
    });
  });
});
