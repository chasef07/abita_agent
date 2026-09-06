// Abita customer profile: office registry for trunk routing, prompts, and tool behavior.

export type OfficeKey =
  | "spring-hill"
  | "crystal-river"
  | "hollywood"
  | "sweetwater"
  | "north-miami-beach-optical"
  | "ophthalmology-demo"
  | "new-tampa-demo"
  | "rheumatology-demo";
export type HandoffOfficeKey = OfficeKey | "sweetwater-optical";
export type OfficeCare = "medical" | "routine_vision";
export type OfficeSpeechLanguage = "en" | "es";
export const AVAILABILITY_OFFICE_KEYS = ["hollywood", "sweetwater"] as const;
export type AvailabilityOfficeKey = (typeof AVAILABILITY_OFFICE_KEYS)[number];
const AVAILABILITY_OFFICE_NAMES = "Hollywood or Sweetwater";
export type AvailabilityOfficeSelection =
  | { status: "current" }
  | { status: "blocked"; message: string }
  | { status: "selected"; office: OfficeProfile };
export type OfficeSchedulingPolicy =
  { supported: true } | { supported: false; message: string };
export type OfficeInsurancePolicy =
  { supported: true; source: string } | { supported: false };
export type OfficeHandoffPolicy =
  | { mode: "call-center" }
  | { mode: "phone"; target: string }
  | { mode: "product-with-phone-fallback"; target: string };
export type OfficePromptSource = {
  file: string;
  tag: "role" | "voice";
};
export const SPRING_HILL_OFFICE_PHONE = "+17275919997";
export const SPRING_HILL_813_TRUNK_PHONE = "+18135484830";
export const CRYSTAL_RIVER_OFFICE_PHONE = "+13523202007";
export const HOLLYWOOD_OFFICE_PHONE = "+19542872010";
export const SWEETWATER_OFFICE_PHONE = "+17864657475";
export const NORTH_MIAMI_BEACH_OPTICAL_OFFICE_PHONE = "+13055095333";
export const SWEETWATER_OPTICAL_TRUNK_PHONE = "+17864657479";
export const SWEETWATER_TRUNK_PHONES = [
  SWEETWATER_OFFICE_PHONE,
  "+17864654845",
  "+17866134310",
  SWEETWATER_OPTICAL_TRUNK_PHONE,
  "+17864654836",
  "+17864654882",
] as const;
export const RHEUMATOLOGY_DEMO_TRUNK_PHONE = "+14843989071";
export const DEMO_BOOKING_OFFICE_PHONE = RHEUMATOLOGY_DEMO_TRUNK_PHONE;
export const OPHTHALMOLOGY_DEMO_TRUNK_PHONE = "+18027878312";
// The 320 demo uses the same canonical office key as Acuity Product.
export const NEW_TAMPA_DEMO_TRUNK_PHONE = "+13207388132";
export const DEMO_TRANSFER_NUMBER = "+17277092035";
export const DEMO_OFFICE_KEYS = [
  "rheumatology-demo",
  "ophthalmology-demo",
  "new-tampa-demo",
] as const satisfies readonly OfficeKey[];

export interface OfficeProfile {
  key: OfficeKey;
  displayName: string;
  trunkPhones: string[];
  greeting: string;
  amdOfficePhone: string;
  knowledgeSource: string;
  staffTaskEnabled: boolean;
  availabilityOfficeFor(
    requestedOffice?: AvailabilityOfficeKey,
  ): AvailabilityOfficeSelection;
  handoff(): OfficeHandoffPolicy;
  insuranceFor(coverageType: OfficeCare): OfficeInsurancePolicy;
  promptSources(): OfficePromptSource[];
  schedulingFor(care: OfficeCare): OfficeSchedulingPolicy;
  humanTransferAnnouncement(language: OfficeSpeechLanguage): string;
  speechFor(language: OfficeSpeechLanguage): {
    lang: "eng" | "spa";
    speaker: string;
  };
}
const CRYSTAL_RIVER_TRANSFER_NUMBER = "+13527941244";
type OfficeCareInput =
  | { supported: true; insuranceSource: string }
  | { supported: false; message?: string };
type OfficeProfileInput = {
  amdOfficePhone: string;
  care: Record<OfficeCare, OfficeCareInput>;
  displayName: string;
  englishSpeaker?: string;
  greeting: string;
  handoff?: () => OfficeHandoffPolicy;
  key: OfficeKey;
  knowledgeSource: string;
  roleFile?: string;
  staffTaskEnabled: boolean;
  trunkPhones: string[];
};

