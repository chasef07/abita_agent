import type {
  PatientResolveResult,
  PatientResolveVerified,
} from "../clients/owned-middleware.js";
import { getOfficeProfileByPhone } from "../customers/abita/profile.js";
import { normalizeCallerAppointments } from "../state/appointments.js";
import {
  CALLER_CANDIDATE_REF,
  type AppointmentLoadStatus,
  type CallState,
  type CallerAppointment,
  type PatientIdentityOutcome,
  type PendingPatientRegistrationIdentity,
  type PreCallContextState,
  type PreCallVerifiedPatientCandidate,
  recordPatientIdentityOutcome,
  recordPatientIdentityTransition,
  setPatientBackendRefs,
  type StoredCallerAppointment,
} from "../state/call-state.js";
import { resetActiveOfficeToTrunk } from "../state/call-lifecycle.js";
import { recordOwnedMiddlewareFailure } from "../state/observability.js";
import {
  insuranceOnFile,
  insuranceSnapshot,
  resetPatientSchedulingState,
  setInsuranceOnFile,
  setRoutingContext,
} from "../scheduling/state.js";
import {
  appointmentStatusFromResult,
  extractAppointments,
} from "../scheduling/appointments.js";
import { getAmdOfficeForToolCall } from "../scheduling/routing.js";
import {
  dobMatches,
  matchCandidatesByFirstName,
  namesMatch,
} from "./name-matcher.js";

export interface PatientLookupIdentity {
  firstName: string;
  lastName: string;
  dob: string;
}

export interface PatientReferenceIdentity {
  patientId: string;
}

export type PatientResolveLookupIdentity =
  PatientLookupIdentity | PatientReferenceIdentity;

export type PatientResolveLookup = (
  officePhone: string,
  identity: PatientResolveLookupIdentity,
) => Promise<PatientResolveResult>;

export type ResolvePatientIdentityInput = Partial<PatientLookupIdentity> & {
  registrationStatus?: "registered_before" | "not_registered" | "unsure";
};

export interface TranscriptIdentityConfirmation {
  candidateRef: string;
  systemMessage: string;
}

type PreCallCandidate = PreCallContextState["candidates"][number];

type ActivationReason =
  | "confirmed_by_transcript"
  | "confirmed_by_identity_tool"
  | "switched_by_identity_tool";

type IdentityResolution = {
  outcome: PatientIdentityOutcome;
  reply: string;
};

const pendingCandidateHydrations = new WeakMap<
  CallState,
  Map<string, Promise<IdentityResolution>>
>();

interface PatientIdentitySnapshot {
  patientId?: string | null;
  name?: string | null;
  dob?: string | null;
}

interface ActivePatientInput {
  status: "verified" | "created";
  patientId: string;
  name: string | null;
  dob: string | null;
  phone: string | null;
  appointments: CallerAppointment[];
  appointmentsStatus: AppointmentLoadStatus | null;
  insuranceCarrier: string | null;
  insPlanId: string | null;
  respPartyId: string | null;
  routing: string | null;
  allowedProviders: string[];
  routingAmbiguous: boolean;
  preauthRequired: boolean;
}

type PatientStatePayload = {
  status?: string | null;
  patientId?: string | null;
  name?: string | null;
  dob?: string | null;
  phone?: string | null;
  insuranceCarrier?: string | null;
  insPlanId?: string | null;
  respPartyId?: string | null;
  routing?: string | null;
  allowedProviders?: string[];
  routingAmbiguous?: boolean;
  preauthRequired?: boolean;
  appointmentsStatus?: AppointmentLoadStatus | null;
  rawAppointments?: StoredCallerAppointment[] | null;
  appointments?: StoredCallerAppointment[];
};

export function restoreConfirmedPreCallPatient(state: CallState): void {
  const preCall = state.identity.preCall;
  if (
    preCall?.status !== "single_match_confirmed" &&
    preCall?.status !== "multiple_match_confirmed"
  ) {
    return;
  }
  const candidate =
    candidateByRef(
      preCall,
      preCall.selectedCandidateRef ?? CALLER_CANDIDATE_REF,
    ) ?? null;
  if (candidate?.status !== "verified") return;
  if (
    state.identity.patient.identityConfirmed ||
    state.identity.patient.status === "created" ||
    state.identity.patient.status === "new"
  ) {
    return;
  }
  activatePreloadedCandidate(state, candidate, "confirmed_by_identity_tool");
}

