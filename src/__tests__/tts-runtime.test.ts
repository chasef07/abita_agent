import { inference, initializeLogger } from "@livekit/agents";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  CRYSTAL_RIVER_OFFICE_PHONE,
  DEV_OFFICE_PHONE,
} from "../customers/abita/profile.js";
import { RIME_TTS_MODEL, RIME_TTS_SAMPLE_RATE } from "../tts-config.js";

beforeAll(() => {
  initializeLogger({ level: "silent", pretty: false });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("TTS runtime", () => {
  it.each([DEV_OFFICE_PHONE, CRYSTAL_RIVER_OFFICE_PHONE])(
    "constructs Rime through LiveKit Inference for office %s",
    async (trunkPhone) => {
      vi.stubEnv("LIVEKIT_API_KEY", "test-key");
      vi.stubEnv("LIVEKIT_API_SECRET", "test-secret");
      vi.resetModules();
      const { createTtsRuntime } = await import("../tts-runtime.js");

      const runtime = createTtsRuntime(trunkPhone);

      expect(runtime.provider).toBe("rime-inference");
      expect(runtime.tts.label).toBe("inference.TTS");
      expect(runtime.tts.model).toBe(RIME_TTS_MODEL);
      expect(runtime.tts.sampleRate).toBe(RIME_TTS_SAMPLE_RATE);
      expect(runtime.optionsByLanguage).toEqual({
        en: { speaker: "wawona", ttsLanguage: "en" },
        es: { speaker: "luz", ttsLanguage: "es" },
      });
    },
  );

  it("updates the LiveKit Inference language and Rime voice together", async () => {
    vi.stubEnv("LIVEKIT_API_KEY", "test-key");
    vi.stubEnv("LIVEKIT_API_SECRET", "test-secret");
    vi.resetModules();
    const { createTtsRuntime } = await import("../tts-runtime.js");
    const runtime = createTtsRuntime(CRYSTAL_RIVER_OFFICE_PHONE);
    const updateOptions = vi.spyOn(
      runtime.tts as inference.TTS,
      "updateOptions",
    );

    runtime.updateLanguage("es");

    expect(updateOptions).toHaveBeenCalledWith({
      language: "es",
      voice: "luz",
    });
  });
});
