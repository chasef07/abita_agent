import { STT } from "@livekit/agents-plugin-assemblyai";
import { initializeLogger } from "@livekit/agents";
import { beforeAll, describe, expect, it } from "vitest";
import {
  ASSEMBLYAI_DEFAULT_KEYTERMS,
  getAssemblyAISttOptions,
  getAssemblyAISttProfileOptions,
  selectSttProfileForAssistantText,
} from "../stt-config.js";

beforeAll(() => {
  initializeLogger({ pretty: false, level: "silent" });
});

describe("AssemblyAI direct plugin", () => {
  it("preserves the complete startup transcription configuration", () => {
    const options = getAssemblyAISttOptions();
    const stt = new STT({ ...options, apiKey: "test-api-key" });

    expect(options).toEqual({
      speechModel: "universal-3-5-pro",
      bufferSizeMs: 50,
      inactivityTimeout: 30,
      keytermsPrompt: [...ASSEMBLYAI_DEFAULT_KEYTERMS],
      languageDetection: true,
      maxTurnSilence: 100,
      minTurnSilence: 100,
      vadThreshold: 0.3,
    });
    expect(options).not.toHaveProperty("language");
    expect(stt.label).toBe("assemblyai.STT");
    expect(stt.provider).toBe("AssemblyAI");
    expect(stt.model).toBe("universal-3-5-pro");
  });

  it("maps every recognition profile to exact AssemblyAI model options", () => {
    expect(getAssemblyAISttProfileOptions("default")).toEqual({
      keytermsPrompt: [...ASSEMBLYAI_DEFAULT_KEYTERMS],
      maxTurnSilence: 100,
      minTurnSilence: 100,
      vadThreshold: 0.3,
    });
    expect(getAssemblyAISttProfileOptions("insurance")).toEqual({
      keytermsPrompt: [
        "Aetna Better Health",
        "Aetna Better Health of Florida",
        "Ambetter",
        "AvMed",
        "Sunshine Health",
        "Staywell Medicare",
        "Miami Children's Health Plan",
        "Florida BlueSelect",
        "Cigna Local Plus",
        "AvMed Medicare Advantage",
        "Aetna EPO",
        "Humana Healthy Horizons",
        "Humana Medicaid",
        "iCare",
        "Oscar Health",
        "Simply Medicaid",
      ],
      maxTurnSilence: 1500,
      minTurnSilence: 1500,
      vadThreshold: 0.3,
    });
    expect(getAssemblyAISttProfileOptions("memberId")).toEqual({
      keytermsPrompt: [],
      maxTurnSilence: 1500,
      minTurnSilence: 1500,
      vadThreshold: 0.3,
    });
    expect(getAssemblyAISttProfileOptions("intake")).toEqual({
      keytermsPrompt: [],
      maxTurnSilence: 1500,
      minTurnSilence: 1500,
      vadThreshold: 0.3,
    });
    expect(getAssemblyAISttProfileOptions("email")).toEqual({
      keytermsPrompt: [],
      maxTurnSilence: 1500,
      minTurnSilence: 1500,
      vadThreshold: 0.3,
    });

    const options = getAssemblyAISttProfileOptions("insurance");
    options.keytermsPrompt?.push("mutated term");
    expect(
      getAssemblyAISttProfileOptions("insurance").keytermsPrompt,
    ).not.toContain("mutated term");
  });

  it("keeps startup keyterms conservative and provider-compatible", () => {
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

  it("does not mix model prompt instructions into keyterm profiles", () => {
    expect(getAssemblyAISttOptions()).not.toHaveProperty("prompt");
    for (const profile of [
      "default",
      "insurance",
      "memberId",
      "intake",
      "email",
    ] as const) {
      expect(getAssemblyAISttProfileOptions(profile)).not.toHaveProperty(
        "prompt",
      );
    }
  });

  it("selects and reuses every next-turn transcription profile", () => {
    expect(
      selectSttProfileForAssistantText("What insurance do you have?"),
    ).toBe("insurance");
    expect(
      selectSttProfileForAssistantText(
        "Can I get the member ID from the insurance card?",
      ),
    ).toBe("memberId");
    expect(selectSttProfileForAssistantText("What's your date of birth?")).toBe(
      "intake",
    );
    expect(
      selectSttProfileForAssistantText(
        "I have your first name, what's your date of birth?",
      ),
    ).toBe("intake");
    expect(
      selectSttProfileForAssistantText("What's the best email address?"),
    ).toBe("email");
    expect(selectSttProfileForAssistantText("What's your son's name?")).toBe(
      "intake",
    );
    expect(
      selectSttProfileForAssistantText("Could you spell your last name?"),
    ).toBe("intake");
    expect(
      selectSttProfileForAssistantText("Can you spell that?", {
        fallbackProfile: "intake",
      }),
    ).toBe("intake");
    expect(
      selectSttProfileForAssistantText("What's your first and last name?"),
    ).toBe("intake");
    expect(
      selectSttProfileForAssistantText(
        "Let me confirm the details I have. Is that right?",
      ),
    ).toBe("default");
    expect(
      selectSttProfileForAssistantText("What is it?", {
        fallbackProfile: "email",
      }),
    ).toBe("email");
    expect(
      selectSttProfileForAssistantText("Go ahead, spell that.", {
        fallbackProfile: "memberId",
      }),
    ).toBe("memberId");
  });
});