export function applyPatientResult(
  state: CallState,
  result: PatientStatePayload,
): void {
  const patientId = result.patientId?.trim();
  if (!patientId) return;
  const extractedAppointments = extractAppointments(result);
  const resultStatus = String(result.status ?? "").toLowerCase();
  activatePatient(
    state,
    {
      status:
        resultStatus === "created" || resultStatus === "partial"
          ? "created"
          : "verified",
      patientId,
      name: result.name ?? null,
      dob: result.dob ?? null,
      phone: result.phone ?? null,
      insuranceCarrier: result.insuranceCarrier ?? null,
      insPlanId: result.insPlanId ?? null,
      respPartyId: result.respPartyId ?? null,
      routing: result.routing ?? null,
      allowedProviders: Array.isArray(result.allowedProviders)
        ? result.allowedProviders
        : [],
      routingAmbiguous: result.routingAmbiguous ?? false,
      preauthRequired: result.preauthRequired ?? false,
      appointmentsStatus: appointmentStatusFromResult(
        result,
        extractedAppointments,
      ),
      appointments: normalizeCallerAppointments(
        extractedAppointments,
        patientId,
      ),
    },
    "operation",
  );
}

export function preCallCandidateMatchesIdentity(
  candidate: PreCallCandidate,
  identity: Pick<PatientLookupIdentity, "lastName" | "dob">,
): boolean {
  return Boolean(
    candidate.patientId &&
    namesMatch(identity.lastName, candidate.lastName) &&
    dobMatches(identity.dob, candidate.dob),
  );
}

export async function confirmIdentityFromTranscript(
  {
    state,
    transcript,
    lastAssistantText,
  }: {
    state: CallState;
    transcript: string;
    lastAssistantText: string | null | undefined;
  },
  lookup: PatientResolveLookup,
): Promise<TranscriptIdentityConfirmation | null> {
  const preCall = state.identity.preCall;
  if (!preCall || state.identity.patient.identityConfirmed) return null;
  if (state.identity.patient.status === "new") return null;
  if (!isFirstNamePrompt(lastAssistantText)) return null;

  const selection =
    preCall.status === "single_match_pending_confirmation"
      ? singlePreCallCandidateSelection(preCall, transcript)
      : multiplePreCallCandidateSelection(preCall, transcript);
  if (!selection) return null;
  const candidate = selection.candidate;

  if (candidate.status === "candidate") {
    const resolution = await hydratePreCallCandidate(
      state,
      candidate,
      lookup,
      "caller_transcript",
    );
    if (!state.identity.patient.identityConfirmed) {
      recordPatientIdentityTransition(state, {
        outcome:
          resolution.outcome === "verified" ? "confirmed" : resolution.outcome,
        source: "caller_transcript",
      });
      return {
        candidateRef: candidate.ref,
        systemMessage: `Internal state: the selected pre-call patient was not activated. ${resolution.reply}`,
      };
    }
  } else {
    activatePreloadedCandidate(state, candidate, "confirmed_by_transcript");
  }
  if (!state.identity.patient.identityConfirmed) return null;
  recordPatientIdentityTransition(state, {
    outcome: "confirmed",
    source: "caller_transcript",
  });

  return {
    candidateRef: candidate.ref,
    systemMessage: confirmedPatientSystemMessage(
      state,
      selection.otherMentionedCandidates,
    ),
  };
}

export async function resolvePatientIdentity(
  state: CallState,
  input: ResolvePatientIdentityInput,
  lookup: PatientResolveLookup,
): Promise<string> {
  const identity = normalizeResolvePatientInput(input);

  if (identity.registrationStatus === "not_registered") {
    if (state.identity.patient.status === "new") {
      if (pendingRegistrationTargetsDifferentPatient(state, identity)) {
        beginNewPatientRegistration(state, identity, {
          preserveEligibilityCheck: false,
        });
      } else {
        mergePendingRegistrationIdentity(state, identity);
      }
      return recordIdentityResolution(state, {
        outcome: "new",
        reply:
          "New-chart path confirmed. Continue registration and call add_patient only after read-back confirmation.",
      });
    }
    const activePatientReply = activePatientBlocksNewChartReply(
      state,
      identity,
    );
    if (activePatientReply) {
      return recordIdentityResolution(state, {
        outcome: "verified",
        reply: activePatientReply,
      });
    }
    beginNewPatientRegistration(state, identity, {
      preserveEligibilityCheck: true,
    });
    return recordIdentityResolution(state, {
      outcome: "new",
      reply:
        "New-chart path confirmed. Continue registration and call add_patient only after read-back confirmation.",
    });
  }

  const preCallResolution = await resolveFromPreCallState(
    state,
    identity,
    lookup,
  );
  if (preCallResolution) {
    return recordIdentityResolution(state, preCallResolution);
  }

  if (
    identity.registrationStatus === "registered_before" &&
    !hasFullIdentity(identity)
  ) {
    return recordIdentityResolution(state, {
      outcome: "needs_identity",
      reply:
        "Collect the patient's first name, last name, and date of birth, then call resolve_patient again.",
    });
  }

  if (!hasFullIdentity(identity)) {
    return recordIdentityResolution(state, {
      outcome: "needs_identity",
      reply: missingIdentityReply(state, identity),
    });
  }

  if (
    state.identity.patient.identityConfirmed &&
    !identityTargetsDifferentPatient(state, identity) &&
    state.identity.patient.appointmentsStatus !== "error"
  ) {
    const patientName =
      state.identity.patient.name?.trim() || "The active patient";
    return recordIdentityResolution(state, {
      outcome: "verified",
      reply: `${patientName} is already the active patient. Continue with loaded patient state.`,
    });
  }

  const targetsDifferentPatient = identityTargetsDifferentPatient(
    state,
    identity,
  );
  const hadConfirmedActivePatient =
    state.identity.patient.identityConfirmed ||
    state.identity.patient.status === "created";
  const officePhone = targetsDifferentPatient
    ? getOfficeProfileByPhone(state.runtime.trunkPhone).amdOfficePhone
    : getAmdOfficeForToolCall(state);
  const operationVersion = beginPatientIdentityOperation(state);
  const result = await lookup(officePhone, identity);
  if (!patientIdentityOperationIsCurrent(state, operationVersion)) {
    return "Patient lookup was superseded by a newer identity change. Continue with the current patient's state.";
  }
  if (result.status === "verified") {
    if (!completeVerifiedIdentity(result)) {
      return recordIdentityResolution(state, {
        outcome: "lookup_failed",
        reply: "Patient lookup returned an incomplete identity. Try again.",
      });
    }
    const patientChanged = activateResolvedPatient(state, result);
    return recordIdentityResolution(state, {
      outcome:
        hadConfirmedActivePatient && patientChanged ? "switched" : "verified",
      reply: confirmedPatientReply(state),
    });
  }
  if (result.status === "not_found") {
    const clarification = preCallNameMismatchReply(state, identity);
    if (clarification) {
      return recordIdentityResolution(state, {
        outcome: "not_found",
        reply: clarification,
      });
    }
  }
  if (result.status === "error") {
    recordOwnedMiddlewareFailure(state, "resolvePatient", result);
  }
  return recordIdentityResolution(state, {
    outcome:
      result.status === "not_found"
        ? "not_found"
        : result.status === "multiple_matches"
          ? "multiple_matches"
          : "lookup_failed",
    reply: patientLookupReply(result),
  });
}

