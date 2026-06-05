import { beforeAll, describe, expect, it } from "vitest";
import { inference, initializeLogger } from "@livekit/agents";
import {
  DEEPGRAM_FLUX_STT_LANGUAGE,
  DEEPGRAM_FLUX_STT_MODEL,
  getDeepgramFluxSttOptions,
  getDeepgramFluxSttProfileOptions,
  selectSttProfileForAssistantText,
} from "../stt-config.js";

beforeAll(() => {
  initializeLogger({ pretty: false, level: "silent" });
});

describe("LiveKit Inference Deepgram Flux STT", () => {
  it("constructs the active STT through LiveKit Inference", () => {
    const stt = new inference.STT({
      apiKey: "test-livekit-key",
      apiSecret: "test-livekit-secret",
      ...getDeepgramFluxSttOptions(),
    });

    expect(stt.provider).toBe("livekit");
    expect(stt.label).toBe("inference.STT");
    expect(stt.model).toBe(DEEPGRAM_FLUX_STT_MODEL);
  });

  it("uses multilingual Deepgram Flux while preserving profile keyterms", () => {
    const options = getDeepgramFluxSttOptions();

    expect(options.model).toBe(DEEPGRAM_FLUX_STT_MODEL);
    expect(options.language).toBe(DEEPGRAM_FLUX_STT_LANGUAGE);
    expect(options.modelOptions.detect_language).toBe(true);
    expect(options.modelOptions.keyterm).toContain("Abita Eye Group");
    expect(options.modelOptions.keyterm).toContain("iCare");
    expect(options.modelOptions.eot_timeout_ms).toBe(2000);

    expect(getDeepgramFluxSttProfileOptions("insurance").keyterm).toContain(
      "Aetna Better Health of Florida",
    );
    expect(getDeepgramFluxSttProfileOptions("memberId").keyterm).toEqual([]);
    expect(getDeepgramFluxSttProfileOptions("email").eot_timeout_ms).toBe(4000);
  });

  it("keeps the generic next-turn profile selector available to inference STT", () => {
    expect(
      selectSttProfileForAssistantText("What insurance do you have?"),
    ).toBe("insurance");
    expect(
      selectSttProfileForAssistantText("Go ahead, spell that.", {
        fallbackProfile: "memberId",
      }),
    ).toBe("memberId");
  });
});
