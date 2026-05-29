import { beforeAll, describe, expect, it } from "vitest";
import { initializeLogger } from "@livekit/agents";
import { STT } from "@livekit/agents-plugin-assemblyai";
import {
  ASSEMBLYAI_DEFAULT_KEYTERMS,
  ASSEMBLYAI_STT_PROFILES,
  getAssemblyAISttOptions,
  getAssemblyAISttProfileOptions,
  selectAssemblyAISttProfileForAssistantText,
} from "../stt-config.js";

beforeAll(() => {
  initializeLogger({ pretty: false, level: "silent" });
});

describe("official AssemblyAI plugin", () => {
  it("supports the current U3 Pro STT configuration", () => {
    const stt = new STT({
      apiKey: "test-api-key",
      ...getAssemblyAISttOptions(),
    });

    expect(stt.provider).toBe("AssemblyAI");
    expect(stt.model).toBe("u3-rt-pro");
    expect(getAssemblyAISttOptions().languageDetection).toBe(true);
    expect(getAssemblyAISttOptions().keytermsPrompt).toContain(
      "Abita Eye Group",
    );
    expect(getAssemblyAISttOptions().keytermsPrompt).toContain("iCare");
    expect(getAssemblyAISttOptions().maxTurnSilence).toBe(2000);

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
      getAssemblyAISttProfileOptions("insurance").keytermsPrompt,
    ).toContain("Aetna Better Health of Florida");
    expect(
      getAssemblyAISttProfileOptions("insurance").keytermsPrompt,
    ).toContain("iCare");
    expect(
      getAssemblyAISttProfileOptions("insurance").keytermsPrompt,
    ).not.toContain("CHAMPVA");
    expect(
      getAssemblyAISttProfileOptions("insurance").keytermsPrompt,
    ).not.toContain("Children's Medical Services");
    expect(getAssemblyAISttProfileOptions("memberId").maxTurnSilence).toBe(
      3000,
    );
    expect(
      getAssemblyAISttProfileOptions("intake").maxTurnSilence,
    ).toBeGreaterThan(
      getAssemblyAISttProfileOptions("default").maxTurnSilence ?? 0,
    );
    expect(getAssemblyAISttProfileOptions("email").keytermsPrompt).toContain(
      "icloud.com",
    );
    expect(getAssemblyAISttProfileOptions("default").languageDetection).toBe(
      undefined,
    );
  });

  it("returns defensive copies of keyterm prompts for profile updates", () => {
    const profileOptions = getAssemblyAISttProfileOptions("insurance");
    profileOptions.keytermsPrompt?.push("mutated term");

    expect(
      getAssemblyAISttProfileOptions("insurance").keytermsPrompt,
    ).not.toContain("mutated term");
    expect(ASSEMBLYAI_STT_PROFILES.insurance.keytermsPrompt).not.toContain(
      "mutated term",
    );
  });

  it("does not mix AssemblyAI prompt instructions with keyterm prompts", () => {
    expect(getAssemblyAISttOptions()).not.toHaveProperty("prompt");
    expect(getAssemblyAISttProfileOptions("insurance")).not.toHaveProperty(
      "prompt",
    );
    expect(getAssemblyAISttProfileOptions("memberId")).not.toHaveProperty(
      "prompt",
    );
    expect(getAssemblyAISttProfileOptions("intake")).not.toHaveProperty(
      "prompt",
    );
    expect(getAssemblyAISttProfileOptions("email")).not.toHaveProperty(
      "prompt",
    );
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
      selectAssemblyAISttProfileForAssistantText("What's your son's name?"),
    ).toBe("intake");
    expect(
      selectAssemblyAISttProfileForAssistantText(
        "Let me confirm: I have Maria Santos, date of birth March fifth, Florida Blue, member ID A B C one two three. Is that right?",
      ),
    ).toBe("default");
  });

  it("keeps entity profiles active across short follow-up prompts", () => {
    expect(selectAssemblyAISttProfileForAssistantText("What is it?")).toBe(
      "default",
    );
    expect(
      selectAssemblyAISttProfileForAssistantText("What is it?", {
        fallbackProfile: "email",
      }),
    ).toBe("email");
    expect(
      selectAssemblyAISttProfileForAssistantText("Go ahead, spell that.", {
        fallbackProfile: "memberId",
      }),
    ).toBe("memberId");
  });
});