function recordIdentityResolution(
  state: CallState,
  resolution: IdentityResolution,
): string {
  recordPatientIdentityOutcome(state, resolution.outcome);
  recordPatientIdentityTransition(state, {
    outcome:
      resolution.outcome === "verified" ? "confirmed" : resolution.outcome,
    source: "resolve_patient",
  });
  return resolution.reply;
}

function activatePatient(
  state: CallState,
  patient: ActivePatientInput,
  source: "operation" | "synchronous",
): boolean {
  advancePatientIdentityTransition(state, source);
  const previous = snapshotActivePatientIdentity(state);
  const patientChanged = identityDiffers(previous, patient);
  if (patientChanged) {
    resetPatientScopedWork(state);
  }

  setPatientBackendRefs(state, {
    insPlanId: patient.insPlanId,
    respPartyId: patient.respPartyId,
  });
  state.identity.patient = {
    ...state.identity.patient,
    status: patient.status,
    identityConfirmed: true,
    patientId: patient.patientId,
    name: patient.name,
    dob: patient.dob,
    phone: patient.phone,
    appointments: normalizeCallerAppointments(
      patient.appointments,
      patient.patientId,
    ),
    appointmentsStatus: patient.appointmentsStatus,
  };
  delete state.identity.pendingRegistration;
  setInsuranceOnFile(
    state,
    patient.insuranceCarrier
      ? insuranceSnapshot({
          plan: patient.insuranceCarrier,
          canonicalPlan: patient.insuranceCarrier,
          coverageType:
            patient.routing === "optical_only" ? "routine_vision" : null,
          currentCarrier: patient.insuranceCarrier,
        })
      : null,
  );
  setRoutingContext(state, patient);
  return patientChanged;
}

function activatePreloadedCandidate(
  state: CallState,
  candidate: PreCallVerifiedPatientCandidate,
  reason: ActivationReason,
): void {
  const preCall = state.identity.preCall;
  if (!candidate.patientId || !preCall) return;

  const selectedRef =
    candidate.ref || preCall.selectedCandidateRef || CALLER_CANDIDATE_REF;
  preCall.status =
    preCall.status === "single_match_pending_confirmation" ||
    preCall.status === "single_match_confirmed"
      ? "single_match_confirmed"
      : "multiple_match_confirmed";
  preCall.selectedCandidateRef = selectedRef;
  preCall.identityPromotion = reason;

  activatePatient(
    state,
    {
      status: "verified",
      patientId: candidate.patientId,
      name: candidateDisplayName(candidate),
      dob: candidate.dob ?? null,
      phone: preCall.callerPhone || state.runtime.callerPhone,
      appointments: candidate.appointments,
      appointmentsStatus: candidate.appointmentsStatus ?? null,
      insuranceCarrier: candidate.insuranceCarrier ?? null,
      insPlanId: candidate.insPlanId ?? null,
      respPartyId: candidate.respPartyId ?? null,
      routing: candidate.routing ?? null,
      allowedProviders: candidate.allowedProviders ?? [],
      routingAmbiguous: candidate.routingAmbiguous ?? false,
      preauthRequired: candidate.preauthRequired ?? false,
    },
    "synchronous",
  );
}

