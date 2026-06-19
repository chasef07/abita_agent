import { describe, expect, it } from "vitest";
import {
  DEFAULT_RIME_TTS_SPEAKER,
  RIME_TTS_BASE_URL,
  RIME_TTS_LANGUAGE,
  RIME_TTS_MODEL,
  RIME_TTS_SAMPLE_RATE,
  RIME_TTS_SEGMENT,
  SPANISH_RIME_TTS_LANGUAGE,
  SPANISH_RIME_TTS_SPEAKER,
  SWEETWATER_RIME_TTS_SPEAKER,
  getRimeTtsLanguageOptions,
  getRimeTtsOptions,
  getRimeTtsOptionsByLanguage,
  isSweetwaterTtsTrunk,
} from "../tts-config.js";
import {
  CRYSTAL_RIVER_OFFICE_PHONE,
  SWEETWATER_OFFICE_PHONE,
  SWEETWATER_TRUNK_PHONES,
} from "../customer/profile.js";

describe("TTS config", () => {
  it("uses Rime for the full TTS stack", () => {
    expect(RIME_TTS_MODEL).toBe("coda");
    expect(DEFAULT_RIME_TTS_SPEAKER).toBe("wawona");
    expect(SWEETWATER_RIME_TTS_SPEAKER).toBe("luz");
    expect(SPANISH_RIME_TTS_SPEAKER).toBe("luz");
  });

  it("detects Sweetwater trunks for the English speaker override", () => {
    for (const trunkPhone of SWEETWATER_TRUNK_PHONES) {
      expect(isSweetwaterTtsTrunk(trunkPhone)).toBe(true);
    }

    expect(isSweetwaterTtsTrunk(CRYSTAL_RIVER_OFFICE_PHONE)).toBe(false);
  });

  it("uses luz for Sweetwater English", () => {
    expect(
      getRimeTtsLanguageOptions({
        language: "en",
        trunkPhone: SWEETWATER_OFFICE_PHONE,
      }),
    ).toEqual({
      lang: RIME_TTS_LANGUAGE,
      speaker: SWEETWATER_RIME_TTS_SPEAKER,
    });
  });

  it("uses wawona for non-Sweetwater English", () => {
    expect(
      getRimeTtsLanguageOptions({
        language: "en",
        trunkPhone: CRYSTAL_RIVER_OFFICE_PHONE,
      }),
    ).toEqual({
      lang: RIME_TTS_LANGUAGE,
      speaker: DEFAULT_RIME_TTS_SPEAKER,
    });
  });

  it("uses luz for Spanish on every trunk", () => {
    expect(
      getRimeTtsLanguageOptions({
        language: "es",
        trunkPhone: SWEETWATER_OFFICE_PHONE,
      }),
    ).toEqual({
      lang: SPANISH_RIME_TTS_LANGUAGE,
      speaker: SPANISH_RIME_TTS_SPEAKER,
    });
    expect(
      getRimeTtsLanguageOptions({
        language: "es",
        trunkPhone: CRYSTAL_RIVER_OFFICE_PHONE,
      }),
    ).toEqual({
      lang: SPANISH_RIME_TTS_LANGUAGE,
      speaker: SPANISH_RIME_TTS_SPEAKER,
    });
  });

  it("builds the Rime websocket config with JS plugin option names", () => {
    expect(
      getRimeTtsOptions({
        language: "en",
        trunkPhone: CRYSTAL_RIVER_OFFICE_PHONE,
      }),
    ).toEqual({
      modelId: RIME_TTS_MODEL,
      speaker: DEFAULT_RIME_TTS_SPEAKER,
      lang: RIME_TTS_LANGUAGE,
      useWebsocket: true,
      segment: RIME_TTS_SEGMENT,
      baseURL: RIME_TTS_BASE_URL,
      samplingRate: RIME_TTS_SAMPLE_RATE,
    });
  });

  it("returns only mutable Rime language options for switch edges", () => {
    expect(getRimeTtsOptionsByLanguage(SWEETWATER_OFFICE_PHONE)).toEqual({
      en: {
        lang: RIME_TTS_LANGUAGE,
        speaker: SWEETWATER_RIME_TTS_SPEAKER,
      },
      es: {
        lang: SPANISH_RIME_TTS_LANGUAGE,
        speaker: SPANISH_RIME_TTS_SPEAKER,
      },
    });
  });
});
