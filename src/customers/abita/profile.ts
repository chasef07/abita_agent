// Abita customer profile: office registry for trunk routing, prompts, and tool behavior.

export type OfficeKey =
  | "spring-hill"
  | "crystal-river"
  | "hollywood"
  | "sweetwater"
  | "north-miami-beach-optical"
  | "dev";
export const SPRING_HILL_OFFICE_PHONE = "+17275919997";
export const SPRING_HILL_813_TRUNK_PHONE = "+18135484830";
export const CRYSTAL_RIVER_OFFICE_PHONE = "+13523202007";
export const HOLLYWOOD_OFFICE_PHONE = "+19542872010";
export const SWEETWATER_OFFICE_PHONE = "+17864657475";
export const NORTH_MIAMI_BEACH_OPTICAL_OFFICE_PHONE = "+13055095333";
export const SWEETWATER_TRUNK_PHONES = [
  SWEETWATER_OFFICE_PHONE,
  "+17864654845",
  "+17866134310",
  "+17864657479",
  "+17864654836",
  "+17864654882",
] as const;
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
  handoffTarget: string;
  features: {
    medicalScheduling: boolean;
    routineVisionScheduling: boolean;
  };
}
const SPRING_HILL_TRANSFER_NUMBER = "+16182265883";
const CRYSTAL_RIVER_TRANSFER_NUMBER = "+13527941244";
const HOLLYWOOD_SWEETWATER_TRANSFER_NUMBER = "+16184220360";
const SWEETWATER_OPTICAL_TRANSFER_NUMBER = "+17864657479";
const OFFICE_HANDOFF_TARGET_ENV: Record<OfficeKey, string[]> = {
  "spring-hill": [
    "SPRING_HILL_HANDOFF_TARGET",
    "TELNYX_VOICE_API_HANDOFF_TARGET",
  ],
  "crystal-river": [],
  hollywood: ["HOLLYWOOD_HANDOFF_TARGET"],
  sweetwater: ["SWEETWATER_HANDOFF_TARGET"],
  "north-miami-beach-optical": ["NORTH_MIAMI_BEACH_OPTICAL_HANDOFF_TARGET"],
  dev: [],
};

