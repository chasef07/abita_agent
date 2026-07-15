import type { PreCallBootstrap } from "../runtime/precall-bootstrap.js";
import { publicCallerAppointments } from "./appointments.js";
import {
  CALLER_CANDIDATE_REF,
  createCanonicalCallState,
  type CallerAppointment,
  type CallerMatch,
  type CallerMatchHint,
  type CallState,
  type PhoneLookupResult,
  type PreCallContextState,
  type PreCallLookupTelemetry,
  type RuntimeVoiceLanguageState,
} from "./call-state.js";

interface InitialCall {
  callId: string;
  callerPhone: string;
  trunkPhone: string;
  sipRoomName: string;
  sipParticipantIdentity: string;
}

interface InitialCallStateOptions {
  call: InitialCall;
  bootstrap: PreCallBootstrap;
  voiceLanguage: RuntimeVoiceLanguageState;
  maxDurationMs: number;
}

type NormalizedCallerMatch = Omit<CallerMatch, "appointments"> & {
  appointments: CallerAppointment[];
};

interface LookupSeed {
  lookup: PhoneLookupResult;
  verified: NormalizedCallerMatch | null;
}

export function createInitialCallState({
  call,
  bootstrap,
  voiceLanguage,
  maxDurationMs,
}: InitialCallStateOptions): CallState {
  const seed = normalizeLookup(bootstrap.phoneLookup);
  const verified = seed.verified;
  const state = createCanonicalCallState({
    preCall: preCallContext(seed, call.callerPhone),
    preCallLookup: preCallLookupTelemetry(seed.lookup),
    officeKey: bootstrap.office.key,
    amdOfficePhone: bootstrap.office.amdOfficePhone,
    sipRoomName: call.sipRoomName,
    sipParticipantIdentity: call.sipParticipantIdentity,
    callId: call.callId,
    callerPhone: call.callerPhone,
    trunkPhone: call.trunkPhone,
    patientId: verified?.patientId ?? null,
    patientName: verified?.name ?? null,
    dob: verified?.dob ?? null,
    insuranceCarrier: verified?.insuranceCarrier ?? null,
    insPlanId: verified?.insPlanId ?? null,
    respPartyId: verified?.respPartyId ?? null,
    checkedInsurancePlan: verified?.insuranceCarrier ?? null,
    checkedInsuranceCoverageType: null,
    routing: verified?.routing ?? null,
    lastAvailabilityRouting: null,
    lastAvailabilitySlots: [],
    bookableAvailabilitySlots: [],
    allowedProviders: verified?.allowedProviders ?? [],
    routingAmbiguous: verified?.routingAmbiguous ?? false,
    preauthRequired: verified?.preauthRequired ?? false,
    appointmentsStatus: verified?.appointmentsStatus ?? null,
    appointments: verified?.appointments ?? [],
    voiceLanguage,
  });
  state.runtime.maxCallDurationMs = maxDurationMs;
  return state;
}

function normalizeLookup(lookup: PhoneLookupResult): LookupSeed {
  if (lookup?.status !== "verified") {
    return { lookup, verified: null };
  }

  const verified = normalizeCallerMatch(lookup);
  return { lookup: verified, verified };
}

function normalizeCallerMatch(match: CallerMatch): NormalizedCallerMatch {
  return {
    ...match,
    appointments: publicCallerAppointments(match.appointments),
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

function preCallContext(
  seed: LookupSeed,
  callerPhone: string,
): PreCallContextState {
  const lookup = seed.lookup;
  if (!lookup) {
    return emptyPreCallContext("not_attempted", callerPhone);
  }

  if (seed.verified) {
    const verified = seed.verified;
    return {
      status: "single_match_pending_confirmation",
      source: "phone_lookup",
      callerPhone,
      lookupDurationMs: verified.lookupDurationMs,
      candidates: [
        verifiedPreCallCandidate(verified, CALLER_CANDIDATE_REF, "self"),
      ],
      selectedCandidateRef: CALLER_CANDIDATE_REF,
      appointmentLoadStatus: verified.appointmentsStatus ?? undefined,
      appointmentMessage: verified.appointmentsMessage ?? undefined,
      identityPromotion: "none",
    };
  }

  if (lookup.status === "multiple_matches") {
    return {
      status: "multiple_matches_pending_selection",
      source: "phone_lookup",
      callerPhone,
      lookupDurationMs: lookup.lookupDurationMs,
      candidates: lookup.matches.map(preCallCandidate),
      identityPromotion: "none",
    };
  }

  if (lookup.status === "lookup_failed") {
    return {
      ...emptyPreCallContext("lookup_failed", callerPhone),
      lookupDurationMs: lookup.lookupDurationMs,
      failureReason: lookup.reason,
      retryable: lookup.retryable,
    };
  }

  return {
    ...emptyPreCallContext("no_match", callerPhone),
    lookupDurationMs: lookup.lookupDurationMs,
  };
}

function emptyPreCallContext(
  status: "not_attempted" | "no_match" | "lookup_failed",
  callerPhone: string,
): PreCallContextState {
  return {
    status,
    source: "phone_lookup",
    callerPhone,
    candidates: [],
    identityPromotion: "none",
  };
}

function preCallCandidate(match: CallerMatch | CallerMatchHint, index: number) {
  const ref = `precall:${index + 1}`;
  if ("status" in match) {
    return verifiedPreCallCandidate(
      normalizeCallerMatch(match),
      ref,
      "unknown",
    );
  }

  return {
    ref,
    firstName: match.firstName,
    appointments: [],
  };
}

function verifiedPreCallCandidate(
  match: NormalizedCallerMatch,
  ref: string,
  relationshipToCaller: "self" | "unknown",
) {
  const name = splitPatientName(match.name);
  return {
    ref,
    firstName: name.firstName,
    lastName: name.lastName,
    dob: match.dob,
    patientId: match.patientId,
    relationshipToCaller,
    appointments: match.appointments,
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
