import { createHash } from "node:crypto";
import {
  normalizePhoneNumber,
  SWEETWATER_TRUNK_PHONES,
} from "./customer/profile.js";
import type { TtsProvider } from "./tts-config.js";

export const SWEETWATER_VOICE_EXPERIMENT_ID =
  "sweetwater_rime_cartesia_2026_06";

export type SweetwaterVoiceVariant = "cartesia" | "rime";

export type VoiceExperimentAssignment = {
  experimentId: typeof SWEETWATER_VOICE_EXPERIMENT_ID;
  scope: "sweetwater";
  variant: SweetwaterVoiceVariant;
  provider: TtsProvider;
  assignment: "sticky_caller_phone_hash" | "call_id_hash";
  assignmentHash: string;
};

export type VoiceExperimentMetadata = VoiceExperimentAssignment & {
  model?: string;
  speaker?: string;
  voiceId?: string;
};

const SWEETWATER_TRUNK_NUMBERS = new Set(
  SWEETWATER_TRUNK_PHONES.map((phone) => normalizePhoneNumber(phone)),
);

function hasPhoneNumberShape(value: string): boolean {
  return value.replace(/\D/g, "").length >= 10;
}

function assignmentKey(callerPhone: string, callId: string) {
  if (hasPhoneNumberShape(callerPhone)) {
    return {
      assignment: "sticky_caller_phone_hash" as const,
      key: normalizePhoneNumber(callerPhone),
    };
  }

  return {
    assignment: "call_id_hash" as const,
    key: callId.trim() || "unknown",
  };
}

function hashAssignment(key: string): string {
  return createHash("sha256")
    .update(`${SWEETWATER_VOICE_EXPERIMENT_ID}:${key}`)
    .digest("hex");
}

export function isSweetwaterVoiceExperimentTrunk(trunkPhone: string): boolean {
  return SWEETWATER_TRUNK_NUMBERS.has(normalizePhoneNumber(trunkPhone));
}

export function assignSweetwaterVoiceExperiment(input: {
  callId: string;
  callerPhone: string;
  trunkPhone: string;
}): VoiceExperimentAssignment | null {
  if (!isSweetwaterVoiceExperimentTrunk(input.trunkPhone)) return null;

  const { assignment, key } = assignmentKey(input.callerPhone, input.callId);
  const hash = hashAssignment(key);
  const bucket = Number.parseInt(hash.slice(0, 8), 16) % 2;
  const variant: SweetwaterVoiceVariant = bucket === 0 ? "cartesia" : "rime";

  return {
    experimentId: SWEETWATER_VOICE_EXPERIMENT_ID,
    scope: "sweetwater",
    variant,
    provider: variant,
    assignment,
    assignmentHash: hash.slice(0, 16),
  };
}
