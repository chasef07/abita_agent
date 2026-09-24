import { describe, expect, it } from "vitest";
import {
  getRimeTtsOptions,
  getRimeTtsOptionsByLanguage,
} from "../tts-config.js";
import {
  CRYSTAL_RIVER_OFFICE_PHONE,
  RHEUMATOLOGY_DEMO_TRUNK_PHONE,
  HOLLYWOOD_OFFICE_PHONE,
  NEW_TAMPA_DEMO_TRUNK_PHONE,
  NORTH_MIAMI_BEACH_OPTICAL_OFFICE_PHONE,
  OPHTHALMOLOGY_DEMO_TRUNK_PHONE,
  SPRING_HILL_OFFICE_PHONE,
  SWEETWATER_OFFICE_PHONE,
} from "../customers/abita/profile.js";

describe("TTS config", () => {
  it("uses LiveKit Inference Rime for every office", () => {
    const trunkPhones = [
      SPRING_HILL_OFFICE_PHONE,
      CRYSTAL_RIVER_OFFICE_PHONE,
      HOLLYWOOD_OFFICE_PHONE,
      SWEETWATER_OFFICE_PHONE,
      NORTH_MIAMI_BEACH_OPTICAL_OFFICE_PHONE,
      OPHTHALMOLOGY_DEMO_TRUNK_PHONE,
      NEW_TAMPA_DEMO_TRUNK_PHONE,
      RHEUMATOLOGY_DEMO_TRUNK_PHONE,
    ];

    for (const trunkPhone of trunkPhones) {
      expect(getRimeTtsOptions({ trunkPhone }).model).toBe("rime/coda");
    }
  });

  it("builds the LiveKit Inference config with two-letter language codes", () => {
    expect(
      getRimeTtsOptions({
        language: "en",
        trunkPhone: CRYSTAL_RIVER_OFFICE_PHONE,
      }),
    ).toEqual({
      model: "rime/coda",
      voice: "wawona",
      language: "en",
      sampleRate: 16000,
    });

    expect(
      getRimeTtsOptions({
        language: "es",
        trunkPhone: CRYSTAL_RIVER_OFFICE_PHONE,
      }),
    ).toHaveProperty("language", "es");
  });

  it("returns mutable Inference language and voice options for switch edges", () => {
    expect(getRimeTtsOptionsByLanguage(SWEETWATER_OFFICE_PHONE)).toEqual({
      en: {
        language: "en",
        voice: "luz",
      },
      es: {
        language: "es",
        voice: "luz",
      },
    });
  });

  it("uses the production Inference configuration for the demo office", () => {
    expect(
      getRimeTtsOptions({ trunkPhone: RHEUMATOLOGY_DEMO_TRUNK_PHONE }),
    ).toEqual({
      model: "rime/coda",
      voice: "wawona",
      language: "en",
      sampleRate: 16000,
    });
    expect(
      getRimeTtsOptions({
        language: "es",
        trunkPhone: RHEUMATOLOGY_DEMO_TRUNK_PHONE,
      }),
    ).toMatchObject({ language: "es", voice: "luz" });
  });
});
