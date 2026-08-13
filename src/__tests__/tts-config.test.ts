import { describe, expect, it } from "vitest";
import {
  CRYSTAL_RIVER_OFFICE_PHONE,
  DEV_OFFICE_PHONE,
  HOLLYWOOD_OFFICE_PHONE,
  NORTH_MIAMI_BEACH_OPTICAL_OFFICE_PHONE,
  SPRING_HILL_OFFICE_PHONE,
  SWEETWATER_OFFICE_PHONE,
} from "../customers/abita/profile.js";
import {
  RIME_TTS_MODEL,
  RIME_TTS_SAMPLE_RATE,
  getRimeTtsOptions,
} from "../tts-config.js";

describe("TTS config", () => {
  it.each([
    [SPRING_HILL_OFFICE_PHONE, "wawona"],
    [CRYSTAL_RIVER_OFFICE_PHONE, "wawona"],
    [HOLLYWOOD_OFFICE_PHONE, "wawona"],
    [SWEETWATER_OFFICE_PHONE, "luz"],
    [NORTH_MIAMI_BEACH_OPTICAL_OFFICE_PHONE, "luz"],
    [DEV_OFFICE_PHONE, "wawona"],
  ])(
    "maps office %s to its Rime voice through LiveKit Inference",
    (trunkPhone, voice) => {
      expect(getRimeTtsOptions({ trunkPhone })).toEqual({
        language: "en",
        model: RIME_TTS_MODEL,
        sampleRate: RIME_TTS_SAMPLE_RATE,
        voice,
      });
    },
  );

  it("maps Spanish to the configured Rime voice and language", () => {
    expect(
      getRimeTtsOptions({
        language: "es",
        trunkPhone: CRYSTAL_RIVER_OFFICE_PHONE,
      }),
    ).toEqual({
      language: "es",
      model: "rime/coda",
      sampleRate: 16000,
      voice: "luz",
    });
  });
});
