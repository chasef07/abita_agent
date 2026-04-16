// offices.ts — Shared office registry for trunk routing, prompts, and tool behavior.

export type OfficeKey =
  | "spring-hill"
  | "crystal-river"
  | "optical-eyeworks"
  | "beacon-optical";
export const SPRING_HILL_OFFICE_PHONE = "+17275919997";
export const CRYSTAL_RIVER_OFFICE_PHONE = "+13523202007";
export const OPTICAL_EYEWORKS_OFFICE_PHONE = "+19542872010";
export const BEACON_OPTICAL_OFFICE_PHONE = "+17864657509";

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
    knowledgeFile: "KNOWLEDGE_SPRINGHILL.json",
    insuranceFile: "INSURANCE_SPRING_HILL_CRYSTAL_RIVER.json",
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
    knowledgeFile: "KNOWLEDGE_EYERADIANCE.json",
    insuranceFile: "INSURANCE_SPRING_HILL_CRYSTAL_RIVER.json",
    amdOfficePhone: CRYSTAL_RIVER_OFFICE_PHONE,
    transferNumber: DEFAULT_TRANSFER_NUMBER,
    features: {
      routeToSpringHill: true,
    },
  },
  "optical-eyeworks": {
    key: "optical-eyeworks",
    displayName: "Optical Eyeworks",
    trunkPhones: [OPTICAL_EYEWORKS_OFFICE_PHONE],
    greeting:
      "Thank you for calling Optical Eyeworks, powered by Abita Eye Group, this is David, how can I help you?",
    knowledgeFile: "KNOWLEDGE_OPTICAL_EYEWORKS.json",
    insuranceFile: "INSURANCE_OPTICAL_EYEWORKS_BEACON.json",
    amdOfficePhone: OPTICAL_EYEWORKS_OFFICE_PHONE,
    transferNumber: DEFAULT_TRANSFER_NUMBER,
    features: {
      routeToSpringHill: false,
    },
  },
  "beacon-optical": {
    key: "beacon-optical",
    displayName: "Beacon Optical",
    trunkPhones: [BEACON_OPTICAL_OFFICE_PHONE],
    greeting:
      "Thank you for calling Beacon Optical, powered by Abita Eye Group, this is David, how can I help you?",
    knowledgeFile: "KNOWLEDGE_BEACON_OPTICAL.json",
    insuranceFile: "INSURANCE_OPTICAL_EYEWORKS_BEACON.json",
    amdOfficePhone: BEACON_OPTICAL_OFFICE_PHONE,
    transferNumber: DEFAULT_TRANSFER_NUMBER,
    features: {
      routeToSpringHill: false,
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