function defineOffice(input: OfficeProfileInput): OfficeProfile {
  const {
    amdOfficePhone,
    care,
    displayName,
    englishSpeaker = "wawona",
    greeting,
    handoff = () => ({ mode: "call-center" }),
    key,
    knowledgeSource,
    roleFile,
    staffTaskEnabled,
    trunkPhones,
  } = input;

  function schedulingFor(careType: OfficeCare): OfficeSchedulingPolicy {
    if (care[careType].supported) return { supported: true };

    return {
      supported: false,
      message:
        care[careType].message ??
        (careType === "medical"
          ? `${displayName} supports routine vision and optical scheduling. Route medical eye care through a medical office or live staff.`
          : `${displayName} handles medical eye care, including cataract evaluations. Route routine eye exams, glasses prescriptions, and contact lens prescriptions through a routine-vision office.`),
    };
  }

  return {
    amdOfficePhone,
    displayName,
    greeting,
    key,
    knowledgeSource,
    staffTaskEnabled,
    trunkPhones,
    availabilityOfficeFor(requestedOffice) {
      if (!AVAILABILITY_OFFICE_KEYS.some((officeKey) => officeKey === key)) {
        return requestedOffice
          ? {
              status: "blocked",
              message: `${displayName} calls use their current office. Check availability again with office omitted.`,
            }
          : { status: "current" };
      }
      if (!requestedOffice) {
        return {
          status: "blocked",
          message: `Ask whether the caller wants the ${AVAILABILITY_OFFICE_NAMES} office, then check availability again with that office.`,
        };
      }
      return { status: "selected", office: getOfficeProfile(requestedOffice) };
    },
    handoff,
    insuranceFor(coverageType) {
      const policy = care[coverageType];
      if (!policy.supported) return { supported: false };

      return {
        supported: true,
        source: policy.insuranceSource,
      };
    },
    promptSources() {
      return [
        { file: roleFile ?? "SOUL.md", tag: "role" },
        { file: "VOICE.md", tag: "voice" },
      ];
    },
    schedulingFor,
    humanTransferAnnouncement(language) {
      return language === "es"
        ? "Un momento mientras le transfiero a la oficina."
        : "One moment while I transfer you to the office.";
    },
    speechFor(language) {
      return language === "es"
        ? { lang: "spa", speaker: "luz" }
        : { lang: "eng", speaker: englishSpeaker };
    },
  };
}

function demoHandoff(): OfficeHandoffPolicy {
  const override = process.env.DEV_HANDOFF_TARGET?.trim();
  return {
    mode: "product-with-phone-fallback",
    target: override
      ? normalizeHandoffTarget(override)
      : `tel:${DEMO_TRANSFER_NUMBER}`,
  };
}

