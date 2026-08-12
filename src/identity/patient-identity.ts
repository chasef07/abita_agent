import type {
  CreatePatientResult,
  MiddlewareFailure,
  PatientResolveResult,
  PatientResolveVerified,
} from "../clients/owned-middleware.js";
import { getOfficeProfileByPhone } from "../customers/abita/profile.js";
import { normalizeCallerAppointments } from "../state/appointments.js";
import {
  activePatientName,
  type ActivePatient,
  type AppointmentLoadStatus,
  type CallState,
  type CallerAppointment,
  type PatientIdentityOutcome,
  type PreCallPatientCandidate,
  recordPatientIdentityOutcome,
  recordPatientIdentityTransition,
  type RegistrationDraft,
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
import { spokenAppointmentDate } from "../scheduling/spoken-date.js";
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

export type ResolvePatientIdentityInput = Partial<PatientLookupIdentity>;

export type PatientIdentityResolution = {
  outcome: PatientIdentityOutcome | "superseded";
  reply: string;
  failure?: MiddlewareFailure;
};

export type PatientActivation = ActivePatient & {
  insuranceCarrier: string | null;
  routing: string | null;
  allowedProviders: string[];
  routingAmbiguous: boolean;
  preauthRequired: boolean;
};

type SuccessfulPatientCreationReceipt = Extract<
  CreatePatientResult,
  { status: "created" | "partial" }
>;

const pendingCandidateHydrations = new WeakMap<
  CallState,
  Map<string, Promise<PatientIdentityResolution>>
>();

export async function confirmCandidateFromTranscript(
  state: CallState,
  transcript: string,
  lookup: PatientResolveLookup,
): Promise<"activated" | "ambiguous" | "unmatched"> {
  if (state.identity.activePatient || state.identity.registration) {
    return "unmatched";
  }

  const match = matchCandidatesByFirstName(
    transcript,
    state.identity.privateCandidates,
    (candidate) => candidate.firstName,
    { allowEditDistance: true, includeFullInput: false },
  );
  if (match.status === "no_match") return "unmatched";
  if (match.status === "ambiguous") return "ambiguous";

  const resolution = await activateCandidate(
    state,
    match.candidate,
    lookup,
    "caller_transcript",
  );
  return resolution.outcome === "verified" ? "activated" : "unmatched";
}

export async function resolveExistingPatient(
  state: CallState,
  input: ResolvePatientIdentityInput,
  lookup: PatientResolveLookup,
): Promise<PatientIdentityResolution> {
  const identity = normalizeIdentity(input);
  const preloaded = await resolvePrivateCandidate(state, identity, lookup);
  if (preloaded) return recordResolutionOutcome(state, preloaded);

  if (!hasFullIdentity(identity)) {
    return recordResolutionOutcome(state, {
      outcome: "needs_identity",
      reply: identity.firstName
        ? "Collect the patient's last name and date of birth, then call resolve_patient again."
        : "Collect the patient's first name, last name, and date of birth, then call resolve_patient.",
    });
  }

  const active = state.identity.activePatient;
  if (
    active &&
    !identityTargetsDifferentPatient(active, identity) &&
    active.appointmentsStatus !== "error"
  ) {
    return recordResolutionOutcome(state, {
      outcome: "verified",
      reply: `${active.name?.trim() || "The active patient"} is already the active patient. Continue with loaded patient state.`,
    });
  }

  const hadActivePatient = active !== null;
  const targetsDifferentPatient = active
    ? identityTargetsDifferentPatient(active, identity)
    : false;
  const officePhone = targetsDifferentPatient
    ? getOfficeProfileByPhone(state.runtime.trunkPhone).amdOfficePhone
    : getAmdOfficeForToolCall(state);
  const operationVersion = beginPatientIdentityOperation(state);
  const result = await lookup(officePhone, identity);
  if (!patientIdentityOperationIsCurrent(state, operationVersion)) {
    return {
      outcome: "superseded",
      reply:
        "Patient lookup was superseded by a newer identity change. Continue with the current patient situation.",
    };
  }

  if (result.status === "verified") {
    if (!completeVerifiedIdentity(result)) {
      return recordResolutionOutcome(state, {
        outcome: "lookup_failed",
        reply: "Patient lookup returned an incomplete identity. Try again.",
        failure: { status: "error", reason: "invalid_response" },
      });
    }
    const changed = promotePatient(
      state,
      activationFromResolvedPatient(result, "existing"),
      "resolve_patient",
      "operation",
    );
    return recordResolutionOutcome(state, {
      outcome: hadActivePatient && changed ? "switched" : "verified",
      reply:
        hadActivePatient && changed
          ? switchedPatientReply(state)
          : confirmedPatientReply(state),
    });
  }

  if (result.status === "error") {
    recordOwnedMiddlewareFailure(state, "resolvePatient", result);
  }
  return recordResolutionOutcome(state, {
    outcome:
      result.status === "not_found"
        ? "not_found"
        : result.status === "multiple_matches"
          ? "multiple_matches"
          : "lookup_failed",
    reply: patientLookupReply(result),
    ...(result.status === "error" ? { failure: result } : {}),
  });
}

export function beginNewPatientRegistration(
  state: CallState,
  identity: ResolvePatientIdentityInput,
): void {
  const draft = registrationDraft(identity);
  if (
    state.identity.registration &&
    !registrationTargetsDifferentPatient(state.identity.registration, draft)
  ) {
    state.identity.registration = {
      ...state.identity.registration,
      ...draft,
    };
    return;
  }

  const replacingRegistration = state.identity.registration !== null;
  advanceTransition(state, "synchronous");
  resetPatientScopedWork(state, {
    preserveEligibilityCheck: !replacingRegistration,
  });
  setInsuranceOnFile(state, null);
  state.identity.activePatient = null;
  state.identity.registration = draft;
  recordPatientIdentityTransition(state, {
    outcome: "new",
    source: "create_patient",
  });
}

export function activatePatientFromReceipt(
  state: CallState,
  receipt: SuccessfulPatientCreationReceipt,
): boolean {
  if (receipt.status !== "created" && receipt.status !== "partial")
    return false;
  const patientId = receipt.patientId?.trim();
  if (!patientId) return false;
  const appointments = extractAppointments(receipt);
  promotePatient(
    state,
    {
      kind: "created",
      patientId,
      name: receipt.name ?? null,
      dob: receipt.dob ?? null,
      phone: receipt.phone ?? null,
      appointments: normalizeCallerAppointments(appointments, patientId),
      appointmentsStatus: appointmentStatusFromResult(receipt, appointments),
      backend: {
        insPlanId: receipt.insPlanId ?? null,
        respPartyId: receipt.respPartyId ?? null,
      },
      insuranceCarrier: receipt.insuranceCarrier ?? null,
      routing: receipt.routing ?? null,
      allowedProviders: receipt.allowedProviders ?? [],
      routingAmbiguous: receipt.routingAmbiguous ?? false,
      preauthRequired: receipt.preauthRequired ?? false,
    },
    "create_patient",
    "operation",
  );
  return true;
}

export function patientRegistrationConflict(
  state: CallState,
  identity: PatientLookupIdentity,
): "created_patient" | "active_patient" | "pre_call_candidate" | null {
  const active = state.identity.activePatient;
  if (active && !identityTargetsDifferentPatient(active, identity)) {
    return active.kind === "created" ? "created_patient" : "active_patient";
  }
  return state.identity.privateCandidates.some((candidate) =>
    candidateMatchesIdentity(candidate, identity),
  )
    ? "pre_call_candidate"
    : null;
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

export function patientModelProjection(state: CallState): string {
  const patient = state.identity.activePatient;
  if (!patient) {
    return state.identity.registration
      ? "Patient situation: new-patient registration is in progress; no patient chart is active."
      : "Patient situation: no patient is active.";
  }

  return [
    `Patient situation: ${patient.name?.trim() || "the patient"} is the active ${patient.kind === "created" ? "new" : "existing"} patient.`,
    knownInsuranceOnFileSummary(state),
    appointmentProjection(patient.appointmentsStatus, patient.appointments),
  ]
    .filter(Boolean)
    .join(" ");
}

export function incompletePatientRegistrationMessage(
  state: CallState,
): string | null {
  return state.identity.activePatient?.kind === "created" &&
    !state.insurance.onFile
    ? "The patient chart exists, but insurance is not attached. Connect the caller to office staff to finish registration before scheduling."
    : null;
}

export function activatePatient(
  state: CallState,
  patient: PatientActivation,
  source: "caller_transcript" | "resolve_patient" | "create_patient",
): boolean {
  return promotePatient(state, patient, source, "synchronous");
}

function promotePatient(
  state: CallState,
  patient: PatientActivation,
  source: "caller_transcript" | "resolve_patient" | "create_patient",
  transition: "operation" | "synchronous",
): boolean {
  const previous = state.identity.activePatient;
  const changed = !samePatient(previous, patient);
  advanceTransition(state, transition);
  if (changed) resetPatientScopedWork(state);
  state.identity.activePatient = {
    kind: patient.kind,
    patientId: patient.patientId,
    name: patient.name,
    dob: patient.dob,
    phone: patient.phone,
    appointments: normalizeCallerAppointments(
      patient.appointments,
      patient.patientId,
    ),
    appointmentsStatus: patient.appointmentsStatus,
    backend: { ...patient.backend },
  };
  state.identity.registration = null;
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
  recordPatientIdentityTransition(state, { outcome: "confirmed", source });
  return changed;
}

async function resolvePrivateCandidate(
  state: CallState,
  identity: ResolvePatientIdentityInput,
  lookup: PatientResolveLookup,
): Promise<PatientIdentityResolution | null> {
  if (!identity.firstName || state.identity.privateCandidates.length === 0) {
    return null;
  }

  const candidate = hasFullIdentity(identity)
    ? uniqueFullIdentityCandidate(state.identity.privateCandidates, identity)
    : uniqueFirstNameCandidate(
        state.identity.privateCandidates,
        identity.firstName,
      );
  if (candidate === "ambiguous") {
    return {
      outcome: "multiple_matches",
      reply:
        "More than one preloaded patient matched that first name. Collect the patient's full name and date of birth, then call resolve_patient again.",
    };
  }
  if (!candidate) return null;
  return activateCandidate(state, candidate, lookup, "resolve_patient");
}

function uniqueFirstNameCandidate(
  candidates: PreCallPatientCandidate[],
  firstName: string,
): PreCallPatientCandidate | "ambiguous" | null {
  const match = matchCandidatesByFirstName(
    firstName,
    candidates,
    (candidate) => candidate.firstName,
    { allowEditDistance: false },
  );
  if (match.status === "ambiguous") return "ambiguous";
  return match.status === "unique" ? match.candidate : null;
}

function uniqueFullIdentityCandidate(
  candidates: PreCallPatientCandidate[],
  identity: PatientLookupIdentity,
): PreCallPatientCandidate | null {
  const matches = candidates.filter((candidate) =>
    candidateMatchesIdentity(candidate, identity),
  );
  return matches.length === 1 ? matches[0] : null;
}

async function activateCandidate(
  state: CallState,
  candidate: PreCallPatientCandidate,
  lookup: PatientResolveLookup,
  source: "caller_transcript" | "resolve_patient",
): Promise<PatientIdentityResolution> {
  if (candidate.status === "verified") {
    if (
      samePatient(
        state.identity.activePatient,
        activationFromCandidate(candidate),
      )
    ) {
      return {
        outcome: "verified",
        reply: `${state.identity.activePatient?.name?.trim() || "The active patient"} is already the active patient. Continue with loaded patient state.`,
      };
    }
    const hadActivePatient = state.identity.activePatient !== null;
    const changed = promotePatient(
      state,
      activationFromCandidate(candidate),
      source,
      "synchronous",
    );
    return {
      outcome: hadActivePatient && changed ? "switched" : "verified",
      reply:
        hadActivePatient && changed
          ? switchedPatientReply(state)
          : confirmedPatientReply(state),
    };
  }
  return hydrateCandidate(state, candidate, lookup, source);
}

async function hydrateCandidate(
  state: CallState,
  candidate: Extract<PreCallPatientCandidate, { status: "candidate" }>,
  lookup: PatientResolveLookup,
  source: "caller_transcript" | "resolve_patient",
): Promise<PatientIdentityResolution> {
  let pending = pendingCandidateHydrations.get(state);
  if (!pending) {
    pending = new Map();
    pendingCandidateHydrations.set(state, pending);
  }
  const existing = pending.get(candidate.patientId);
  if (existing) return existing;

  const hydration = performCandidateHydration(state, candidate, lookup, source);
  pending.set(candidate.patientId, hydration);
  void hydration.finally(() => {
    if (pending?.get(candidate.patientId) === hydration) {
      pending.delete(candidate.patientId);
    }
  });
  return hydration;
}

async function performCandidateHydration(
  state: CallState,
  candidate: Extract<PreCallPatientCandidate, { status: "candidate" }>,
  lookup: PatientResolveLookup,
  source: "caller_transcript" | "resolve_patient",
): Promise<PatientIdentityResolution> {
  const operationVersion = beginPatientIdentityOperation(state);
  const result = await lookup(
    getOfficeProfileByPhone(state.runtime.trunkPhone).amdOfficePhone,
    { patientId: candidate.patientId },
  );
  if (!patientIdentityOperationIsCurrent(state, operationVersion)) {
    return {
      outcome: "superseded",
      reply:
        "Patient lookup was superseded by a newer identity change. Continue with the current patient situation.",
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
      ...(result.status === "error" ? { failure: result } : {}),
    };
  }

  const hadActivePatient = state.identity.activePatient !== null;
  const changed = promotePatient(
    state,
    activationFromResolvedPatient(result, "existing"),
    source,
    "operation",
  );
  state.runtime.preCallLookup.hydrationOutcome = "verified";
  return {
    outcome: hadActivePatient && changed ? "switched" : "verified",
    reply:
      hadActivePatient && changed
        ? switchedPatientReply(state)
        : confirmedPatientReply(state),
  };
}

function activationFromCandidate(
  candidate: Extract<PreCallPatientCandidate, { status: "verified" }>,
): PatientActivation {
  return {
    kind: "existing",
    patientId: candidate.patientId,
    name: candidateDisplayName(candidate),
    dob: candidate.dob ?? null,
    phone: null,
    appointments: candidate.appointments,
    appointmentsStatus: candidate.appointmentsStatus ?? null,
    backend: {
      insPlanId: candidate.insPlanId ?? null,
      respPartyId: candidate.respPartyId ?? null,
    },
    insuranceCarrier: candidate.insuranceCarrier ?? null,
    routing: candidate.routing ?? null,
    allowedProviders: candidate.allowedProviders ?? [],
    routingAmbiguous: candidate.routingAmbiguous ?? false,
    preauthRequired: candidate.preauthRequired ?? false,
  };
}

function activationFromResolvedPatient(
  patient: PatientResolveVerified,
  kind: ActivePatient["kind"],
): PatientActivation {
  return {
    kind,
    patientId: patient.patientId,
    name: patient.name,
    dob: patient.dob,
    phone: patient.phone,
    appointments: normalizeCallerAppointments(
      patient.appointments,
      patient.patientId,
    ),
    appointmentsStatus: patient.appointmentsStatus,
    backend: {
      insPlanId: patient.insPlanId,
      respPartyId: patient.respPartyId,
    },
    insuranceCarrier: patient.insuranceCarrier,
    routing: patient.routing,
    allowedProviders: patient.allowedProviders,
    routingAmbiguous: patient.routingAmbiguous,
    preauthRequired: patient.preauthRequired,
  };
}

function recordResolutionOutcome(
  state: CallState,
  resolution: PatientIdentityResolution,
): PatientIdentityResolution {
  if (resolution.outcome === "superseded") return resolution;
  recordPatientIdentityOutcome(state, resolution.outcome);
  if (resolution.outcome !== "verified" && resolution.outcome !== "switched") {
    recordPatientIdentityTransition(state, {
      outcome: resolution.outcome,
      source: "resolve_patient",
    });
  }
  return resolution;
}

function advanceTransition(
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

function samePatient(
  previous: ActivePatient | null,
  next: PatientActivation,
): boolean {
  if (!previous) return false;
  return normalizeValue(previous.patientId) === normalizeValue(next.patientId);
}

function registrationTargetsDifferentPatient(
  current: RegistrationDraft,
  next: RegistrationDraft,
): boolean {
  return Boolean(
    (current.firstName &&
      next.firstName &&
      !namesMatch(current.firstName, next.firstName)) ||
    (current.lastName &&
      next.lastName &&
      !namesMatch(current.lastName, next.lastName)) ||
    (current.dob && next.dob && !dobMatches(current.dob, next.dob)),
  );
}

function registrationDraft(
  identity: ResolvePatientIdentityInput,
): RegistrationDraft {
  return {
    ...(identity.firstName?.trim()
      ? { firstName: identity.firstName.trim() }
      : {}),
    ...(identity.lastName?.trim()
      ? { lastName: identity.lastName.trim() }
      : {}),
    ...(identity.dob?.trim() ? { dob: identity.dob.trim() } : {}),
  };
}

function candidateMatchesIdentity(
  candidate: PreCallPatientCandidate,
  identity: PatientLookupIdentity,
): boolean {
  return (
    namesMatch(identity.firstName, candidate.firstName) &&
    namesMatch(identity.lastName, candidate.lastName) &&
    dobMatches(identity.dob, candidate.dob)
  );
}

function identityTargetsDifferentPatient(
  active: ActivePatient,
  identity: ResolvePatientIdentityInput,
): boolean {
  if (identity.dob && active.dob && !dobMatches(identity.dob, active.dob)) {
    return true;
  }
  const activeName = activePatientNameParts(active.name);
  if (!activeName) return false;
  return Boolean(
    (identity.firstName &&
      !activeName.firstNames.some((name) =>
        namesMatch(identity.firstName, name),
      )) ||
    (identity.lastName &&
      !activeName.lastNames.some((name) =>
        namesMatch(identity.lastName, name),
      )),
  );
}

function activePatientNameParts(
  name: string | null,
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
      parts[0]!,
      parts.length > 1 ? parts.slice(0, -1).join(" ") : parts[0]!,
    ]),
    lastNames: uniqueNameParts([
      parts[parts.length - 1]!,
      parts.length > 1 ? parts.slice(1).join(" ") : parts[0]!,
    ]),
  };
}

