import {
  getOfficeProfileByPhone,
  type OfficeProfile,
} from "../customers/abita/profile.js";
import {
  ownedMiddleware,
  type PatientResolveCandidate,
  type PatientResolveVerified,
} from "../clients/owned-middleware.js";
import type {
  CallerCandidate,
  CallerLookupFailed,
  CallerMatch,
  PhoneLookupResult,
  PreCallLookupTelemetry,
  PreCallContextState,
} from "../state/call-state.js";
import { CALLER_CANDIDATE_REF } from "../state/call-state.js";
import { normalizeCallerAppointments } from "../state/appointments.js";

export interface PreCallBootstrap {
  phoneLookup: PhoneLookupResult;
}

export async function lookupByPhone(
  phone: string,
  trunkPhone: string,
  signal?: AbortSignal,
): Promise<PhoneLookupResult> {
  const startedAt = Date.now();
  let office: OfficeProfile;
  try {
    office = getOfficeProfileByPhone(trunkPhone);
  } catch {
    return {
      status: "lookup_failed",
      phone,
      reason: "unsupported_trunk",
      retryable: false,
      lookupDurationMs: Date.now() - startedAt,
    };
  }

  const result = await ownedMiddleware().resolvePatient({
    office: office.amdOfficePhone,
    identity: { phone },
    fallbackPhone: phone,
    signal,
  });
  const lookupDurationMs = Date.now() - startedAt;
  if (result.status === "verified") {
    if (
      !result.patientId.trim() ||
      !result.name?.trim() ||
      !result.dob?.trim()
    ) {
      return lookupFailure(phone, "invalid_response", lookupDurationMs);
    }
    return {
      status: "verified",
      patientId: result.patientId,
      name: result.name,
      dob: result.dob,
      phone: result.phone ?? phone,
      insuranceCarrier: result.insuranceCarrier,
      insPlanId: result.insPlanId,
      respPartyId: result.respPartyId,
      routing: result.routing,
      allowedProviders: result.allowedProviders,
      routingAmbiguous: result.routingAmbiguous,
      preauthRequired: result.preauthRequired,
      appointmentsStatus: result.appointmentsStatus,
      appointmentsMessage: result.appointmentsMessage,
      appointments: result.appointments,
      lookupDurationMs,
    };
  }
  if (result.status === "multiple_matches") {
    return {
      status: "multiple_matches",
      message: "Multiple patient matches found.",
      matches: result.matches.map((match) =>
        patientResolveMatchToCallerMatch(match, phone, lookupDurationMs),
      ),
      lookupDurationMs,
    };
  }
  if (result.status === "not_found") {
    return {
      status: "no_match",
      phone,
      message: "No patient match found.",
      lookupDurationMs,
    };
  }
  return lookupFailure(
    phone,
    result.reason === "unsupported_office"
      ? "unsupported_trunk"
      : result.reason === "cancelled"
        ? "network_error"
        : result.reason,
    lookupDurationMs,
  );
}

function lookupFailure(
  phone: string,
  reason: CallerLookupFailed["reason"],
  lookupDurationMs: number,
): CallerLookupFailed {
  return {
    status: "lookup_failed",
    phone,
    reason,
    retryable: reason !== "unsupported_trunk",
    lookupDurationMs,
  };
}

function patientResolveMatchToCallerMatch(
  match: PatientResolveVerified | PatientResolveCandidate,
  fallbackPhone: string,
  lookupDurationMs: number,
): CallerMatch | CallerCandidate {
  if (match.status === "candidate") return match;
  return {
    status: "verified",
    patientId: match.patientId,
    name: match.name ?? "",
    dob: match.dob ?? "",
    phone: match.phone ?? fallbackPhone,
    insuranceCarrier: match.insuranceCarrier,
    insPlanId: match.insPlanId,
    respPartyId: match.respPartyId,
    routing: match.routing,
    allowedProviders: match.allowedProviders,
    routingAmbiguous: match.routingAmbiguous,
    preauthRequired: match.preauthRequired,
    appointmentsStatus: match.appointmentsStatus,
    appointmentsMessage: match.appointmentsMessage,
    appointments: match.appointments,
    lookupDurationMs,
  };
}

export async function loadPreCallBootstrap({
  callerPhone,
  trunkPhone,
  signal,
}: {
  callerPhone: string;
  trunkPhone: string;
  signal?: AbortSignal;
}): Promise<PreCallBootstrap> {
  const phoneLookup = await lookupByPhone(callerPhone, trunkPhone, signal);

  return { phoneLookup };
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
    const appointments = normalizeCallerAppointments(
      lookup.appointments,
      lookup.patientId,
    );
    return {
      status: "single_match_pending_confirmation",
      source: "phone_lookup",
      callerPhone,
      lookupDurationMs: lookup.lookupDurationMs,
      candidates: [
        {
          status: "verified",
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
  match: CallerMatch | CallerCandidate,
  index: number,
) {
  if (match.status === "verified") {
    const name = splitPatientName(match.name);
    return {
      status: "verified" as const,
      ref: `precall:${index + 1}`,
      firstName: name.firstName,
      lastName: name.lastName,
      dob: match.dob,
      patientId: match.patientId,
      relationshipToCaller: "unknown" as const,
      appointments: normalizeCallerAppointments(
        match.appointments,
        match.patientId,
      ),
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

  return {
    status: "candidate" as const,
    ref: `precall:${index + 1}`,
    patientId: match.patientId,
    firstName: match.firstName,
    lastName: match.lastName,
    dob: match.dob,
    appointments: [] as [],
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
