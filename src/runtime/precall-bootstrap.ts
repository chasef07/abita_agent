import {
  getOfficeConfigByPhone,
  type OfficeConfig,
} from "../customers/profile.js";
import { lookupByPhone } from "../clients/advancedmd-client.js";
import type {
  PhoneLookupResult,
  PreCallLookupTelemetry,
} from "../state/call-state.js";

export interface PreCallBootstrap {
  office: OfficeConfig;
  phoneLookup: PhoneLookupResult;
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

  return {
    office,
    phoneLookup,
    telemetry: preCallLookupTelemetry(phoneLookup),
  };
}

function preCallLookupTelemetry(
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
    ...(lookup.status === "verified"
      ? { candidateCount: 1, appointmentsStatus: lookup.appointmentsStatus }
      : {}),
    ...(lookup.status === "multiple_matches"
      ? { candidateCount: lookup.matches.length }
      : {}),
    ...(lookup.status === "no_match" ? { candidateCount: 0 } : {}),
    ...(lookup.status === "lookup_failed"
      ? {
          candidateCount: 0,
          failureReason: lookup.reason,
          retryable: lookup.retryable,
        }
      : {}),
  };
}

export function formatPhoneLookupLogLine(
  _callerPhone: string,
  lookup: PhoneLookupResult,
): string {
  if (lookup?.status === "verified") {
    return `[call] Caller match found`;
  }
  if (lookup?.status === "multiple_matches") {
    return `[call] Multiple caller matches found count=${lookup.matches.length}`;
  }
  if (lookup?.status === "lookup_failed") {
    return `[call] Phone lookup unavailable: ${lookup.reason}`;
  }
  return `[call] No patient match`;
}
