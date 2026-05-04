import { describe, expect, it } from "vitest";
import { STT } from "@livekit/agents-plugin-assemblyai";
import {
  ASSEMBLYAI_DEFAULT_KEYTERMS,
  ASSEMBLYAI_STT_PROFILES,
  getAssemblyAISttOptions,
  getAssemblyAISttProfileOptions,
  selectAssemblyAISttProfileForAssistantText,
} from "../stt-config.js";

describe("official AssemblyAI plugin", () => {
  it("supports the current U3 Pro STT configuration", () => {
    const stt = new STT({
      apiKey: "test-api-key",
      ...getAssemblyAISttOptions(),
    });

    expect(stt.provider).toBe("AssemblyAI");
    expect(stt.model).toBe("u3-rt-pro");
    expect(getAssemblyAISttOptions().languageDetection).toBe(true);

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
    expect(ASSEMBLYAI_STT_PROFILES.insurance.keytermsPrompt).toContain(
      "Aetna Better Health of Florida",
    );
    expect(ASSEMBLYAI_STT_PROFILES.insurance.keytermsPrompt).not.toContain(
      "CHAMPVA",
    );
    expect(ASSEMBLYAI_STT_PROFILES.insurance.keytermsPrompt).not.toContain(
      "Children's Medical Services",
    );
    expect(ASSEMBLYAI_STT_PROFILES.memberId.maxTurnSilence).toBe(3000);
    expect(ASSEMBLYAI_STT_PROFILES.intake.maxTurnSilence).toBeGreaterThan(
      ASSEMBLYAI_STT_PROFILES.default.maxTurnSilence,
    );
    expect(ASSEMBLYAI_STT_PROFILES.email.keytermsPrompt).toContain(
      "icloud.com",
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
      selectAssemblyAISttProfileForAssistantText(
        "Let me confirm: I have Maria Santos, date of birth March fifth, Florida Blue, member ID A B C one two three. Is that right?",
      ),
    ).toBe("default");
  });
});
