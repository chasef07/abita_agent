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
  it("uses Rime segment never for every office", () => {
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
      expect(getRimeTtsOptions({ trunkPhone }).segment).toBe("never");
    }
  });

  it("builds the Rime websocket config with documented language option names", () => {
    expect(
      getRimeTtsOptions({
        language: "en",
        trunkPhone: CRYSTAL_RIVER_OFFICE_PHONE,
      }),
    ).toEqual({
      modelId: "coda",
      speaker: "wawona",
      lang: "eng",
      useWebsocket: true,
      segment: "never",
      baseURL: "wss://users-east-ws.rime.ai",
      samplingRate: 16000,
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
        lang: "eng",
        speaker: "luz",
      },
      es: {
        lang: "spa",
        speaker: "luz",
      },
    });
  });

  it("uses the production Rime websocket configuration for the demo office", () => {
    expect(
      getRimeTtsOptions({ trunkPhone: RHEUMATOLOGY_DEMO_TRUNK_PHONE }),
    ).toEqual({
      modelId: "coda",
      speaker: "wawona",
      lang: "eng",
      useWebsocket: true,
      segment: "never",
      baseURL: "wss://users-east-ws.rime.ai",
      samplingRate: 16000,
    });
    expect(
      getRimeTtsOptions({
        language: "es",
        trunkPhone: RHEUMATOLOGY_DEMO_TRUNK_PHONE,
      }),
    ).toMatchObject({ lang: "spa", speaker: "luz" });
  });
});