function activateResolvedPatient(
  state: CallState,
  result: PatientResolveVerified,
): boolean {
  return activatePatient(
    state,
    {
      status: "verified",
      patientId: result.patientId,
      name: result.name,
      dob: result.dob,
      phone: result.phone,
      insuranceCarrier: result.insuranceCarrier,
      insPlanId: result.insPlanId,
      respPartyId: result.respPartyId,
      routing: result.routing,
      allowedProviders: result.allowedProviders,
      routingAmbiguous: result.routingAmbiguous,
      preauthRequired: result.preauthRequired,
      appointmentsStatus: result.appointmentsStatus,
      appointments: normalizeCallerAppointments(
        result.appointments,
        result.patientId,
      ),
    },
    "operation",
  );
}

function beginNewPatientRegistration(
  state: CallState,
  identity: ResolvePatientIdentityInput,
  options: { preserveEligibilityCheck: boolean },
): void {
  invalidatePatientIdentityOperations(state);
  resetPatientScopedWork(state, options);
  setInsuranceOnFile(state, null);
  setPatientBackendRefs(state, {
    insPlanId: null,
    respPartyId: null,
  });
  state.identity.patient = {
    ...state.identity.patient,
    status: "new",
    identityConfirmed: false,
    patientId: null,
    name: null,
    dob: null,
    phone: null,
    appointments: [],
    appointmentsStatus: null,
  };
  state.identity.pendingRegistration = pendingRegistrationIdentity(identity);
}

export function setPendingRegistrationIdentity(
  state: CallState,
  identity: PatientLookupIdentity,
): void {
  if (state.identity.patient.status !== "new") return;
  state.identity.pendingRegistration = pendingRegistrationIdentity(identity);
}

export function beginPatientIdentityOperation(state: CallState): number {
  state.identity.operationVersion += 1;
  return state.identity.operationVersion;
}

export function patientIdentityOperationIsCurrent(
  state: CallState,
  operationVersion: number,
): boolean {
  return state.identity.operationVersion === operationVersion;
}

export function currentPatientIdentityTransitionVersion(
  state: CallState,
): number {
  return state.identity.transitionVersion;
}

export function patientIdentityTransitionIsCurrent(
  state: CallState,
  transitionVersion: number,
): boolean {
  return state.identity.transitionVersion === transitionVersion;
}

function invalidatePatientIdentityOperations(state: CallState): void {
  advancePatientIdentityTransition(state, "synchronous");
}

function advancePatientIdentityTransition(
  state: CallState,
  source: "operation" | "synchronous",
): void {
  if (source === "synchronous") state.identity.operationVersion += 1;
  state.identity.transitionVersion += 1;
}

function resetPatientScopedWork(
  state: CallState,
  options: { preserveEligibilityCheck?: boolean } = {},
): void {
  resetPatientSchedulingState(state, options);
  delete state.identity.latestBookedAppointmentId;
  resetActiveOfficeToTrunk(state);
}

function pendingRegistrationTargetsDifferentPatient(
  state: CallState,
  identity: ResolvePatientIdentityInput,
): boolean {
  const pending = state.identity.pendingRegistration;
  if (!pending) return false;
  return Boolean(
    (pending.firstName &&
      identity.firstName &&
      !namesMatch(pending.firstName, identity.firstName)) ||
    (pending.lastName &&
      identity.lastName &&
      !namesMatch(pending.lastName, identity.lastName)) ||
    (pending.dob && identity.dob && !dobMatches(pending.dob, identity.dob)),
  );
}

function mergePendingRegistrationIdentity(
  state: CallState,
  identity: ResolvePatientIdentityInput,
): void {
  state.identity.pendingRegistration = {
    ...state.identity.pendingRegistration,
    ...pendingRegistrationIdentity(identity),
  };
}

function pendingRegistrationIdentity(
  identity: Partial<PatientLookupIdentity>,
): PendingPatientRegistrationIdentity {
  return {
    ...(identity.firstName ? { firstName: identity.firstName } : {}),
    ...(identity.lastName ? { lastName: identity.lastName } : {}),
    ...(identity.dob ? { dob: identity.dob } : {}),
  };
}

function snapshotActivePatientIdentity(
  state: CallState,
): PatientIdentitySnapshot {
  return {
    patientId: state.identity.patient.patientId,
    name: state.identity.patient.name,
    dob: state.identity.patient.dob,
  };
}

function identityDiffers(
  previous: PatientIdentitySnapshot,
  next: Pick<ActivePatientInput, "patientId" | "name" | "dob">,
): boolean {
  if (sameKnownIdentityValue(previous.patientId, next.patientId)) return false;
  return (
    changedKnownIdentityValue(previous.patientId, next.patientId) ||
    changedKnownIdentityValue(previous.name, next.name) ||
    changedKnownIdentityValue(previous.dob, next.dob)
  );
}

