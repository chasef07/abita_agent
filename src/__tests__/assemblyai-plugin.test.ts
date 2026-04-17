import { describe, expect, it } from "vitest";
import { STT } from "@livekit/agents-plugin-assemblyai";

describe("official AssemblyAI plugin", () => {
  it("supports the current U3 Pro STT configuration", () => {
    const stt = new STT({
      apiKey: "test-api-key",
      speechModel: "u3-rt-pro",
      vadThreshold: 0.3,
      minTurnSilence: 250,
      maxTurnSilence: 2000,
    });

    expect(stt.provider).toBe("AssemblyAI");
    expect(stt.model).toBe("u3-rt-pro");

    stt.updateOptions({
      minTurnSilence: 500,
      maxTurnSilence: 3000,
      vadThreshold: 0.4,
    });
  });
});
