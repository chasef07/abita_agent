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
import { publicCallerAppointments } from "./call-state.js";
import type { PreCallContextState } from "../flow/index.js";

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

export function buildPreCallContextState(
  lookup: PhoneLookupResult,
  callerPhone: string,
): PreCallContextState {
  if (!lookup) {
    return {
      status: "not_attempted",
      source: "phone_lookup",
      callerPhone,
      candidates: [],
      identityPromotion: "none",
    };
  }

  if (lookup.status === "verified") {
    const name = splitPatientName(lookup.name);
    const appointments = publicCallerAppointments(lookup.appointments);
    return {
      status: "single_match_pending_confirmation",
      source: "phone_lookup",
      callerPhone,
      lookupDurationMs: lookup.lookupDurationMs,
      candidates: [
        {
          ref: "caller",
          firstName: name.firstName,
          lastName: name.lastName,
          dob: lookup.dob,
          patientId: lookup.patientId,
          relationshipToCaller: "self",
          appointments,
          appointmentsStatus: lookup.appointmentsStatus ?? undefined,
        },
      ],
      selectedCandidateRef: "caller",
      appointmentLoadStatus: lookup.appointmentsStatus ?? undefined,
      appointmentMessage: lookup.appointmentsMessage ?? undefined,
      identityPromotion: "none",
    };
  }

  if (lookup.status === "multiple_matches") {
    return {
      status: "multiple_matches_pending_selection",
      source: "phone_lookup",
      callerPhone,
      lookupDurationMs: lookup.lookupDurationMs,
      candidates: lookup.matches.map((match, index) => ({
        ref: `precall:${index + 1}`,
        firstName: match.firstName,
        appointments: [],
      })),
      identityPromotion: "none",
    };
  }

  if (lookup.status === "lookup_failed") {
    return {
      status: "lookup_failed",
      source: "phone_lookup",
      callerPhone,
      lookupDurationMs: lookup.lookupDurationMs,
      failureReason: lookup.reason,
      retryable: lookup.retryable,
      candidates: [],
      identityPromotion: "none",
    };
  }

  return {
    status: "no_match",
    source: "phone_lookup",
    callerPhone,
    lookupDurationMs: lookup.lookupDurationMs,
    candidates: [],
    identityPromotion: "none",
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

function splitPatientName(patientName: string): {
  firstName?: string;
  lastName?: string;
} {
  const [lastName, firstAndMiddle] = patientName
    .split(",", 2)
    .map((part) => part.trim())
    .filter(Boolean);
  if (lastName && firstAndMiddle) {
    return {
      firstName: firstAndMiddle.split(/\s+/).filter(Boolean)[0],
      lastName,
    };
  }

  const parts = patientName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return {};
  if (parts.length === 1) return { firstName: parts[0] };
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(" "),
  };
}
