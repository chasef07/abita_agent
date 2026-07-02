import { beforeAll, describe, expect, it } from "vitest";
import { initializeLogger } from "@livekit/agents";
import { STT } from "@livekit/agents-plugin-assemblyai";
import {
  ASSEMBLYAI_AGENT_CONTEXT_MAX_CHARS,
  ASSEMBLYAI_DEFAULT_KEYTERMS,
  ASSEMBLYAI_INACTIVITY_TIMEOUT_SECONDS,
  ASSEMBLYAI_STT_PROFILES,
  getAssemblyAIAgentContext,
  getAssemblyAISttOptions,
  getAssemblyAISttProfileOptions,
  selectAssemblyAISttProfileForAssistantText,
} from "../stt-config.js";

beforeAll(() => {
  initializeLogger({ pretty: false, level: "silent" });
});

describe("official AssemblyAI plugin", () => {
  it("supports the current Universal-3.5 Pro STT configuration", () => {
    const stt = new STT({
      apiKey: "test-api-key",
      ...getAssemblyAISttOptions(),
    });

    expect(stt.provider).toBe("AssemblyAI");
    expect(stt.model).toBe("universal-3-5-pro");
    expect(getAssemblyAISttOptions().languageDetection).toBe(true);
    expect(getAssemblyAISttOptions().keytermsPrompt).toContain(
      "Abita Eye Group",
    );
    expect(getAssemblyAISttOptions().keytermsPrompt).toContain("iCare");
    expect(getAssemblyAISttOptions().maxTurnSilence).toBe(2000);
    expect(getAssemblyAISttOptions().voiceFocus).toBe("near-field");
    expect(getAssemblyAISttOptions()).not.toHaveProperty("voiceFocusThreshold");
    expect(getAssemblyAISttOptions()).not.toHaveProperty("agentContext");
    expect(getAssemblyAISttOptions().inactivityTimeout).toBe(
      ASSEMBLYAI_INACTIVITY_TIMEOUT_SECONDS,
    );

    stt.updateOptions(getAssemblyAISttProfileOptions("insurance"));
    stt.updateOptions(getAssemblyAISttProfileOptions("memberId"));
    stt.updateOptions(getAssemblyAISttProfileOptions("intake"));
    stt.updateOptions(getAssemblyAISttProfileOptions("email"));
    stt.updateOptions(getAssemblyAISttProfileOptions("default"));
  });

  it("builds agent context from the latest assistant message", () => {
    expect(getAssemblyAIAgentContext("What insurance do you have?")).toBe(
      "What insurance do you have?",
    );
    expect(getAssemblyAIAgentContext("")).toBeUndefined();

    const longText = `start-${"x".repeat(ASSEMBLYAI_AGENT_CONTEXT_MAX_CHARS)}-end`;
    const agentContext = getAssemblyAIAgentContext(longText);

    expect(agentContext).toHaveLength(ASSEMBLYAI_AGENT_CONTEXT_MAX_CHARS);
    expect(agentContext).not.toContain("start-");
    expect(agentContext).toContain("-end");
  });

  it("keeps startup keyterms conservative and AssemblyAI-compatible", () => {
    expect(ASSEMBLYAI_DEFAULT_KEYTERMS).toContain("Abita Eye Group");
    expect(ASSEMBLYAI_DEFAULT_KEYTERMS).toContain("Spring Hill");
    expect(ASSEMBLYAI_DEFAULT_KEYTERMS).toContain("Dr. Licht");
    expect(ASSEMBLYAI_DEFAULT_KEYTERMS).toContain("iCare");
    expect(ASSEMBLYAI_DEFAULT_KEYTERMS).toContain("Ambetter");
    expect(ASSEMBLYAI_DEFAULT_KEYTERMS).not.toContain("Aetna Better Health");
    expect(ASSEMBLYAI_DEFAULT_KEYTERMS).not.toContain("Blue Cross Blue Shield");
    expect(ASSEMBLYAI_DEFAULT_KEYTERMS).not.toContain("Cigna");
    expect(ASSEMBLYAI_DEFAULT_KEYTERMS).not.toContain("Florida Blue");
    expect(ASSEMBLYAI_DEFAULT_KEYTERMS).not.toContain("Humana Medicaid");
    expect(ASSEMBLYAI_DEFAULT_KEYTERMS).not.toContain("Medicaid");
    expect(ASSEMBLYAI_DEFAULT_KEYTERMS).not.toContain("Medicare");
    expect(ASSEMBLYAI_DEFAULT_KEYTERMS).not.toContain("United Healthcare");
    expect(ASSEMBLYAI_DEFAULT_KEYTERMS).not.toContain("Wellcare");
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
    ).toContain("AvMed");
    expect(
      getAssemblyAISttProfileOptions("insurance").keytermsPrompt,
    ).toContain("Sunshine Health");
    expect(
      getAssemblyAISttProfileOptions("insurance").keytermsPrompt,
    ).toContain("Staywell Medicare");
    expect(
      getAssemblyAISttProfileOptions("insurance").keytermsPrompt,
    ).toContain("Miami Children's Health Plan");
    expect(
      getAssemblyAISttProfileOptions("insurance").keytermsPrompt,
    ).toContain("Florida BlueSelect");
    expect(
      getAssemblyAISttProfileOptions("insurance").keytermsPrompt,
    ).toContain("Cigna Local Plus");
    expect(
      getAssemblyAISttProfileOptions("insurance").keytermsPrompt,
    ).toContain("iCare");
    expect(
      getAssemblyAISttProfileOptions("insurance").keytermsPrompt,
    ).not.toContain("Aetna");
    expect(
      getAssemblyAISttProfileOptions("insurance").keytermsPrompt,
    ).not.toContain("Cigna");
    expect(
      getAssemblyAISttProfileOptions("insurance").keytermsPrompt,
    ).not.toContain("Florida Blue");
    expect(
      getAssemblyAISttProfileOptions("insurance").keytermsPrompt,
    ).not.toContain("Humana");
    expect(
      getAssemblyAISttProfileOptions("insurance").keytermsPrompt,
    ).not.toContain("Medicaid");
    expect(
      getAssemblyAISttProfileOptions("insurance").keytermsPrompt,
    ).not.toContain("Medicare");
    expect(
      getAssemblyAISttProfileOptions("insurance").keytermsPrompt,
    ).not.toContain("United Healthcare");
    expect(
      getAssemblyAISttProfileOptions("insurance").keytermsPrompt,
    ).not.toContain("Wellcare");
    expect(
      getAssemblyAISttProfileOptions("insurance").keytermsPrompt,
    ).not.toContain("CHAMPVA");
    expect(
      getAssemblyAISttProfileOptions("insurance").keytermsPrompt,
    ).not.toContain("Children's Medical Services");
    expect(getAssemblyAISttProfileOptions("memberId").keytermsPrompt).toEqual(
      [],
    );
    expect(getAssemblyAISttProfileOptions("memberId").maxTurnSilence).toBe(
      3000,
    );
    expect(getAssemblyAISttProfileOptions("intake").keytermsPrompt).toEqual([]);
    expect(
      getAssemblyAISttProfileOptions("intake").maxTurnSilence,
    ).toBeGreaterThan(
      getAssemblyAISttProfileOptions("default").maxTurnSilence ?? 0,
    );
    expect(getAssemblyAISttProfileOptions("email").keytermsPrompt).toEqual([]);
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
