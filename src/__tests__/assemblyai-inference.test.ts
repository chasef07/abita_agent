import { beforeAll, describe, expect, it } from "vitest";
import { inference, initializeLogger } from "@livekit/agents";
import type {
  AssemblyAIInferenceModelOptions,
  AssemblyAISttOptions,
} from "../stt-config.js";
import {
  ASSEMBLYAI_INFERENCE_MODEL,
  ASSEMBLYAI_DEFAULT_KEYTERMS,
  ASSEMBLYAI_STT_PROFILES,
  getAssemblyAIInferenceSttOptions,
  getAssemblyAIInferenceSttProfileOptions,
  getAssemblyAISttOptions,
  getAssemblyAISttProfileOptions,
  selectAssemblyAISttProfileForAssistantText,
} from "../stt-config.js";

beforeAll(() => {
  initializeLogger({ pretty: false, level: "silent" });
});

function expectedInferenceModelOptions(
  options: Partial<AssemblyAISttOptions>,
): AssemblyAIInferenceModelOptions {
  const expected: AssemblyAIInferenceModelOptions = {};

  if (options.languageDetection !== undefined) {
    expected.language_detection = options.languageDetection;
  }
  if (options.endOfTurnConfidenceThreshold !== undefined) {
    expected.end_of_turn_confidence_threshold =
      options.endOfTurnConfidenceThreshold;
  }
  if (options.minTurnSilence !== undefined) {
    expected.min_turn_silence = options.minTurnSilence;
  }
  if (options.maxTurnSilence !== undefined) {
    expected.max_turn_silence = options.maxTurnSilence;
  }
  if (options.formatTurns !== undefined) {
    expected.format_turns = options.formatTurns;
  }
  if (options.keytermsPrompt !== undefined) {
    expected.keyterms_prompt = options.keytermsPrompt;
  }
  if (options.prompt !== undefined) {
    expected.prompt = options.prompt;
  }
  if (options.vadThreshold !== undefined) {
    expected.vad_threshold = options.vadThreshold;
  }
  if (options.speakerLabels !== undefined) {
    expected.speaker_labels = options.speakerLabels;
  }
  if (options.maxSpeakers !== undefined) {
    expected.max_speakers = options.maxSpeakers;
  }
  if (options.domain !== undefined) {
    expected.domain = options.domain;
  }

  return expected;
}

describe("AssemblyAI LiveKit Inference STT", () => {
  it("maps the current U3 Pro inputs to LiveKit Inference", () => {
    const sourceOptions = getAssemblyAISttOptions();
    const inferenceOptions = getAssemblyAIInferenceSttOptions();

    expect(inferenceOptions).not.toHaveProperty("language");
    expect(inferenceOptions.model).toBe(
      `assemblyai/${sourceOptions.speechModel}`,
    );
    expect(inferenceOptions.model).toBe(ASSEMBLYAI_INFERENCE_MODEL);
    expect(inferenceOptions.modelOptions).toEqual(
      expectedInferenceModelOptions(sourceOptions),
    );
    expect(inferenceOptions.modelOptions.keyterms_prompt).toContain(
      "Abita Eye Group",
    );
    expect(inferenceOptions.modelOptions.keyterms_prompt).toContain("iCare");

    const stt = new inference.STT({
      apiKey: "test-livekit-key",
      apiSecret: "test-livekit-secret",
      ...inferenceOptions,
    });

    expect(stt.provider).toBe("livekit");
    expect(stt.model).toBe(ASSEMBLYAI_INFERENCE_MODEL);

    stt.updateOptions(getAssemblyAIInferenceSttProfileOptions("insurance"));
    stt.updateOptions(getAssemblyAIInferenceSttProfileOptions("memberId"));
    stt.updateOptions(getAssemblyAIInferenceSttProfileOptions("intake"));
    stt.updateOptions(getAssemblyAIInferenceSttProfileOptions("email"));
    stt.updateOptions(getAssemblyAIInferenceSttProfileOptions("default"));
  });

  it("maps dynamic STT profile updates into inference modelOptions", () => {
    const profiles = Object.keys(
      ASSEMBLYAI_STT_PROFILES,
    ) as (keyof typeof ASSEMBLYAI_STT_PROFILES)[];

    for (const profile of profiles) {
      const sourceOptions = getAssemblyAISttProfileOptions(profile);
      const inferenceOptions =
        getAssemblyAIInferenceSttProfileOptions(profile);

      expect(inferenceOptions.modelOptions).toEqual(
        expectedInferenceModelOptions(sourceOptions),
      );
    }
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