const OFFICE_PROFILES: Record<OfficeKey, OfficeProfile> = {
  "spring-hill": defineOffice({
    key: "spring-hill",
    displayName: "Abita Eye Group",
    trunkPhones: [SPRING_HILL_OFFICE_PHONE, SPRING_HILL_813_TRUNK_PHONE],
    greeting: "Hi, this is Maya at Abeeta Eye Group. How can I help?",
    knowledgeSource: "KNOWLEDGE_SPRINGHILL.md",
    care: {
      medical: {
        supported: true,
        insuranceSource: "INSURANCE_SPRING_HILL_MEDICAL.json",
      },
      routine_vision: {
        supported: true,
        insuranceSource: "INSURANCE_SPRING_HILL_ROUTINE_VISION.json",
      },
    },
    amdOfficePhone: SPRING_HILL_OFFICE_PHONE,
    staffTaskEnabled: true,
  }),
  "crystal-river": defineOffice({
    key: "crystal-river",
    displayName: "Eye Radiance",
    trunkPhones: [CRYSTAL_RIVER_OFFICE_PHONE],
    greeting:
      "Hi, this is Maya at Eye Radiance, powered by Abeeta Eye Group. How can I help?",
    knowledgeSource: "KNOWLEDGE_EYERADIANCE.md",
    care: {
      medical: {
        supported: true,
        insuranceSource: "INSURANCE_CRYSTAL_RIVER.json",
      },
      routine_vision: { supported: false },
    },
    amdOfficePhone: CRYSTAL_RIVER_OFFICE_PHONE,
    staffTaskEnabled: false,
    handoff: () => ({
      mode: "phone",
      target: `tel:${CRYSTAL_RIVER_TRANSFER_NUMBER}`,
    }),
  }),
  hollywood: defineOffice({
    key: "hollywood",
    displayName: "Abita Eye Group Hollywood",
    trunkPhones: [HOLLYWOOD_OFFICE_PHONE],
    greeting: "Hi, this is Maya at Abeeta Eye Group. How can I help?",
    knowledgeSource: "KNOWLEDGE_HOLLYWOOD.md",
    care: {
      medical: {
        supported: true,
        insuranceSource: "INSURANCE_HOLLYWOOD_SWEETWATER.json",
      },
      routine_vision: {
        supported: true,
        insuranceSource: "INSURANCE_SPRING_HILL_ROUTINE_VISION.json",
      },
    },
    amdOfficePhone: HOLLYWOOD_OFFICE_PHONE,
    englishSpeaker: "luz",
    staffTaskEnabled: true,
  }),
  sweetwater: defineOffice({
    key: "sweetwater",
    displayName: "Abita Eye Group Sweetwater",
    trunkPhones: [...SWEETWATER_TRUNK_PHONES],
    greeting: "Hi, this is Maya at Abeeta Eye Group. How can I help?",
    knowledgeSource: "KNOWLEDGE_SWEETWATER.md",
    care: {
      medical: {
        supported: true,
        insuranceSource: "INSURANCE_HOLLYWOOD_SWEETWATER.json",
      },
      routine_vision: {
        supported: true,
        insuranceSource: "INSURANCE_SPRING_HILL_ROUTINE_VISION.json",
      },
    },
    amdOfficePhone: SWEETWATER_OFFICE_PHONE,
    englishSpeaker: "luz",
    staffTaskEnabled: true,
  }),
  "north-miami-beach-optical": defineOffice({
    key: "north-miami-beach-optical",
    displayName: "North Miami Beach Optical",
    trunkPhones: [NORTH_MIAMI_BEACH_OPTICAL_OFFICE_PHONE],
    greeting: "Hi, this is Maya at Abeeta Eye Group. How can I help?",
    knowledgeSource: "KNOWLEDGE_NORTH_MIAMI_BEACH_OPTICAL.md",
    care: {
      medical: { supported: false },
      routine_vision: {
        supported: true,
        insuranceSource: "INSURANCE_SPRING_HILL_ROUTINE_VISION.json",
      },
    },
    amdOfficePhone: NORTH_MIAMI_BEACH_OPTICAL_OFFICE_PHONE,
    englishSpeaker: "luz",
    staffTaskEnabled: true,
  }),
  "ophthalmology-demo": defineOffice({
    key: "ophthalmology-demo",
    displayName: "Clearbrook Eye Center",
    trunkPhones: [OPHTHALMOLOGY_DEMO_TRUNK_PHONE],
    greeting: "Hi, this is Maya at Clearbrook Eye Center. How can I help?",
    roleFile: "SOUL_OPHTHALMOLOGY_DEMO.md",
    knowledgeSource: "KNOWLEDGE_OPHTHALMOLOGY_DEMO.md",
    care: {
      medical: {
        supported: true,
        insuranceSource: "INSURANCE_DEMO_MEDICAL.json",
      },
      routine_vision: {
        supported: true,
        insuranceSource: "INSURANCE_OPHTHALMOLOGY_DEMO_ROUTINE_VISION.json",
      },
    },
    amdOfficePhone: DEMO_BOOKING_OFFICE_PHONE,
    staffTaskEnabled: true,
    handoff: demoHandoff,
  }),
  "new-tampa-demo": defineOffice({
    key: "new-tampa-demo",
    displayName: "New Tampa Eye Institute",
    trunkPhones: [NEW_TAMPA_DEMO_TRUNK_PHONE],
    greeting:
      "Hi, this is Maya at New Tampa Eye Institute. How can I help you today?",
    roleFile: "SOUL_NEW_TAMPA_DEMO.md",
    knowledgeSource: "KNOWLEDGE_NEW_TAMPA_DEMO.md",
    care: {
      medical: {
        supported: true,
        insuranceSource: "INSURANCE_NEW_TAMPA_DEMO_MEDICAL.json",
      },
      routine_vision: {
        supported: true,
        insuranceSource: "INSURANCE_NEW_TAMPA_DEMO_ROUTINE_VISION.json",
      },
    },
    amdOfficePhone: DEMO_BOOKING_OFFICE_PHONE,
    staffTaskEnabled: true,
    handoff: demoHandoff,
  }),
  "rheumatology-demo": defineOffice({
    key: "rheumatology-demo",
    displayName: "Juniper Ridge Rheumatology & Arthritis Care",
    trunkPhones: [RHEUMATOLOGY_DEMO_TRUNK_PHONE],
    greeting:
      "Hi, this is Julia, the virtual assistant at Juniper Ridge Rheumatology and Arthritis Care. How can I help you today?",
    roleFile: "SOUL_RHEUM_DEMO.md",
    knowledgeSource: "KNOWLEDGE_RHEUM_DEMO.md",
    care: {
      medical: {
        supported: true,
        insuranceSource: "INSURANCE_DEMO_MEDICAL.json",
      },
      routine_vision: {
        supported: false,
        message:
          "Juniper Ridge Rheumatology & Arthritis Care schedules rheumatology care. Route routine eye exams, glasses prescriptions, and contact lens prescriptions through an eye-care practice.",
      },
    },
    amdOfficePhone: DEMO_BOOKING_OFFICE_PHONE,
    staffTaskEnabled: true,
    handoff: demoHandoff,
  }),
};

