export const ASSEMBLYAI_BASE_TIMING = {
  minTurnSilence: 100,
  maxTurnSilence: 100,
  vadThreshold: 0.3,
} as const;

export const ASSEMBLYAI_INACTIVITY_TIMEOUT_SECONDS = 30;
export const ASSEMBLYAI_AGENT_CONTEXT_MAX_CHARS = 1500;
export const ASSEMBLYAI_INFERENCE_MODEL =
  "assemblyai/universal-3-5-pro" as const;

export const ASSEMBLYAI_DEFAULT_KEYTERMS = [
  "Abita Eye Group",
  "Eye Radiance",
  "Spring Hill",
  "Crystal River",
  "Dr. Bach",
  "Dr. Noel",
  "Dr. Licht",
  "Austin Bach",
  "iCare",
  "Ambetter",
] as const;

type AssemblyAISttProfileDefinition = {
  keytermsPrompt: string[];
  maxTurnSilence: number;
  minTurnSilence: number;
  vadThreshold: number;
};

export const ASSEMBLYAI_STT_PROFILES = {
  default: {
    keytermsPrompt: [...ASSEMBLYAI_DEFAULT_KEYTERMS],
    ...ASSEMBLYAI_BASE_TIMING,
  },
  insurance: {
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
    minTurnSilence: 1500,
    maxTurnSilence: 1500,
    vadThreshold: 0.3,
  },
  memberId: {
    keytermsPrompt: [],
    minTurnSilence: 1500,
    maxTurnSilence: 1500,
    vadThreshold: 0.3,
  },
  intake: {
    keytermsPrompt: [],
    minTurnSilence: 1500,
    maxTurnSilence: 1500,
    vadThreshold: 0.3,
  },
  email: {
    keytermsPrompt: [],
    minTurnSilence: 1500,
    maxTurnSilence: 1500,
    vadThreshold: 0.3,
  },
} satisfies Record<string, AssemblyAISttProfileDefinition>;

export type AssemblyAISttProfile = keyof typeof ASSEMBLYAI_STT_PROFILES;
export type SttProfile = AssemblyAISttProfile;

export type AssemblyAIInferenceModelOptions = {
  agent_context?: string;
  inactivity_timeout?: number;
  keyterms_prompt?: string[];
  language_detection?: boolean;
  max_turn_silence?: number;
  min_end_of_turn_silence_when_confident?: number;
  vad_threshold?: number;
};

export function getAssemblyAIInferenceSttOptions() {
  return {
    model: ASSEMBLYAI_INFERENCE_MODEL,
    modelOptions: {
      inactivity_timeout: ASSEMBLYAI_INACTIVITY_TIMEOUT_SECONDS,
      keyterms_prompt: [...ASSEMBLYAI_DEFAULT_KEYTERMS],
      language_detection: true,
      max_turn_silence: ASSEMBLYAI_BASE_TIMING.maxTurnSilence,
      min_end_of_turn_silence_when_confident:
        ASSEMBLYAI_BASE_TIMING.minTurnSilence,
      vad_threshold: ASSEMBLYAI_BASE_TIMING.vadThreshold,
    } satisfies AssemblyAIInferenceModelOptions,
  };
}

export function getAssemblyAIInferenceSttProfileOptions(
  profile: AssemblyAISttProfile,
): AssemblyAIInferenceModelOptions {
  const options = ASSEMBLYAI_STT_PROFILES[profile];
  return {
    keyterms_prompt: [...options.keytermsPrompt],
    max_turn_silence: options.maxTurnSilence,
    // The currently observed inference gateway enforces this SDK field; the newer direct-API
    // min_turn_silence field finalized paused names early in controlled replays.
    min_end_of_turn_silence_when_confident: options.minTurnSilence,
    vad_threshold: options.vadThreshold,
  };
}

export function getAssemblyAIAgentContext(text: string): string | undefined {
  if (!text) return undefined;
  return text.slice(-ASSEMBLYAI_AGENT_CONTEXT_MAX_CHARS);
}

const READBACK_CUES = [
  "let me confirm",
  "let me read",
  "read that back",
  "read back",
  "that all right",
  "is that right",
  "is that correct",
] as const;

const QUESTION_CUES = [
  "?",
  "can i get",
  "could i get",
  "what is",
  "what's",
  "what ",
  "which ",
  "who ",
  "spell",
  "read",
  "say",
  "tell me",
  "give me",
  "provide",
  "please",
] as const;

const EMAIL_CUES = ["email", "e-mail"] as const;

const FOLLOWUP_CUES = [
  "what is it",
  "what's that",
  "what is that",
  "go ahead",
  "can you spell",
  "could you spell",
  "spell that",
  "say that again",
  "repeat that",
  "one more time",
] as const;

const MEMBER_ID_CUES = [
  "member id",
  "member i d",
  "member number",
  "subscriber id",
  "subscriber i d",
  "subscriber number",
  "policy number",
  "group number",
  "id number",
  "i d number",
  "insurance card number",
] as const;

const INTAKE_CUES = [
  "date of birth",
  "dob",
  "d o b",
  "birthday",
  "birth date",
  "your name",
  "son's name",
  "child's name",
  "patient's name",
  "first name",
  "last name",
  "phone number",
  "best number",
  "address",
  "street",
  "apartment",
  "suite",
  "zip code",
  "subscriber name",
  "name on the card",
] as const;

const INSURANCE_CUES = [
  "what insurance",
  "which insurance",
  "insurance do you have",
  "insurance plan",
  "insurance carrier",
  "name of your insurance",
  "plan name",
] as const;

function includesAny(text: string, needles: readonly string[]): boolean {
  return needles.some((needle) => text.includes(needle));
}

export function selectSttProfileForAssistantText(
  text: string,
  options: {
    fallbackProfile?: AssemblyAISttProfile | null;
  } = {},
): AssemblyAISttProfile {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  if (!normalized || !includesAny(normalized, QUESTION_CUES)) {
    return "default";
  }

  if (includesAny(normalized, READBACK_CUES)) {
    return "default";
  }

  if (includesAny(normalized, EMAIL_CUES)) {
    return "email";
  }

  if (includesAny(normalized, MEMBER_ID_CUES)) {
    return "memberId";
  }

  if (includesAny(normalized, INTAKE_CUES)) {
    return "intake";
  }

  if (includesAny(normalized, INSURANCE_CUES)) {
    return "insurance";
  }

  const fallbackProfile = options.fallbackProfile ?? null;
  if (
    fallbackProfile &&
    fallbackProfile !== "default" &&
    includesAny(normalized, FOLLOWUP_CUES)
  ) {
    return fallbackProfile;
  }

  return "default";
}
