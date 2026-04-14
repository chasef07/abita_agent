// offices.ts — Shared office registry for trunk routing, prompts, and tool behavior.

export type OfficeKey = "spring-hill" | "crystal-river";
export const SPRING_HILL_OFFICE_PHONE = "+17275919997";
export const CRYSTAL_RIVER_OFFICE_PHONE = "+13523202007";

export interface OfficeConfig {
  key: OfficeKey;
  displayName: string;
  trunkPhones: string[];
  greeting: string;
  knowledgeFile: string;
  insuranceFile: string;
  amdOfficePhone: string;
  transferNumber: string;
  features: {
    routeToSpringHill: boolean;
  };
}
const DEFAULT_TRANSFER_NUMBER = "+18667968908";

export const OFFICE_CONFIGS: Record<OfficeKey, OfficeConfig> = {
  "spring-hill": {
    key: "spring-hill",
    displayName: "Abita Eye Group",
    trunkPhones: [SPRING_HILL_OFFICE_PHONE],
    greeting:
      "thank you for calling Abita Eye Group, this is David, how can I help you?",
    knowledgeFile: "KNOWLEDGE_SPRINGHILL.md",
    insuranceFile: "INSURANCE_SPRING_HILL_CRYSTAL_RIVER.md",
    amdOfficePhone: SPRING_HILL_OFFICE_PHONE,
    transferNumber: DEFAULT_TRANSFER_NUMBER,
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
    insuranceFile: "INSURANCE_SPRING_HILL_CRYSTAL_RIVER.md",
    amdOfficePhone: CRYSTAL_RIVER_OFFICE_PHONE,
    transferNumber: DEFAULT_TRANSFER_NUMBER,
    features: {
      routeToSpringHill: true,
    },
  },
};

export const OFFICE_BY_PHONE: Record<string, OfficeKey> = Object.fromEntries(
  Object.values(OFFICE_CONFIGS).flatMap((office) =>
    office.trunkPhones.map((phone) => [phone, office.key] as const),
  ),
);

export function getOfficeKeyByPhone(phone: string): OfficeKey {
  const officeKey = OFFICE_BY_PHONE[phone];
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
