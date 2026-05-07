import { beforeAll, describe, expect, it } from "vitest";
import { inference, initializeLogger } from "@livekit/agents";
import {
  ASSEMBLYAI_DEFAULT_KEYTERMS,
  ASSEMBLYAI_INFERENCE_STT_MODEL_ID,
  ASSEMBLYAI_STT_PROFILES,
  getAssemblyAISttOptions,
  getAssemblyAISttProfileOptions,
  selectAssemblyAISttProfileForAssistantText,
} from "../stt-config.js";

beforeAll(() => {
  initializeLogger({ pretty: false, level: "silent" });
});

describe("AssemblyAI LiveKit Inference STT config", () => {
  it("supports the current U3 Pro inference STT configuration", () => {
    const stt = new inference.STT({
      apiKey: "test-livekit-api-key",
      apiSecret: "test-livekit-api-secret",
      ...getAssemblyAISttOptions(),
    });

    expect(stt.provider).toBe("livekit");
    expect(stt.model).toBe(ASSEMBLYAI_INFERENCE_STT_MODEL_ID);
    expect(getAssemblyAISttOptions().modelOptions.language_detection).toBe(
      true,
    );
    expect(getAssemblyAISttOptions().modelOptions.keyterms_prompt).toContain(
      "Abita Eye Group",
    );
    expect(getAssemblyAISttOptions().modelOptions.max_turn_silence).toBe(1000);

    stt.updateOptions(getAssemblyAISttProfileOptions("insurance"));
    stt.updateOptions(getAssemblyAISttProfileOptions("default"));
  });

  it("keeps startup keyterms conservative and AssemblyAI-compatible", () => {
    expect(ASSEMBLYAI_DEFAULT_KEYTERMS).toContain("Aetna Better Health");
    expect(ASSEMBLYAI_DEFAULT_KEYTERMS).toContain("Humana Medicaid");
    expect(ASSEMBLYAI_DEFAULT_KEYTERMS).toContain("Dr. Licht");
    expect(ASSEMBLYAI_DEFAULT_KEYTERMS).not.toContain("CHAMPVA");
    expect(ASSEMBLYAI_DEFAULT_KEYTERMS).not.toContain(
      "Children's Medical Services",
    );
    expect(ASSEMBLYAI_DEFAULT_KEYTERMS.length).toBeLessThanOrEqual(100);
    expect(new Set(ASSEMBLYAI_DEFAULT_KEYTERMS).size).toBe(
      ASSEMBLYAI_DEFAULT_KEYTERMS.length,
    );

    for (const term of ASSEMBLYAI_DEFAULT_KEYTERMS) {
      expect(term.length).toBeLessThanOrEqual(50);
    }
  });

  it("defines reusable STT profiles for future phase-based updates", () => {
    expect(
      getAssemblyAISttProfileOptions("insurance").modelOptions.keyterms_prompt,
    ).toContain("Aetna Better Health of Florida");
    expect(
      getAssemblyAISttProfileOptions("insurance").modelOptions.keyterms_prompt,
    ).not.toContain("CHAMPVA");
    expect(
      getAssemblyAISttProfileOptions("insurance").modelOptions.keyterms_prompt,
    ).not.toContain("Children's Medical Services");
    expect(
      getAssemblyAISttProfileOptions("memberId").modelOptions.max_turn_silence,
    ).toBe(3000);
    expect(
      getAssemblyAISttProfileOptions("intake").modelOptions.max_turn_silence,
    ).toBeGreaterThan(
      getAssemblyAISttProfileOptions("default").modelOptions.max_turn_silence ??
        0,
    );
    expect(
      getAssemblyAISttProfileOptions("email").modelOptions.keyterms_prompt,
    ).toContain("icloud.com");
    expect(
      getAssemblyAISttProfileOptions("default").modelOptions.language_detection,
    ).toBeUndefined();
  });

  it("returns defensive copies of keyterm prompts for profile updates", () => {
    const profileOptions = getAssemblyAISttProfileOptions("insurance");
    profileOptions.modelOptions.keyterms_prompt?.push("mutated term");

    expect(
      getAssemblyAISttProfileOptions("insurance").modelOptions.keyterms_prompt,
    ).not.toContain("mutated term");
    expect(ASSEMBLYAI_STT_PROFILES.insurance.keytermsPrompt).not.toContain(
      "mutated term",
    );
  });

  it("does not mix AssemblyAI prompt instructions with keyterm prompts", () => {
    expect(getAssemblyAISttOptions().modelOptions).not.toHaveProperty("prompt");
    expect(
      getAssemblyAISttProfileOptions("insurance").modelOptions,
    ).not.toHaveProperty("prompt");
    expect(
      getAssemblyAISttProfileOptions("memberId").modelOptions,
    ).not.toHaveProperty("prompt");
    expect(
      getAssemblyAISttProfileOptions("intake").modelOptions,
    ).not.toHaveProperty("prompt");
    expect(
      getAssemblyAISttProfileOptions("email").modelOptions,
    ).not.toHaveProperty("prompt");
  });

  it("selects the next-turn STT profile from assistant prompts", () => {
    expect(
      selectAssemblyAISttProfileForAssistantText("What insurance do you have?"),
    ).toBe("insurance");
    expect(
      selectAssemblyAISttProfileForAssistantText(
        "Can I get the member ID from the insurance card?",
      ),
    ).toBe("memberId");
    expect(
      selectAssemblyAISttProfileForAssistantText("What's your date of birth?"),
    ).toBe("intake");
    expect(
      selectAssemblyAISttProfileForAssistantText(
        "I have your first name, what's your date of birth?",
      ),
    ).toBe("intake");
    expect(
      selectAssemblyAISttProfileForAssistantText(
        "What's the best email address?",
      ),
    ).toBe("email");
    expect(
      selectAssemblyAISttProfileForAssistantText(
        "Let me confirm: I have Maria Santos, date of birth March fifth, Florida Blue, member ID A B C one two three. Is that right?",
      ),
    ).toBe("default");
  });
});
