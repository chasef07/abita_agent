import {
  getOfficeConfigByPhone,
  isFlowHarnessEnabledForTrunk,
  type OfficeConfig,
} from "../customer/profile.js";
import { lookupByPhone } from "./advancedmd-client.js";
import type {
  CallerMatch,
  PhoneLookupResult,
  PreCallLookupTelemetry,
} from "./call-state.js";

export interface PreCallBootstrap {
  office: OfficeConfig;
  phoneLookup: PhoneLookupResult;
  verified: CallerMatch | null;
  flowHarnessEnabled: boolean;
  telemetry: PreCallLookupTelemetry;
}

export async function loadPreCallBootstrap({
  callerPhone,
  trunkPhone,
}: {
  callerPhone: string;
  trunkPhone: string;
}): Promise<PreCallBootstrap> {
  const office = getOfficeConfigByPhone(trunkPhone);
  const phoneLookup = await lookupByPhone(callerPhone, trunkPhone);
  const verified = phoneLookup?.status === "verified" ? phoneLookup : null;

  return {
    office,
    phoneLookup,
    verified,
    flowHarnessEnabled: isFlowHarnessEnabledForTrunk(trunkPhone),
    telemetry: preCallLookupTelemetry(phoneLookup),
  };
}

export function preCallLookupTelemetry(
  lookup: PhoneLookupResult,
): PreCallLookupTelemetry {
  if (!lookup) {
    return {
      status: "not_attempted",
      durationMs: null,
    };
  }

  return {
    status: lookup.status,
    durationMs: lookup.lookupDurationMs ?? null,
    ...(lookup.status === "lookup_failed"
      ? { failureReason: lookup.reason, retryable: lookup.retryable }
      : {}),
  };
}

export function formatPhoneLookupLogLine(
  callerPhone: string,
  lookup: PhoneLookupResult,
): string {
  if (lookup?.status === "verified") {
    return `[call] Caller match: ${lookup.name} (ID: ${lookup.patientId})`;
  }
  if (lookup?.status === "multiple_matches") {
    return `[call] Multiple matches for ${callerPhone}: ${lookup.matches
      .map((match) => match.firstName)
      .join(", ")}`;
  }
  if (lookup?.status === "lookup_failed") {
    return `[call] Phone lookup unavailable for ${callerPhone}: ${lookup.reason}`;
  }
  return `[call] No patient match for ${callerPhone}`;
}
