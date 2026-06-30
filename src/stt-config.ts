import type { STTOptions as AssemblyAIPluginSttOptions } from "@livekit/agents-plugin-assemblyai";

export const ASSEMBLYAI_BASE_TIMING = {
  minTurnSilence: 275,
  maxTurnSilence: 2000,
  vadThreshold: 0.3,
} as const;

export const ASSEMBLYAI_INACTIVITY_TIMEOUT_SECONDS = 30;
export const ASSEMBLYAI_AGENT_CONTEXT_MAX_CHARS = 1500;

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
    minTurnSilence: 400,
    maxTurnSilence: 3000,
    vadThreshold: 0.3,
  },
  memberId: {
    keytermsPrompt: [],
    minTurnSilence: 450,
    maxTurnSilence: 3000,
    vadThreshold: 0.3,
  },
  intake: {
    keytermsPrompt: [],
    minTurnSilence: 450,
    maxTurnSilence: 3500,
    vadThreshold: 0.3,
  },
  email: {
    keytermsPrompt: [],
    minTurnSilence: 500,
    maxTurnSilence: 4000,
    vadThreshold: 0.3,
  },
} satisfies Record<string, Partial<AssemblyAIPluginSttOptions>>;

export type AssemblyAISttProfile = keyof typeof ASSEMBLYAI_STT_PROFILES;
export type SttProfile = AssemblyAISttProfile;

export function getAssemblyAISttOptions(): Partial<AssemblyAIPluginSttOptions> {
  return {
    speechModel: "universal-3-5-pro",
    languageDetection: true,
    voiceFocus: "near-field",
    inactivityTimeout: ASSEMBLYAI_INACTIVITY_TIMEOUT_SECONDS,
    ...ASSEMBLYAI_STT_PROFILES.default,
  };
}

export function getAssemblyAISttProfileOptions(
  profile: AssemblyAISttProfile,
): Partial<AssemblyAIPluginSttOptions> {
  const options = ASSEMBLYAI_STT_PROFILES[profile];
  return {
    ...options,
    keytermsPrompt: options.keytermsPrompt
      ? [...options.keytermsPrompt]
      : undefined,
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

function isQuestionLike(text: string): boolean {
  return includesAny(text, QUESTION_CUES);
}

export function selectAssemblyAISttProfileForAssistantText(
  text: string,
  options: {
    fallbackProfile?: AssemblyAISttProfile | null;
  } = {},
): AssemblyAISttProfile {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  if (!normalized || !isQuestionLike(normalized)) {
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

export function selectSttProfileForAssistantText(
  text: string,
  options: {
    fallbackProfile?: SttProfile | null;
  } = {},
): SttProfile {
  return selectAssemblyAISttProfileForAssistantText(text, options);
}
