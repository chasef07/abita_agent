import { inference, initializeLogger } from "@livekit/agents";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  CRYSTAL_RIVER_OFFICE_PHONE,
  DEV_OFFICE_PHONE,
} from "../customers/abita/profile.js";
import {
  RIME_INFERENCE_TTS_MODEL,
  RIME_TTS_SAMPLE_RATE,
} from "../tts-config.js";

beforeAll(() => {
  initializeLogger({ level: "silent", pretty: false });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("TTS runtime", () => {
  it("constructs Rime through LiveKit Inference only for the demo trunk", async () => {
    vi.stubEnv("LIVEKIT_API_KEY", "test-key");
    vi.stubEnv("LIVEKIT_API_SECRET", "test-secret");
    vi.stubEnv("RIME_API_KEY", "test-key");
    vi.resetModules();
    const { createTtsRuntime } = await import("../tts-runtime.js");

    const runtime = createTtsRuntime(DEV_OFFICE_PHONE);

    expect(runtime.provider).toBe("rime-inference");
    expect(runtime.tts.label).toBe("inference.TTS");
    expect(runtime.tts.model).toBe(RIME_INFERENCE_TTS_MODEL);
    expect(runtime.tts.sampleRate).toBe(RIME_TTS_SAMPLE_RATE);
    expect(runtime.optionsByLanguage).toEqual({
      en: { speaker: "wawona", ttsLanguage: "en" },
      es: { speaker: "luz", ttsLanguage: "es" },
    });

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

  it("keeps production trunks on Rime", async () => {
    vi.stubEnv("RIME_API_KEY", "test-key");
    const [{ createTtsRuntime }, rime] = await Promise.all([
      import("../tts-runtime.js"),
      import("@livekit/agents-plugin-rime"),
    ]);

    const runtime = createTtsRuntime(CRYSTAL_RIVER_OFFICE_PHONE);

    expect(runtime.provider).toBe("rime");
    expect(runtime.tts).toBeInstanceOf(rime.TTS);
    const updateOptions = vi.spyOn(runtime.tts as rime.TTS, "updateOptions");
    runtime.updateLanguage("es");
    expect(updateOptions).toHaveBeenCalledWith({
      lang: "spa",
      speaker: "luz",
    });
  });
});