function uniqueNameParts(parts: Array<string | undefined>): string[] {
  return parts.filter(
    (part, index): part is string =>
      Boolean(part?.trim()) && parts.indexOf(part) === index,
  );
}

function normalizeIdentity(
  input: ResolvePatientIdentityInput,
): ResolvePatientIdentityInput {
  return {
    firstName: input.firstName?.trim() || undefined,
    lastName: input.lastName?.trim() || undefined,
    dob: input.dob?.trim() || undefined,
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

function candidateDisplayName(candidate: PreCallPatientCandidate): string {
  return [candidate.firstName, candidate.lastName].filter(Boolean).join(" ");
}

function normalizeValue(value: string | null | undefined): string {
  return value?.trim().toLowerCase().replace(/\s+/g, " ") ?? "";
}

function confirmedPatientReply(state: CallState): string {
  const patient = state.identity.activePatient;
  return appointmentReply(
    [
      `Verified existing patient ${activePatientName(state) ?? "the patient"}.`,
      knownInsuranceOnFileSummary(state),
    ]
      .filter(Boolean)
      .join(" "),
    patient?.appointmentsStatus ?? null,
    patient?.appointments ?? [],
  );
}

function switchedPatientReply(state: CallState): string {
  const patient = state.identity.activePatient;
  return `${appointmentReply(
    [
      `Switched active patient to ${activePatientName(state) ?? "the selected patient"}.`,
      knownInsuranceOnFileSummary(state),
    ]
      .filter(Boolean)
      .join(" "),
    patient?.appointmentsStatus ?? null,
    patient?.appointments ?? [],
  )} Check availability again before booking.`;
}

function knownInsuranceOnFileSummary(state: CallState): string {
  const insurance = insuranceOnFile(state);
  const carrier = (
    insurance?.currentCarrier ??
    insurance?.canonicalPlan ??
    insurance?.plan
  )?.trim();
  return carrier ? `Insurance on file: ${carrier}.` : "";
}

function appointmentReply(
  prefix: string,
  status: AppointmentLoadStatus | null,
  appointments: CallerAppointment[],
): string {
  if (status === "found" && appointments.length > 0) {
    return `${prefix} Loaded ${appointments.length} appointment${appointments.length === 1 ? "" : "s"}: ${appointments.map(spokenAppointment).join("; ")}.`;
  }
  if (status === "none")
    return `${prefix} No upcoming appointments are loaded.`;
  if (status === "error") {
    return `${prefix} Appointments could not be loaded. Try confirming identity again before confirming or cancelling.`;
  }
  return `${prefix} Patient record is loaded.`;
}

function appointmentProjection(
  status: AppointmentLoadStatus | null,
  appointments: CallerAppointment[],
): string {
  if (status === "found" && appointments.length > 0) {
    return `Upcoming appointments: ${appointments.map(spokenAppointment).join("; ")}.`;
  }
  if (status === "none") return "No upcoming appointments are loaded.";
  if (status === "error") return "Upcoming appointments could not be loaded.";
  return "Patient record is loaded.";
}

function spokenAppointment(appointment: CallerAppointment): string {
  const spoken = [
    spokenAppointmentDate(appointment.date),
    appointment.time ? `at ${appointment.time}` : "",
    appointment.provider ? `with ${appointment.provider}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return appointment.appointmentRef
    ? `${spoken} (appointmentRef ${appointment.appointmentRef})`
    : spoken;
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
