// offices.ts — Shared office registry for trunk routing, prompts, and tool behavior.

export type OfficeKey = "spring-hill" | "crystal-river" | "dev";
export const SPRING_HILL_OFFICE_PHONE = "+17275919997";
export const SPRING_HILL_813_TRUNK_PHONE = "+18135484830";
export const CRYSTAL_RIVER_OFFICE_PHONE = "+13523202007";
export const DEV_OFFICE_PHONE = "+14843989071";

export interface OfficeConfig {
  key: OfficeKey;
  displayName: string;
  trunkPhones: string[];
  greeting: string;
  knowledgeFile: string;
  insuranceFile: string;
  visionInsuranceFile?: string;
  amdOfficePhone: string;
  middlewareBaseUrl?: string;
  transferNumber: string;
  features: {
    routeToSpringHill: boolean;
  };
}
const SPRING_HILL_TRANSFER_NUMBER = "+16182265883";
const CRYSTAL_RIVER_TRANSFER_NUMBER = "+13527941244";
const DEFAULT_TRANSFER_NUMBER = "+18667968908";

export const OFFICE_CONFIGS: Record<OfficeKey, OfficeConfig> = {
  "spring-hill": {
    key: "spring-hill",
    displayName: "Abita Eye Group",
    trunkPhones: [SPRING_HILL_OFFICE_PHONE, SPRING_HILL_813_TRUNK_PHONE],
    greeting:
      "thank you for calling Abita Eye Group, this is Ava, how can I help you?",
    knowledgeFile: "KNOWLEDGE_SPRINGHILL.md",
    insuranceFile: "INSURANCE_SPRING_HILL_CRYSTAL_RIVER.json",
    visionInsuranceFile: "INSURANCE_SPRING_HILL_ROUTINE_VISION.json",
    amdOfficePhone: SPRING_HILL_OFFICE_PHONE,
    transferNumber: SPRING_HILL_TRANSFER_NUMBER,
    features: {
      routeToSpringHill: false,
    },
  },
  "crystal-river": {
    key: "crystal-river",
    displayName: "Eye Radiance",
    trunkPhones: [CRYSTAL_RIVER_OFFICE_PHONE],
    greeting:
      "Thank you for calling Eye Radiance powered by Abeeta Eye Group. How can I help you?",
    knowledgeFile: "KNOWLEDGE_EYERADIANCE.md",
    insuranceFile: "INSURANCE_CRYSTAL_RIVER.json",
    visionInsuranceFile: "INSURANCE_SPRING_HILL_ROUTINE_VISION.json",
    amdOfficePhone: CRYSTAL_RIVER_OFFICE_PHONE,
    transferNumber: CRYSTAL_RIVER_TRANSFER_NUMBER,
    features: {
      routeToSpringHill: true,
    },
  },
  dev: {
    key: "dev",
    displayName: "Abita Dev",
    trunkPhones: [DEV_OFFICE_PHONE],
    greeting:
      "thank you for calling Abita Eye Group, this is Ava, how can I help you?",
    knowledgeFile: "KNOWLEDGE_SPRINGHILL.md",
    insuranceFile: "INSURANCE_SPRING_HILL_CRYSTAL_RIVER.json",
    visionInsuranceFile: "INSURANCE_SPRING_HILL_ROUTINE_VISION.json",
    amdOfficePhone: DEV_OFFICE_PHONE,
    middlewareBaseUrl: "https://advancedmd-token-management-dev.up.railway.app",
    transferNumber: DEFAULT_TRANSFER_NUMBER,
    features: {
      routeToSpringHill: false,
    },
  },
};

export const OFFICE_BY_PHONE: Record<string, OfficeKey> = Object.fromEntries(
  Object.values(OFFICE_CONFIGS).flatMap((office) =>
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

export function getOfficeConfig(key: OfficeKey): OfficeConfig {
  return OFFICE_CONFIGS[key];
}

export function getOfficeConfigByPhone(phone: string): OfficeConfig {
  return getOfficeConfig(getOfficeKeyByPhone(phone));
}