function changedKnownIdentityValue(
  previous: string | null | undefined,
  next: string | null | undefined,
): boolean {
  const normalizedPrevious = normalizeIdentityValue(previous);
  const normalizedNext = normalizeIdentityValue(next);
  return Boolean(
    normalizedPrevious &&
    normalizedNext &&
    normalizedPrevious !== normalizedNext,
  );
}

function sameKnownIdentityValue(
  previous: string | null | undefined,
  next: string | null | undefined,
): boolean {
  const normalizedPrevious = normalizeIdentityValue(previous);
  const normalizedNext = normalizeIdentityValue(next);
  return Boolean(
    normalizedPrevious &&
    normalizedNext &&
    normalizedPrevious === normalizedNext,
  );
}

function normalizeIdentityValue(value: string | null | undefined): string {
  return value?.trim().toLowerCase().replace(/\s+/g, " ") ?? "";
}

async function resolveFromPreCallState(
  state: CallState,
  identity: ResolvePatientIdentityInput,
  lookup: PatientResolveLookup,
): Promise<IdentityResolution | null> {
  const preCall = state.identity.preCall;
  if (state.identity.patient.status === "new") return null;
  if (!preCall || preCall.candidates.length === 0 || !identity.firstName) {
    return null;
  }

  if (hasFullIdentity(identity)) {
    const fullMatch = findFullIdentityPreCallMatch(preCall, identity);
    if (!fullMatch) return null;
    return resolveSelectedPreCallMatch(state, fullMatch, lookup);
  }

  const match = matchCandidatesByFirstName(
    identity.firstName,
    preCall.candidates.filter((candidate) => candidate.patientId),
    (candidate) => candidate.firstName,
  );
  if (match.status === "no_match") return null;
  if (match.status === "ambiguous") {
    return {
      outcome: "multiple_matches",
      reply:
        "More than one preloaded patient matched that first name. Ask for the patient's date of birth, then call resolve_patient with first name, last name, and DOB.",
    };
  }
  return resolveSelectedPreCallMatch(state, match.candidate, lookup);
}

async function resolveSelectedPreCallMatch(
  state: CallState,
  candidate: PreCallCandidate,
  lookup: PatientResolveLookup,
): Promise<IdentityResolution | null> {
  return candidate.status === "candidate"
    ? hydratePreCallCandidate(state, candidate, lookup, "resolve_patient")
    : activatePreCallMatch(state, candidate);
}

async function hydratePreCallCandidate(
  state: CallState,
  candidate: Extract<PreCallCandidate, { status: "candidate" }>,
  lookup: PatientResolveLookup,
  source: "caller_transcript" | "resolve_patient",
): Promise<IdentityResolution> {
  let pendingForCall = pendingCandidateHydrations.get(state);
  if (!pendingForCall) {
    pendingForCall = new Map();
    pendingCandidateHydrations.set(state, pendingForCall);
  }

  const existing = pendingForCall.get(candidate.patientId);
  if (existing) return existing;

  const hydration = performCandidateHydration(state, candidate, lookup, source);
  pendingForCall.set(candidate.patientId, hydration);
  const clearPending = () => {
    if (pendingForCall?.get(candidate.patientId) === hydration) {
      pendingForCall.delete(candidate.patientId);
    }
  };
  void hydration.then(clearPending, clearPending);
  return hydration;
}

