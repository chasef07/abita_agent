import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RIME_TTS_BASE_URL,
  RIME_TTS_LANGUAGE,
  RIME_TTS_MODEL,
  RIME_TTS_SAMPLE_RATE,
  RIME_TTS_SEGMENT,
  SPANISH_RIME_TTS_LANGUAGE,
  getRimeTtsOptions,
  getRimeTtsOptionsByLanguage,
} from "../tts-config.js";
import {
  CRYSTAL_RIVER_OFFICE_PHONE,
  DEV_OFFICE_PHONE,
  HOLLYWOOD_OFFICE_PHONE,
  NORTH_MIAMI_BEACH_OPTICAL_OFFICE_PHONE,
  SPRING_HILL_OFFICE_PHONE,
  SWEETWATER_OFFICE_PHONE,
} from "../customers/abita/profile.js";

const require = createRequire(import.meta.url);

describe("TTS config", () => {
  it("uses Rime segment never for every office", () => {
    const trunkPhones = [
      SPRING_HILL_OFFICE_PHONE,
      CRYSTAL_RIVER_OFFICE_PHONE,
      HOLLYWOOD_OFFICE_PHONE,
      SWEETWATER_OFFICE_PHONE,
      NORTH_MIAMI_BEACH_OPTICAL_OFFICE_PHONE,
      DEV_OFFICE_PHONE,
    ];

    expect(RIME_TTS_SEGMENT).toBe("never");
    expect(
      trunkPhones.map(
        (trunkPhone) => getRimeTtsOptions({ trunkPhone }).segment,
      ),
    ).toEqual(["never", "never", "never", "never", "never", "never"]);
  });

  it("builds the Rime websocket config with documented language option names", () => {
    expect(
      getRimeTtsOptions({
        language: "en",
        trunkPhone: CRYSTAL_RIVER_OFFICE_PHONE,
      }),
    ).toEqual({
      modelId: RIME_TTS_MODEL,
      speaker: "wawona",
      lang: RIME_TTS_LANGUAGE,
      useWebsocket: true,
      segment: RIME_TTS_SEGMENT,
      baseURL: RIME_TTS_BASE_URL,
      samplingRate: RIME_TTS_SAMPLE_RATE,
    });

    expect(
      getRimeTtsOptions({
        language: "es",
        trunkPhone: CRYSTAL_RIVER_OFFICE_PHONE,
      }),
    ).not.toHaveProperty("language");
  });

  it("returns only mutable Rime language options for switch edges", () => {
    expect(getRimeTtsOptionsByLanguage(SWEETWATER_OFFICE_PHONE)).toEqual({
      en: {
        lang: RIME_TTS_LANGUAGE,
        speaker: "luz",
      },
      es: {
        lang: SPANISH_RIME_TTS_LANGUAGE,
        speaker: "luz",
      },
    });
  });

  it("forwards Rime language through the documented websocket query parameter", () => {
    const rimeEntry = require.resolve("@livekit/agents-plugin-rime");
    const ttsSource = readFileSync(join(dirname(rimeEntry), "tts.js"), "utf8");

    expect(ttsSource).toContain("params.lang = opts.lang");
    expect(ttsSource).not.toContain("params.language");
  });
});
