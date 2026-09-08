import { inference, initializeLogger } from "@livekit/agents";
import { beforeAll, describe, expect, it } from "vitest";
import {
  ASSEMBLYAI_DEFAULT_KEYTERMS,
  getAssemblyAIInferenceSttOptions,
  getAssemblyAIInferenceSttProfileOptions,
  selectSttProfileForAssistantText,
} from "../stt-config.js";

beforeAll(() => {
  initializeLogger({ pretty: false, level: "silent" });
});

describe("AssemblyAI through LiveKit Inference", () => {
  it("preserves the complete startup transcription configuration", () => {
    const options = getAssemblyAIInferenceSttOptions();
    const stt = new inference.STT({
      ...options,
      apiKey: "test-api-key",
      apiSecret: "test-api-secret",
      baseURL: "https://example.livekit.cloud",
    });

    expect(options).toEqual({
      model: "assemblyai/universal-3-5-pro",
      modelOptions: {
        inactivity_timeout: 30,
        keyterms_prompt: [...ASSEMBLYAI_DEFAULT_KEYTERMS],
        language_detection: true,
        max_turn_silence: 100,
        min_end_of_turn_silence_when_confident: 100,
        vad_threshold: 0.3,
      },
    });
    expect(options).not.toHaveProperty("language");
    expect(options.modelOptions).not.toHaveProperty("min_turn_silence");
    expect(stt.label).toBe("inference.STT");
    expect(stt.provider).toBe("livekit");
    expect(stt.model).toBe("assemblyai/universal-3-5-pro");
  });

  it("maps every recognition profile to exact AssemblyAI model options", () => {
    expect(getAssemblyAIInferenceSttProfileOptions("default")).toEqual({
      keyterms_prompt: [...ASSEMBLYAI_DEFAULT_KEYTERMS],
      max_turn_silence: 100,
      min_end_of_turn_silence_when_confident: 100,
      vad_threshold: 0.3,
    });
    expect(getAssemblyAIInferenceSttProfileOptions("insurance")).toEqual({
      keyterms_prompt: [
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
      max_turn_silence: 1500,
      min_end_of_turn_silence_when_confident: 1500,
      vad_threshold: 0.3,
    });
    expect(getAssemblyAIInferenceSttProfileOptions("memberId")).toEqual({
      keyterms_prompt: [],
      max_turn_silence: 1500,
      min_end_of_turn_silence_when_confident: 1500,
      vad_threshold: 0.3,
    });
    expect(getAssemblyAIInferenceSttProfileOptions("intake")).toEqual({
      keyterms_prompt: [],
      max_turn_silence: 1500,
      min_end_of_turn_silence_when_confident: 1500,
      vad_threshold: 0.3,
    });
    expect(getAssemblyAIInferenceSttProfileOptions("email")).toEqual({
      keyterms_prompt: [],
      max_turn_silence: 1500,
      min_end_of_turn_silence_when_confident: 1500,
      vad_threshold: 0.3,
    });

    const options = getAssemblyAIInferenceSttProfileOptions("insurance");
    options.keyterms_prompt?.push("mutated term");
    expect(
      getAssemblyAIInferenceSttProfileOptions("insurance").keyterms_prompt,
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
    expect(getAssemblyAIInferenceSttOptions().modelOptions).not.toHaveProperty(
      "prompt",
    );
    for (const profile of [
      "default",
      "insurance",
      "memberId",
      "intake",
      "email",
    ] as const) {
      expect(
        getAssemblyAIInferenceSttProfileOptions(profile),
      ).not.toHaveProperty("prompt");
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