async function performCandidateHydration(
  state: CallState,
  candidate: Extract<PreCallCandidate, { status: "candidate" }>,
  lookup: PatientResolveLookup,
  source: "caller_transcript" | "resolve_patient",
): Promise<IdentityResolution> {
  const preCall = state.identity.preCall;
  if (!preCall) {
    return {
      outcome: "lookup_failed",
      reply: "Patient lookup failed. Try again.",
    };
  }

  preCall.selectedCandidateRef = candidate.ref;
  const activePatientId = state.identity.patient.patientId?.trim() || null;
  const wasConfirmedActive =
    state.identity.patient.identityConfirmed &&
    activePatientId === candidate.patientId;
  if (
    wasConfirmedActive &&
    state.identity.patient.appointmentsStatus !== "error"
  ) {
    const activePatientName =
      state.identity.patient.name?.trim() || candidateDisplayName(candidate);
    return {
      outcome: "verified",
      reply: `${activePatientName} is already the active patient. Continue with loaded patient state.`,
    };
  }
  const hadDifferentActivePatient =
    state.identity.patient.identityConfirmed &&
    activePatientId !== candidate.patientId;
  const operationVersion = beginPatientIdentityOperation(state);
  const officePhone = getOfficeProfileByPhone(
    state.runtime.trunkPhone,
  ).amdOfficePhone;
  const result = await lookup(officePhone, { patientId: candidate.patientId });
  if (!patientIdentityOperationIsCurrent(state, operationVersion)) {
    return {
      outcome: "lookup_failed",
      reply:
        "Patient lookup was superseded by a newer identity change. Continue with the current patient's state.",
    };
  }

  if (
    result.status !== "verified" ||
    !completeVerifiedIdentity(result) ||
    result.patientId !== candidate.patientId
  ) {
    if (result.status === "error") {
      recordOwnedMiddlewareFailure(state, "resolvePatient", result);
    }
    state.runtime.preCallLookup.hydrationOutcome =
      result.status === "verified"
        ? "incomplete"
        : result.status === "not_found"
          ? "not_found"
          : result.status === "multiple_matches"
            ? "multiple_matches"
            : "lookup_failed";
    return {
      outcome:
        result.status === "not_found"
          ? "not_found"
          : result.status === "multiple_matches"
            ? "multiple_matches"
            : "lookup_failed",
      reply:
        result.status === "verified"
          ? "Patient lookup returned an incomplete identity. Try again."
          : patientLookupReply(result),
    };
  }

  preCall.status =
    preCall.status === "single_match_pending_confirmation"
      ? "single_match_confirmed"
      : "multiple_match_confirmed";
  preCall.identityPromotion =
    source === "caller_transcript"
      ? "confirmed_by_transcript"
      : hadDifferentActivePatient
        ? "switched_by_identity_tool"
        : "confirmed_by_identity_tool";
  state.runtime.preCallLookup.hydrationOutcome = "verified";
  activateResolvedPatient(state, result);
  return hadDifferentActivePatient
    ? {
        outcome: "switched",
        reply: `Switched active patient to ${result.name?.trim() || "the selected patient"}. Check availability again before booking.`,
      }
    : {
        outcome: "verified",
        reply: confirmedPatientReply(state),
      };
}

function activatePreCallMatch(
  state: CallState,
  candidate: PreCallVerifiedPatientCandidate,
): IdentityResolution | null {
  const activePatientId = state.identity.patient.patientId?.trim() || null;
  const wasConfirmedActive =
    state.identity.patient.identityConfirmed &&
    Boolean(activePatientId) &&
    activePatientId === candidate.patientId;
  const hadDifferentActivePatient =
    state.identity.patient.identityConfirmed && !wasConfirmedActive;

  if (wasConfirmedActive) {
    if (state.identity.patient.appointmentsStatus === "error") return null;
    return {
      outcome: "verified",
      reply: `${candidateDisplayName(candidate)} is already the active patient. Continue with loaded patient state.`,
    };
  }

  activatePreloadedCandidate(
    state,
    candidate,
    hadDifferentActivePatient
      ? "switched_by_identity_tool"
      : "confirmed_by_identity_tool",
  );
  if (hadDifferentActivePatient) {
    return {
      outcome: "switched",
      reply: `Switched active patient to ${candidateDisplayName(candidate)}. Check availability again before booking.`,
    };
  }
  return {
    outcome: "verified",
    reply: confirmedPatientReply(state),
  };
}

function selectedPreCallCandidate(
  preCall: PreCallContextState,
): PreCallCandidate | null {
  return (
    candidateByRef(preCall, preCall.selectedCandidateRef) ??
    candidateByRef(preCall, CALLER_CANDIDATE_REF) ??
    (preCall.candidates.length === 1 ? preCall.candidates[0] : null)
  );
}

function candidateByRef(
  preCall: PreCallContextState,
  ref: string | undefined,
): PreCallCandidate | null {
  if (!ref) return null;
  return preCall.candidates.find((candidate) => candidate.ref === ref) ?? null;
}

function findFullIdentityPreCallMatch(
  preCall: PreCallContextState,
  identity: PatientLookupIdentity,
): PreCallCandidate | null {
  const matches = preCall.candidates.filter(
    (candidate) =>
      Boolean(candidate.patientId) &&
      namesMatch(identity.firstName, candidate.firstName) &&
      namesMatch(identity.lastName, candidate.lastName) &&
      dobMatches(identity.dob, candidate.dob),
  );
  return matches.length === 1 ? matches[0] : null;
}

function candidateDisplayName(candidate: PreCallCandidate): string {
  return [candidate.firstName, candidate.lastName].filter(Boolean).join(" ");
}

function singlePreCallCandidateSelection(
  preCall: PreCallContextState,
  transcript: string,
): {
  candidate: PreCallCandidate;
  otherMentionedCandidates: PreCallCandidate[];
} | null {
  const candidate =
    selectedPreCallCandidate(preCall) ??
    candidateByRef(preCall, CALLER_CANDIDATE_REF);
  if (!candidate) return null;
  const match = matchCandidatesByFirstName(
    transcript,
    [candidate],
    (item) => item.firstName,
    transcriptMatchOptions,
  );
  return match.status === "unique"
    ? { candidate: match.candidate, otherMentionedCandidates: [] }
    : null;
}

