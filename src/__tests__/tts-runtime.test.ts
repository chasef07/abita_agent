import { initializeLogger } from "@livekit/agents";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  CRYSTAL_RIVER_OFFICE_PHONE,
  DEV_OFFICE_PHONE,
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
    ["demo", DEV_OFFICE_PHONE, "wawona"],
    ["production", CRYSTAL_RIVER_OFFICE_PHONE, "wawona"],
  ])(
    "constructs direct Rime for the %s trunk",
    async (_, trunkPhone, speaker) => {
      vi.stubEnv("RIME_API_KEY", "test-key");
      const [{ createTtsRuntime }, rime] = await Promise.all([
        import("../tts-runtime.js"),
        import("@livekit/agents-plugin-rime"),
      ]);

      const runtime = createTtsRuntime(trunkPhone);

      expect(runtime.provider).toBe("rime");
      expect(runtime.tts).toBeInstanceOf(rime.TTS);
      expect(runtime.optionsByLanguage.en).toEqual({
        speaker,
        ttsLanguage: "eng",
      });
      const updateOptions = vi.spyOn(runtime.tts as rime.TTS, "updateOptions");
      runtime.updateLanguage("es");
      expect(updateOptions).toHaveBeenCalledWith({
        lang: "spa",
        speaker: "luz",
      });
    },
  );
});
