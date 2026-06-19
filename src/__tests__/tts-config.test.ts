import { afterEach, describe, expect, it } from "vitest";
import {
  CARTESIA_TTS_LANGUAGE,
  CARTESIA_TTS_MODEL,
  CARTESIA_TTS_SAMPLE_RATE,
  DEFAULT_RIME_TTS_SPEAKER,
  DEFAULT_CARTESIA_TTS_VOICE,
  SPANISH_CARTESIA_TTS_VOICE,
  RIME_TTS_BASE_URL,
  RIME_TTS_DEMO_TRUNK_PHONE,
  RIME_TTS_LANGUAGE,
  RIME_TTS_MODEL,
  RIME_TTS_SAMPLE_RATE,
  RIME_TTS_SEGMENT,
  getCartesiaTtsOptions,
  getCartesiaTtsOptionsByLanguage,
  getRimeTtsOptions,
  ttsProviderForTrunk,
} from "../tts-config.js";
import {
  SPRING_HILL_813_TRUNK_PHONE,
  SPRING_HILL_OFFICE_PHONE,
} from "../customer/profile.js";

const originalEnv = {
  CARTESIA_TTS_VOICE: process.env.CARTESIA_TTS_VOICE,
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
  restoreEnv("RIME_TTS_SPEAKER");
  restoreEnv("TTS_PROVIDER");
});

describe("TTS config", () => {
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

  it("ignores stale provider overrides and keeps Cartesia active", () => {
    process.env.TTS_PROVIDER = "legacy-provider";

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

  it("uses Rime for demo and Spring Hill trunks", () => {
    expect(ttsProviderForTrunk(RIME_TTS_DEMO_TRUNK_PHONE)).toBe("rime");
    expect(ttsProviderForTrunk("4843989071")).toBe("rime");
    expect(ttsProviderForTrunk(SPRING_HILL_OFFICE_PHONE)).toBe("rime");
    expect(ttsProviderForTrunk(SPRING_HILL_813_TRUNK_PHONE)).toBe("rime");
    expect(ttsProviderForTrunk("+13523202007")).toBe("cartesia");
  });

  it("builds the Rime websocket config with JS plugin option names", () => {
    delete process.env.RIME_TTS_SPEAKER;

    expect(DEFAULT_RIME_TTS_SPEAKER).toBe("wawona");
    expect(getRimeTtsOptions()).toEqual({
      modelId: RIME_TTS_MODEL,
      speaker: DEFAULT_RIME_TTS_SPEAKER,
      lang: RIME_TTS_LANGUAGE,
      useWebsocket: true,
      segment: RIME_TTS_SEGMENT,
      baseURL: RIME_TTS_BASE_URL,
      samplingRate: RIME_TTS_SAMPLE_RATE,
    });
  });

  it("allows the Rime speaker to be changed without code changes", () => {
    process.env.RIME_TTS_SPEAKER = "marin";

    expect(getRimeTtsOptions().speaker).toBe("marin");
  });
});
