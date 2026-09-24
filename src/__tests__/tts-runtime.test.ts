import { inference, initializeLogger } from "@livekit/agents";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  CRYSTAL_RIVER_OFFICE_PHONE,
  RHEUMATOLOGY_DEMO_TRUNK_PHONE,
} from "../customers/abita/profile.js";

beforeAll(() => {
  initializeLogger({ level: "silent", pretty: false });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("TTS runtime", () => {
  it.each([
    ["demo", RHEUMATOLOGY_DEMO_TRUNK_PHONE, "wawona"],
    ["production", CRYSTAL_RIVER_OFFICE_PHONE, "wawona"],
  ])(
    "constructs LiveKit Inference Rime for the %s trunk",
    async (_, trunkPhone, speaker) => {
      vi.stubEnv("RIME_API_KEY", "");
      vi.stubEnv("LIVEKIT_API_KEY", "test-key");
      vi.stubEnv("LIVEKIT_API_SECRET", "test-secret");
      const { createTtsRuntime } = await import("../tts-runtime.js");

      const runtime = createTtsRuntime(trunkPhone);

      expect(runtime.provider).toBe("rime");
      expect(runtime.tts).toBeInstanceOf(inference.TTS);
      expect(runtime.optionsByLanguage.en).toEqual({
        speaker,
        ttsLanguage: "en",
      });
      const updateOptions = vi.spyOn(
        runtime.tts as InstanceType<typeof inference.TTS>,
        "updateOptions",
      );
      runtime.updateLanguage("es");
      expect(updateOptions).toHaveBeenCalledWith({
        language: "es",
        voice: "luz",
      });
    },
  );
});