function multiplePreCallCandidateSelection(
  preCall: PreCallContextState,
  transcript: string,
): {
  candidate: PreCallCandidate;
  otherMentionedCandidates: PreCallCandidate[];
} | null {
  if (preCall.status !== "multiple_matches_pending_selection") return null;
  const match = matchCandidatesByFirstName(
    transcript,
    preCall.candidates.filter((candidate) => candidate.patientId),
    (candidate) => candidate.firstName,
    transcriptMatchOptions,
  );
  if (match.status !== "unique") return null;
  return {
    candidate: match.candidate,
    otherMentionedCandidates: match.otherCandidates,
  };
}

const transcriptMatchOptions = {
  allowEditDistance: true,
  includeFullInput: false,
};

function isFirstNamePrompt(text: string | null | undefined): boolean {
  const normalized = text?.toLowerCase() ?? "";
  if (!normalized) return false;
  if (
    normalized.includes("last name") ||
    normalized.includes("date of birth") ||
    normalized.includes("dob")
  ) {
    return false;
  }
  return (
    normalized.includes("first name") ||
    (normalized.includes("who") && normalized.includes("for"))
  );
}

function confirmedPatientSystemMessage(
  state: CallState,
  otherMentionedCandidates: PreCallCandidate[],
): string {
  const patientName = state.identity.patient.name?.trim() || "the patient";
  return [
    "Internal state: patient identity is confirmed from a pre-call phone candidate after the caller provided the patient's first name.",
    `Patient: ${patientName}.`,
    otherMentionedPatientsSystemMessage(patientName, otherMentionedCandidates),
    appointmentSummary(state),
    "Do not ask for last name or date of birth again. Continue using the loaded patient state for appointment questions, booking, or cancellation.",
  ]
    .filter(Boolean)
    .join(" ");
}

function otherMentionedPatientsSystemMessage(
  activePatientName: string,
  candidates: PreCallCandidate[],
): string {
  const names = [
    ...new Set(candidates.map(candidateDisplayName).filter(Boolean)),
  ];
  if (names.length === 0) return "";
  return [
    `Caller also mentioned preloaded patient${names.length === 1 ? "" : "s"}: ${names.join(", ")}.`,
    `Finish ${activePatientName} first.`,
    "Before working on another mentioned patient, call resolve_patient with that patient's first name to switch the active patient.",
  ].join(" ");
}

function preCallNameMismatchReply(
  state: CallState,
  identity: PatientLookupIdentity,
): string | null {
  const preCall = state.identity.preCall;
  if (preCall?.status !== "single_match_pending_confirmation") return null;
  if (
    !preCall.candidates.some((candidate) =>
      preCallCandidateMatchesIdentity(candidate, identity),
    )
  ) {
    return null;
  }
  return "I found a record with that last name and date of birth, but the first name does not match what I heard. Could you spell the patient's first name?";
}

function activePatientBlocksNewChartReply(
  state: CallState,
  identity: ResolvePatientIdentityInput,
): string | null {
  if (!state.identity.patient.identityConfirmed) return null;
  if (identityTargetsDifferentPatient(state, identity)) return null;
  const patientName =
    state.identity.patient.name?.trim() || "the active patient";
  return `${patientName} is already loaded as an existing patient. Continue with the loaded patient state instead of creating a new chart.`;
}

function identityTargetsDifferentPatient(
  state: CallState,
  identity: ResolvePatientIdentityInput,
): boolean {
  const activeDob = state.identity.patient.dob;
  if (identity.dob && activeDob && !dobMatches(identity.dob, activeDob)) {
    return true;
  }

  const activeName = activePatientNameParts(state.identity.patient.name);
  if (!activeName) return false;
  if (
    identity.firstName &&
    !activeName.firstNames.some((name) => namesMatch(identity.firstName, name))
  ) {
    return true;
  }
  if (
    identity.lastName &&
    !activeName.lastNames.some((name) => namesMatch(identity.lastName, name))
  ) {
    return true;
  }
  return false;
}

function activePatientNameParts(
  name: string | null | undefined,
): { firstNames: string[]; lastNames: string[] } | null {
  const trimmed = name?.trim();
  if (!trimmed) return null;

  const [commaLastName, commaFirstAndMiddle] = trimmed
    .split(",", 2)
    .map((part) => part.trim())
    .filter(Boolean);
  if (commaLastName && commaFirstAndMiddle) {
    const firstParts = commaFirstAndMiddle.match(/[A-Za-z]+/g) ?? [];
    const lastParts = commaLastName.match(/[A-Za-z]+/g) ?? [];
    return {
      firstNames: uniqueNameParts([firstParts[0], firstParts.join(" ")]),
      lastNames: uniqueNameParts([
        commaLastName,
        lastParts[lastParts.length - 1],
      ]),
    };
  }

  const parts = trimmed.match(/[A-Za-z]+/g) ?? [];
  if (parts.length === 0) return null;
  return {
    firstNames: uniqueNameParts([
      parts[0],
      parts.length > 1 ? parts.slice(0, -1).join(" ") : parts[0],
    ]),
    lastNames: uniqueNameParts([
      parts[parts.length - 1],
      parts.length > 1 ? parts.slice(1).join(" ") : parts[0],
    ]),
  };
}