export const OFFICE_CONFIGS: Record<OfficeKey, OfficeConfig> = {
  "spring-hill": {
    key: "spring-hill",
    displayName: "Abita Eye Group",
    trunkPhones: [SPRING_HILL_OFFICE_PHONE, SPRING_HILL_813_TRUNK_PHONE],
    greeting:
      "Hey this is Zoe, the virtual assistant at Abeeta Eye Group. How's your day going",
    knowledgeFile: "KNOWLEDGE_SPRINGHILL.md",
    insuranceFile: "INSURANCE_SPRING_HILL_CRYSTAL_RIVER.json",
    visionInsuranceFile: "INSURANCE_SPRING_HILL_ROUTINE_VISION.json",
    amdOfficePhone: SPRING_HILL_OFFICE_PHONE,
    handoffTarget: `tel:${SPRING_HILL_TRANSFER_NUMBER}`,
    features: {
      medicalScheduling: true,
      routineVisionScheduling: true,
    },
  },
  "crystal-river": {
    key: "crystal-river",
    displayName: "Eye Radiance",
    trunkPhones: [CRYSTAL_RIVER_OFFICE_PHONE],
    greeting:
      "Hey this is Zoe, the virtual assistant at Eye Radiance, powered by Abeeta Eye Group. How's your day going",
    knowledgeFile: "KNOWLEDGE_EYERADIANCE.md",
    insuranceFile: "INSURANCE_CRYSTAL_RIVER.json",
    visionInsuranceFile: "INSURANCE_SPRING_HILL_ROUTINE_VISION.json",
    amdOfficePhone: CRYSTAL_RIVER_OFFICE_PHONE,
    handoffTarget: `tel:${CRYSTAL_RIVER_TRANSFER_NUMBER}`,
    features: {
      medicalScheduling: true,
      routineVisionScheduling: false,
    },
  },
  hollywood: {
    key: "hollywood",
    displayName: "Abita Eye Group Hollywood",
    trunkPhones: [HOLLYWOOD_OFFICE_PHONE],
    greeting:
      "Hey this is Zoe, the virtual assistant at Abeeta Eye Group. How's your day going",
    knowledgeFile: "KNOWLEDGE_HOLLYWOOD.md",
    insuranceFile: "INSURANCE_HOLLYWOOD_SWEETWATER.json",
    visionInsuranceFile: "INSURANCE_SPRING_HILL_ROUTINE_VISION.json",
    amdOfficePhone: HOLLYWOOD_OFFICE_PHONE,
    handoffTarget: `tel:${HOLLYWOOD_SWEETWATER_TRANSFER_NUMBER}`,
    features: {
      medicalScheduling: true,
      routineVisionScheduling: true,
    },
  },
  sweetwater: {
    key: "sweetwater",
    displayName: "Abita Eye Group Sweetwater",
    trunkPhones: [...SWEETWATER_TRUNK_PHONES],
    greeting:
      "Hey this is Maya, the virtual assistant at Abeeta Eye Group. How's your day going",
    knowledgeFile: "KNOWLEDGE_SWEETWATER.md",
    insuranceFile: "INSURANCE_HOLLYWOOD_SWEETWATER.json",
    visionInsuranceFile: "INSURANCE_SPRING_HILL_ROUTINE_VISION.json",
    amdOfficePhone: SWEETWATER_OFFICE_PHONE,
    handoffTarget: `tel:${HOLLYWOOD_SWEETWATER_TRANSFER_NUMBER}`,
    features: {
      medicalScheduling: true,
      routineVisionScheduling: true,
    },
  },
  "north-miami-beach-optical": {
    key: "north-miami-beach-optical",
    displayName: "North Miami Beach Optical",
    trunkPhones: [NORTH_MIAMI_BEACH_OPTICAL_OFFICE_PHONE],
    greeting:
      "Hey this is Zoe, the virtual assistant at North Miami Beach Optical. How's your day going",
    knowledgeFile: "KNOWLEDGE_NORTH_MIAMI_BEACH_OPTICAL.md",
    insuranceFile: "INSURANCE_SPRING_HILL_ROUTINE_VISION.json",
    visionInsuranceFile: "INSURANCE_SPRING_HILL_ROUTINE_VISION.json",
    amdOfficePhone: NORTH_MIAMI_BEACH_OPTICAL_OFFICE_PHONE,
    handoffTarget: `tel:${SWEETWATER_OPTICAL_TRANSFER_NUMBER}`,
    features: {
      medicalScheduling: false,
      routineVisionScheduling: true,
    },
  },
  dev: {
    key: "dev",
    displayName: "Abita Dev",
    trunkPhones: [DEV_OFFICE_PHONE],
    greeting:
      "Hey this is Julia, the virtual assistant at Acuity Health. How's your day going",
    knowledgeFile: "KNOWLEDGE_SPRINGHILL.md",
    insuranceFile: "INSURANCE_SPRING_HILL_CRYSTAL_RIVER.json",
    visionInsuranceFile: "INSURANCE_SPRING_HILL_ROUTINE_VISION.json",
    amdOfficePhone: DEV_OFFICE_PHONE,
    middlewareBaseUrl: "https://advancedmd-token-management-dev.up.railway.app",
    handoffTarget: `tel:${SPRING_HILL_TRANSFER_NUMBER}`,
    features: {
      medicalScheduling: true,
      routineVisionScheduling: true,
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

export function normalizeHandoffTarget(target: string): string {
  const trimmed = target.trim();
  if (/^(tel|sip):/i.test(trimmed)) return trimmed;
  return `tel:${normalizePhoneNumber(trimmed)}`;
}

export function getOfficeHandoffTarget(key: OfficeKey): string {
  for (const envVar of OFFICE_HANDOFF_TARGET_ENV[key]) {
    const value = process.env[envVar]?.trim();
    if (value) return normalizeHandoffTarget(value);
  }
  return normalizeHandoffTarget(getOfficeConfig(key).handoffTarget);
}
