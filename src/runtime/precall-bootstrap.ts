import { lookupByPhone } from "../clients/advancedmd-client.js";
import type {
  CallerMatch,
  CallerMatchHint,
  PhoneLookupResult,
  PreCallLookupTelemetry,
  PreCallContextState,
} from "../state/call-state.js";
import { CALLER_CANDIDATE_REF } from "../state/call-state.js";
import { publicCallerAppointments } from "../state/appointments.js";

interface PreCallBootstrap {
  phoneLookup: PhoneLookupResult;
  verified: CallerMatch | null;
  telemetry: PreCallLookupTelemetry;
}

export async function loadPreCallBootstrap({
  callerPhone,
  trunkPhone,
}: {
  callerPhone: string;
  trunkPhone: string;
}): Promise<PreCallBootstrap> {
  const phoneLookup = await lookupByPhone(callerPhone, trunkPhone);
  const verified = phoneLookup?.status === "verified" ? phoneLookup : null;

  return {
    phoneLookup,
    verified,
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
          ref: CALLER_CANDIDATE_REF,
          firstName: name.firstName,
          lastName: name.lastName,
          dob: lookup.dob,
          patientId: lookup.patientId,
          relationshipToCaller: "self",
          appointments,
          appointmentsStatus: lookup.appointmentsStatus ?? undefined,
          insuranceCarrier: lookup.insuranceCarrier,
          insPlanId: lookup.insPlanId,
          respPartyId: lookup.respPartyId,
          routing: lookup.routing,
          allowedProviders: lookup.allowedProviders,
          routingAmbiguous: lookup.routingAmbiguous,
          preauthRequired: lookup.preauthRequired,
        },
      ],
      selectedCandidateRef: CALLER_CANDIDATE_REF,
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
      candidates: lookup.matches.map((match, index) =>
        preCallCandidateFromMatch(match, index),
      ),
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

function preCallCandidateFromMatch(
  match: CallerMatch | CallerMatchHint,
  index: number,
) {
  if ("status" in match && match.status === "verified") {
    const name = splitPatientName(match.name);
    return {
      ref: `precall:${index + 1}`,
      firstName: name.firstName,
      lastName: name.lastName,
      dob: match.dob,
      patientId: match.patientId,
      relationshipToCaller: "unknown" as const,
      appointments: publicCallerAppointments(match.appointments),
      appointmentsStatus: match.appointmentsStatus ?? undefined,
      insuranceCarrier: match.insuranceCarrier,
      insPlanId: match.insPlanId,
      respPartyId: match.respPartyId,
      routing: match.routing,
      allowedProviders: match.allowedProviders,
      routingAmbiguous: match.routingAmbiguous,
      preauthRequired: match.preauthRequired,
    };
  }

  if ("firstName" in match) {
    return {
      ref: `precall:${index + 1}`,
      firstName: match.firstName,
      appointments: [],
    };
  }

  return {
    ref: `precall:${index + 1}`,
    firstName: "",
    appointments: [],
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