function uniqueNameParts(parts: Array<string | undefined>): string[] {
  return parts.filter(
    (part, index): part is string =>
      Boolean(part?.trim()) && parts.indexOf(part) === index,
  );
}

function missingIdentityReply(
  state: CallState,
  identity: ResolvePatientIdentityInput,
): string {
  if (identity.registrationStatus === "unsure") {
    return "Collect the patient's first name, last name, and date of birth so I can check for an existing record.";
  }
  if (identity.firstName) {
    return "Collect the patient's last name and date of birth, then call resolve_patient again.";
  }
  if (state.identity.preCall?.status === "no_match") {
    return "Collect the patient's first name, last name, and date of birth to check for an existing record. If the caller already said the patient is not registered with us, call resolve_patient with registrationStatus not_registered.";
  }
  return "Ask who the appointment is for. If the patient is not preloaded from the phone lookup, collect first name, last name, and date of birth.";
}

function normalizeResolvePatientInput(
  input: ResolvePatientIdentityInput,
): ResolvePatientIdentityInput {
  return {
    firstName: input.firstName?.trim() || undefined,
    lastName: input.lastName?.trim() || undefined,
    dob: input.dob?.trim() || undefined,
    registrationStatus: input.registrationStatus,
  };
}

function hasFullIdentity(
  identity: ResolvePatientIdentityInput,
): identity is PatientLookupIdentity {
  return Boolean(identity.firstName && identity.lastName && identity.dob);
}

function completeVerifiedIdentity(result: PatientResolveVerified): boolean {
  return Boolean(
    result.patientId.trim() && result.name?.trim() && result.dob?.trim(),
  );
}

function confirmedPatientReply(state: CallState): string {
  const patientName = state.identity.patient.name?.trim() || "the patient";
  const insurance = insuranceOnFile(state);
  const prefix = verifiedExistingPatientPrefix(
    patientName,
    insurance?.currentCarrier ?? insurance?.canonicalPlan ?? insurance?.plan,
  );
  return appointmentReply(
    prefix,
    state.identity.patient.appointmentsStatus ?? null,
    state.identity.patient.appointments,
  );
}

function verifiedExistingPatientPrefix(
  patientName: string,
  insuranceCarrier: string | null | undefined,
): string {
  const insurance = insuranceCarrier?.trim();
  return `Verified existing patient ${patientName}. ${
    insurance
      ? `Insurance on file: ${insurance}.`
      : "No insurance is currently on file."
  }`;
}

function appointmentReply(
  prefix: string,
  status: AppointmentLoadStatus | null,
  appointments: CallerAppointment[],
): string {
  if (status === "found" && appointments.length > 0) {
    return `${prefix} Loaded ${appointments.length} appointment${appointments.length === 1 ? "" : "s"}: ${renderAppointments(appointments)}.`;
  }
  if (status === "none") {
    return `${prefix} No upcoming appointments are loaded.`;
  }
  if (status === "error") {
    return `${prefix} Appointments could not be loaded. Try confirming identity again before confirming or cancelling.`;
  }
  return `${prefix} Patient record is loaded.`;
}

function appointmentSummary(state: CallState): string {
  const status = state.identity.patient.appointmentsStatus;
  const appointments = state.identity.patient.appointments;
  if (status === "found" && appointments.length > 0) {
    return `Upcoming appointments loaded: ${renderAppointments(appointments)}.`;
  }
  if (status === "none") {
    return "Appointments status: none. No upcoming appointments are loaded.";
  }
  if (status === "error") {
    return "Appointments status: error. Appointments could not be loaded.";
  }
  return "Patient record is loaded.";
}

function renderAppointments(appointments: CallerAppointment[]): string {
  return appointments.map(spokenAppointment).join("; ");
}

function patientLookupReply(result: PatientResolveResult): string {
  if (result.status === "not_found") {
    return "No matching patient was found. Confirm the spelling and date of birth, or ask whether the patient is already registered with us.";
  }
  if (result.status === "multiple_matches") {
    return "Multiple matching patients were found. Confirm the spelling and date of birth, then try again.";
  }
  return "Patient lookup failed. Try again.";
}

export function incompletePatientRegistrationMessage(
  state: CallState,
): string | null {
  return state.identity.patient.status === "created" && !state.insurance.onFile
    ? "The patient chart exists, but insurance is not attached. Connect the caller to office staff to finish registration before scheduling."
    : null;
}

function spokenAppointment(appointment: {
  appointmentRef?: string;
  date: string;
  time?: string | null;
  provider?: string | null;
}): string {
  const spoken = [
    appointment.date,
    appointment.time ? `at ${appointment.time}` : "",
    appointment.provider ? `with ${appointment.provider}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return appointment.appointmentRef
    ? `${spoken} (appointmentRef ${appointment.appointmentRef})`
    : spoken;
}