const OFFICE_BY_PHONE: Record<string, OfficeKey> = Object.fromEntries(
  Object.values(OFFICE_PROFILES).flatMap((office) =>
    office.trunkPhones.map(
      (phone) => [normalizePhoneNumber(phone), office.key] as const,
    ),
  ),
);

export function normalizePhoneNumber(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length > 0) return `+${digits}`;
  return phone.trim();
}

export function getOfficeKeyByPhone(phone: string): OfficeKey {
  const officeKey = OFFICE_BY_PHONE[normalizePhoneNumber(phone)];
  if (!officeKey) {
    throw new Error(`Unsupported trunk phone number: ${phone || "(empty)"}`);
  }
  return officeKey;
}

export function getProductOfficeKeyByPhone(phone: string): HandoffOfficeKey {
  if (normalizePhoneNumber(phone) === SWEETWATER_OPTICAL_TRUNK_PHONE) {
    return "sweetwater-optical";
  }
  return getOfficeKeyByPhone(phone);
}

export function isDemoOfficeKey(officeKey: OfficeKey): boolean {
  return DEMO_OFFICE_KEYS.some((demoOfficeKey) => demoOfficeKey === officeKey);
}

export function getOfficeProfile(key: OfficeKey): OfficeProfile {
  return OFFICE_PROFILES[key];
}

export function getOfficeProfiles(): OfficeProfile[] {
  return Object.values(OFFICE_PROFILES);
}

export function getOfficeProfileByPhone(phone: string): OfficeProfile {
  return getOfficeProfile(getOfficeKeyByPhone(phone));
}

export function getOfficeProfileByFacility(
  facility: string | undefined,
): OfficeProfile | null {
  const normalized = normalizeFacilityName(facility);
  if (!normalized) return null;

  const explicitMatch: Array<[string[], OfficeKey]> = [
    [["crystal river", "eye radiance"], "crystal-river"],
    [["spring hill"], "spring-hill"],
    [["hollywood"], "hollywood"],
    [["sweetwater"], "sweetwater"],
  ];
  for (const [aliases, key] of explicitMatch) {
    if (aliases.some((alias) => normalized.includes(alias))) {
      return getOfficeProfile(key);
    }
  }

  for (const key of [
    "spring-hill",
    "crystal-river",
    "hollywood",
    "sweetwater",
    "ophthalmology-demo",
    "new-tampa-demo",
    "rheumatology-demo",
  ] satisfies OfficeKey[]) {
    const displayName = normalizeFacilityName(
      getOfficeProfile(key).displayName,
    );
    if (displayName && normalized.includes(displayName)) {
      return getOfficeProfile(key);
    }
  }

  return null;
}

export function normalizeHandoffTarget(target: string): string {
  const trimmed = target.trim();
  if (/^(tel|sip):/i.test(trimmed)) return trimmed;
  return `tel:${normalizePhoneNumber(trimmed)}`;
}

function normalizeFacilityName(value: string | undefined): string {
  return (
    value
      ?.trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim() ?? ""
  );
}
