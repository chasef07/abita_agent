import {
  patientResolveReceiptIsComplete,
  type CreatePatientResult,
  type MiddlewareFailure,
  type PatientResolveResult,
  type PatientResolveVerified,
} from "../clients/owned-middleware.js";
import { getOfficeProfileByPhone } from "../customers/abita/profile.js";
import { normalizeCallerAppointments } from "../state/appointments.js";
import {
  activePatientDob,
  activePatientId,
  activePatientName,
  type ActivePatient,
  type AppointmentLoadStatus,
  type CallState,
  type CallerAppointment,
  type InsuranceEligibilityCheck,
  type PatientIdentityOutcome,
  type PreCallPatientCandidate,
  type RegistrationDraft,
} from "../state/call-state.js";
import { resetActiveOfficeToTrunk } from "../state/call-lifecycle.js";
import {
  insuranceOnFile,
  insuranceSnapshot,
  lastInsuranceEligibilityCheck,
  resetPatientSchedulingState,
  setInsuranceOnFile,
  setLastInsuranceEligibilityCheck,
  setRoutingContext,
} from "../scheduling/state.js";
import {
  appointmentStatusFromResult,
  extractAppointments,
  currentAppointmentReferences,
  spokenAppointmentDescription,
} from "../scheduling/appointments.js";
import { getAmdOfficeForToolCall } from "../scheduling/routing.js";
import {
  dobMatches,
  isValidPatientDOB,
  namesMatch,
  phoneCandidateFirstNameMatches,
  phoneCandidateSurnameMatches,
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
  | PatientLookupIdentity
  | PatientReferenceIdentity
  | Pick<PatientLookupIdentity, "firstName" | "dob">;

export type PatientResolveLookup = (
  officePhone: string,
  identity: PatientResolveLookupIdentity,
) => Promise<PatientResolveResult>;

export type ResolvePatientIdentityInput = Partial<PatientLookupIdentity> & {
  patientContext?: "correction" | "different_patient";
};

export type PatientIdentityResolution = {
  outcome: PatientIdentityOutcome | "superseded";
  reply: string;
  failure?: MiddlewareFailure;
};

export type PatientActivation = ActivePatient & {
  insuranceCarrier: string | null;
  routing: string | null;
  preauthRequired: boolean;
};

type SuccessfulPatientCreationReceipt = Extract<
  CreatePatientResult,
  { status: "created" | "partial" }
>;

declare const patientCreationOperationBrand: unique symbol;

export type PatientCreationOperation = {
  readonly [patientCreationOperationBrand]: true;
};

type TaskPatientContext = CallState["identity"]["unresolvedTaskPatient"];

function callerReportedTaskPatient(identity: ResolvePatientIdentityInput) {
  const name = [identity.firstName, identity.lastName]
    .filter(Boolean)
    .join(" ");
  return {
    ...(name ? { name } : {}),
    ...(identity.dob ? { dob: identity.dob } : {}),
  };
}

function clearTaskPatientContext(
  state: CallState,
  expected: TaskPatientContext,
) {
  const current = state.identity.unresolvedTaskPatient;
  if (
    current &&
    expected &&
    (current.name === expected.name ||
      (current.name &&
        expected.name &&
        exactNamesMatch(current.name, expected.name))) &&
    (current.dob === expected.dob || dobMatches(current.dob, expected.dob))
  )
    state.identity.unresolvedTaskPatient = null;
}

export function staffTaskPatient(
  state: CallState,
): { id?: string; name?: string; dob?: string } | undefined {
  const unresolved = state.identity.unresolvedTaskPatient;
  if (unresolved) return unresolved;
  const id = activePatientId(state);
  const name = activePatientName(state);
  const dob = activePatientDob(state);
  return id || name || dob
    ? {
        ...(id ? { id } : {}),
        ...(name ? { name } : {}),
        ...(dob ? { dob } : {}),
      }
    : undefined;
}

type PatientCreationOperationState = {
  callState: CallState;
  eligibilityCheck: InsuranceEligibilityCheck | null;
  operationVersion: number;
  registration: PatientLookupIdentity;
  transitionVersion: number;
};

export type PatientCreationCommit =
  | {
      outcome: "activated";
      receipt: SuccessfulPatientCreationReceipt;
    }
  | {
      outcome: "failed";
      failure: MiddlewareFailure;
    }
  | {
      outcome: "invalid_receipt";
      result?: SuccessfulPatientCreationReceipt;
    }
  | {
      outcome: "superseded";
      result: CreatePatientResult;
    };

// One decision (including in-flight work) for the current intended patient/query.
const patientResolutions = new WeakMap<
  CallState,
  {
    key: string;
    operationVersion: number;
    result: Promise<PatientIdentityResolution>;
  }
>();

const patientCreationOperations = new WeakMap<
  PatientCreationOperation,
  PatientCreationOperationState
>();

export async function resolveExistingPatient(
  state: CallState,
  input: ResolvePatientIdentityInput,
  lookup: PatientResolveLookup,
): Promise<PatientIdentityResolution> {
  const supplied = registrationDraft(input);
  if (
    supplied.firstName &&
    /^(?:[a-z][\s.-]+)+[a-z]$/i.test(supplied.firstName)
  ) {
    const letters = normalizeExactName(supplied.firstName);
    supplied.firstName = letters[0]!.toUpperCase() + letters.slice(1);
  }
  const pending = state.identity.pendingIdentity;
  const explicitSwitch =
    input.patientContext === "different_patient" &&
    (pending?.previousPatientId === undefined ||
      state.identity.activePatient !== null ||
      registrationTargetsDifferentPatient(pending.details, supplied));
  const conflictsWithActive = Boolean(
    state.identity.activePatient &&
    identityTargetsDifferentPatient(state.identity.activePatient, {
      firstName: supplied.firstName,
      dob: supplied.dob,
    }),
  );
  const differentPatient =
    explicitSwitch ||
    conflictsWithActive ||
    (input.patientContext !== "correction" &&
      pending?.details.firstName &&
      supplied.firstName &&
      !exactNamesMatch(pending.details.firstName, supplied.firstName));
  const previousPatientId =
    explicitSwitch || conflictsWithActive
      ? (state.identity.activePatient?.patientId ??
        pending?.previousPatientId ??
        null)
      : pending?.previousPatientId;
  if (differentPatient) {
    advanceTransition(state, "synchronous");
    if (explicitSwitch || conflictsWithActive) {
      resetPatientScopedWork(state);
      state.identity.activePatient = null;
      state.identity.registration = null;
      setInsuranceOnFile(state, null);
    }
  }
  const identity = { ...state.identity.pendingIdentity?.details, ...supplied };
  state.identity.pendingIdentity = {
    details: identity,
    previousPatientId,
    excludePreviousPatient:
      explicitSwitch || pending?.excludePreviousPatient === true,
  };
  const taskPatientContext = callerReportedTaskPatient(identity);
  state.identity.unresolvedTaskPatient = taskPatientContext;
  const key = patientResolutionKey(state);
  const existing = patientResolutions.get(state);
  if (
    existing?.key === key &&
    existing.operationVersion === state.identity.operationVersion
  ) {
    const result = await existing.result;
    if (result.outcome === "verified" || result.outcome === "switched")
      clearTaskPatientContext(state, taskPatientContext);
    return result;
  }
  const operationVersion = beginPatientIdentityOperation(state);
  const result = resolvePatientEvidence(
    state,
    identity,
    lookup,
    operationVersion,
  ).then((outcome) => {
    if (outcome.outcome === "verified" || outcome.outcome === "switched")
      clearTaskPatientContext(state, taskPatientContext);
    return outcome;
  });
  const entry = { key, operationVersion, result };
  patientResolutions.set(state, entry);
  // Unexpected exceptions are not definitive lookup decisions.
  void result.catch(() => {
    if (patientResolutions.get(state) === entry)
      patientResolutions.delete(state);
  });
  return result;
}

// Identity decisions depend on chart identity and whether a reload is needed,
// not appointment contents, insurance, or unrelated office overrides.
function patientResolutionKey(state: CallState): string {
  const active = state.identity.activePatient;
  return JSON.stringify([
    state.identity.pendingIdentity,
    state.runtime.trunkPhone,
    state.office.activeKey,
    getAmdOfficeForToolCall(state),
    state.identity.privateCandidates.map((candidate) => [
      candidate.status,
      candidate.patientId,
      candidate.firstName,
      candidate.lastName,
      candidate.dob,
      candidate.status === "verified" &&
        candidate.appointmentsStatus === "error",
    ]),
    active && [
      active.patientId,
      active.name,
      active.dob,
      active.appointmentsStatus === "error",
    ],
    state.identity.transitionVersion,
  ]);
}

async function resolvePatientEvidence(
  state: CallState,
  identity: ResolvePatientIdentityInput,
  lookup: PatientResolveLookup,
  operationVersion: number,
): Promise<PatientIdentityResolution> {
  if (identity.dob && !isValidPatientDOB(identity.dob)) {
    return {
      outcome: "needs_identity",
      reply:
        "That date of birth is invalid. Ask the caller for a corrected date. Use MM/DD/YYYY.",
    };
  }
  const preloaded = await resolvePrivateCandidate(
    state,
    identity,
    lookup,
    operationVersion,
  );
  if (preloaded) return preloaded;
  if (!patientIdentityOperationIsCurrent(state, operationVersion)) {
    return {
      outcome: "superseded",
      reply: "The patient changed while I was looking up the record.",
    };
  }

  const active = state.identity.activePatient;
  if (
    identity.firstName &&
    active &&
    !identityTargetsDifferentPatient(active, {
      firstName: identity.firstName,
      dob: identity.dob,
    }) &&
    active.appointmentsStatus !== "error"
  ) {
    state.identity.unregisteredPatientReceipt = null;
    return {
      outcome: "verified",
      reply: `${active.name?.trim() || "The patient"} is already the active patient.`,
    };
  }

  if (!identity.firstName || !identity.lastName || !identity.dob) {
    return {
      outcome: "needs_identity",
      reply: !identity.firstName
        ? "What is the patient's first name?"
        : !identity.lastName
          ? identity.dob
            ? "Please spell the patient's last name."
            : "Please spell the patient's last name and provide their date of birth."
          : "What is the patient's date of birth?",
    };
  }
  return resolveFullName(
    state,
    {
      firstName: identity.firstName,
      dob: identity.dob,
      lastName: identity.lastName,
    },
    lookup,
    operationVersion,
  );
}

async function resolveFullName(
  state: CallState,
  identity: PatientLookupIdentity,
  lookup: PatientResolveLookup,
  operationVersion: number,
): Promise<PatientIdentityResolution> {
  const active = state.identity.activePatient;
  const officePhone =
    active &&
    identityTargetsDifferentPatient(active, {
      firstName: identity.firstName,
      dob: identity.dob,
    })
      ? getOfficeProfileByPhone(state.runtime.trunkPhone).amdOfficePhone
      : getAmdOfficeForToolCall(state);
  const result = await lookup(officePhone, identity);
  if (!patientIdentityOperationIsCurrent(state, operationVersion))
    return {
      outcome: "superseded",
      reply: "The patient changed while I was looking up the record.",
    };
  if (result.status === "not_found") {
    state.identity.unregisteredPatientReceipt = {
      identity,
      lookupOperationVersion: operationVersion,
      insuranceCheckVersion: 0,
    };
    return {
      outcome: "not_found",
      reply: "I couldn't find a matching patient.",
    };
  }
  if (result.status === "multiple_matches")
    return {
      outcome: "multiple_matches",
      reply:
        "More than one chart matches those details. Connect the caller to office staff to identify the correct patient.",
    };
  if (
    result.status !== "verified" ||
    !patientResolveReceiptIsComplete(result) ||
    !hydratedPatientMatchesIdentity(result, identity, "full_name") ||
    (state.identity.pendingIdentity?.excludePreviousPatient &&
      result.patientId === state.identity.pendingIdentity.previousPatientId)
  )
    return {
      outcome: "lookup_failed",
      reply:
        "I couldn't safely verify the patient chart. Connect the caller to office staff; do not treat the patient as new.",
      failure:
        result.status === "error"
          ? result
          : { status: "error", reason: "invalid_response" },
    };
  const hadActivePatient =
    state.identity.activePatient !== null ||
    state.identity.pendingIdentity?.previousPatientId != null;
  const changed = promotePatient(
    state,
    activationFromResolvedPatient(result, "existing"),
    "operation",
  );
  return {
    outcome: hadActivePatient && changed ? "switched" : "verified",
    reply: confirmedPatientReply(state),
  };
}

export function beginNewPatientRegistration(
  state: CallState,
  identity: ResolvePatientIdentityInput,
  options: { preserveEligibilityCheck?: boolean } = {},
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
    state.identity.unresolvedTaskPatient = callerReportedTaskPatient(
      state.identity.registration,
    );
    return;
  }

  const replacingRegistration = state.identity.registration !== null;
  const suspendingActivePatient = state.identity.activePatient !== null;
  advanceTransition(state, "synchronous");
  resetPatientScopedWork(state, {
    preserveEligibilityCheck:
      options.preserveEligibilityCheck === true ||
      (!replacingRegistration && !suspendingActivePatient),
  });
  setInsuranceOnFile(state, null);
  state.identity.activePatient = null;
  state.identity.registration = draft;
  state.identity.unresolvedTaskPatient = callerReportedTaskPatient(draft);
}

export function beginPatientCreation(
  state: CallState,
): PatientCreationOperation | null {
  const registration = state.identity.registration;
  if (!registration || !hasFullIdentity(registration)) return null;
  const operation = {} as PatientCreationOperation;
  patientCreationOperations.set(operation, {
    callState: state,
    eligibilityCheck: cloneEligibilityCheck(
      lastInsuranceEligibilityCheck(state),
    ),
    operationVersion: beginPatientIdentityOperation(state),
    registration: { ...registration },
    transitionVersion: state.identity.transitionVersion,
  });
  return operation;
}

export function commitPatientCreation(
  state: CallState,
  operation: PatientCreationOperation,
  result: CreatePatientResult,
): PatientCreationCommit {
  const operationState = patientCreationOperations.get(operation);
  if (!operationState || operationState.callState !== state) {
    return { outcome: "invalid_receipt" };
  }
  patientCreationOperations.delete(operation);
  if (
    !patientIdentityOperationIsCurrent(
      state,
      operationState.operationVersion,
    ) &&
    !patientIdentityTransitionIsCurrent(state, operationState.transitionVersion)
  ) {
    return { outcome: "superseded", result };
  }
  if (result.status === "error") {
    return { outcome: "failed", failure: result };
  }
  if (
    !activatePatientFromReceipt(
      state,
      operationState.registration,
      operationState.eligibilityCheck,
      result,
    )
  ) {
    return { outcome: "invalid_receipt", result };
  }
  clearTaskPatientContext(
    state,
    callerReportedTaskPatient(operationState.registration),
  );
  return { outcome: "activated", receipt: result };
}

function activatePatientFromReceipt(
  state: CallState,
  registration: PatientLookupIdentity,
  checkedInsurance: InsuranceEligibilityCheck | null,
  receipt: SuccessfulPatientCreationReceipt,
): boolean {
  if (receipt.status !== "created" && receipt.status !== "partial")
    return false;
  const patientId = receipt.patientId?.trim();
  if (
    !patientId ||
    !currentRegistrationMatches(state, registration) ||
    !creationReceiptMatchesRegistration(receipt, registration)
  ) {
    return false;
  }
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
      preauthRequired: receipt.preauthRequired ?? false,
    },
    "operation",
  );
  if (receipt.status === "partial") {
    setInsuranceOnFile(state, null);
  } else if (checkedInsurance) {
    setInsuranceOnFile(
      state,
      insuranceSnapshot({
        plan: receipt.insuranceCarrier ?? checkedInsurance.currentCarrier,
        canonicalPlan: checkedInsurance.canonicalPlan,
        coverageType: checkedInsurance.coverageType,
        currentCarrier:
          receipt.insuranceCarrier ?? checkedInsurance.currentCarrier,
      }),
    );
  }
  setLastInsuranceEligibilityCheck(state, null);
  return true;
}

function cloneEligibilityCheck(
  check: InsuranceEligibilityCheck | null,
): InsuranceEligibilityCheck | null {
  return check ? { ...check } : null;
}

export function patientRegistrationStatus(
  state: CallState,
  identity: PatientLookupIdentity,
):
  | "created_patient"
  | "active_patient"
  | "confirmed_new_patient"
  | "different_patient"
  | "pre_call_candidate"
  | null {
  const active = state.identity.activePatient;
  if (active) {
    return identityTargetsDifferentPatient(active, identity)
      ? confirmedUnregisteredPatientMatches(state, identity)
        ? "confirmed_new_patient"
        : "different_patient"
      : active.kind === "created"
        ? "created_patient"
        : "active_patient";
  }
  if (
    state.identity.registration &&
    registrationTargetsDifferentPatient(
      state.identity.registration,
      registrationDraft(identity),
    )
  ) {
    return confirmedUnregisteredPatientMatches(state, identity)
      ? "confirmed_new_patient"
      : "different_patient";
  }
  return state.identity.privateCandidates.some((candidate) =>
    candidateMatchesIdentity(candidate, identity),
  )
    ? "pre_call_candidate"
    : confirmedUnregisteredPatientMatches(state, identity)
      ? "confirmed_new_patient"
      : null;
}

export function consumeConfirmedUnregisteredPatient(
  state: CallState,
  identity: PatientLookupIdentity,
): boolean {
  if (!confirmedUnregisteredPatientMatches(state, identity)) return false;
  const receipt = state.identity.unregisteredPatientReceipt;
  if (
    !receipt ||
    receipt.lookupOperationVersion !== state.identity.operationVersion ||
    receipt.insuranceCheckVersion === 0
  )
    return false;
  state.identity.unregisteredPatientReceipt = null;
  return true;
}

function beginPatientIdentityOperation(state: CallState): number {
  state.identity.unregisteredPatientReceipt = null;
  state.identity.operationVersion += 1;
  return state.identity.operationVersion;
}

function patientIdentityOperationIsCurrent(
  state: CallState,
  operationVersion: number,
): boolean {
  return state.identity.operationVersion === operationVersion;
}

function patientIdentityTransitionIsCurrent(
  state: CallState,
  transitionVersion: number,
): boolean {
  return state.identity.transitionVersion === transitionVersion;
}

export function incompletePatientRegistrationMessage(
  state: CallState,
): string | null {
  return state.identity.activePatient?.kind === "created" &&
    !state.insurance.onFile
    ? "The patient chart exists, but insurance is not attached. Connect the caller to office staff to finish registration before scheduling."
    : null;
}

function promotePatient(
  state: CallState,
  patient: PatientActivation,
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
  return changed;
}

async function resolvePrivateCandidate(
  state: CallState,
  identity: ResolvePatientIdentityInput,
  lookup: PatientResolveLookup,
  operationVersion: number,
): Promise<PatientIdentityResolution | null> {
  if (!identity.firstName || state.identity.privateCandidates.length === 0) {
    return null;
  }

  const named = state.identity.privateCandidates.filter((candidate) =>
    phoneCandidateFirstNameMatches(identity.firstName, candidate.firstName),
  );
  const matches = named.filter(
    (candidate) => !identity.dob || dobMatches(identity.dob, candidate.dob),
  );
  if (matches.length === 0) return null;

  // A supplied surname never vetoes a unique phone/first-name match. It is only
  // used to distinguish candidates that still collide after the DOB step.
  if (matches.length > 1 && identity.dob && identity.lastName) {
    const selected = matches.filter((candidate) =>
      phoneCandidateSurnameMatches(
        identity.lastName!,
        candidate.lastName ?? "",
      ),
    );
    if (selected.length === 1) {
      if (
        state.identity.pendingIdentity?.excludePreviousPatient &&
        selected[0]!.patientId ===
          state.identity.pendingIdentity?.previousPatientId
      )
        return {
          outcome: "multiple_matches",
          reply:
            "These details identify the previous patient's chart. Connect the caller to office staff.",
        };
      return activateCandidate(
        state,
        selected[0]!,
        identity,
        lookup,
        operationVersion,
      );
    }
    if (selected.length === 0)
      return {
        outcome: "multiple_matches",
        reply: "I found more than one matching patient.",
      };
  }

  if (matches.length > 1) {
    return {
      outcome: "multiple_matches",
      reply:
        !identity.dob || !identity.lastName
          ? missingIdentityReply(identity)
          : "I found more than one matching patient.",
    };
  }

  if (
    state.identity.pendingIdentity?.excludePreviousPatient &&
    matches[0]!.patientId === state.identity.pendingIdentity?.previousPatientId
  ) {
    return {
      outcome:
        !identity.dob || !identity.lastName
          ? "needs_identity"
          : "multiple_matches",
      reply:
        !identity.dob || !identity.lastName
          ? "These details still identify the previous patient's chart. " +
            missingIdentityReply(identity)
          : "These details still identify the previous patient's chart. Connect the caller to office staff to identify the different patient.",
    };
  }

  return activateCandidate(
    state,
    matches[0]!,
    { ...identity, lastName: undefined },
    lookup,
    operationVersion,
  );
}

function missingIdentityReply(identity: ResolvePatientIdentityInput): string {
  if (!identity.firstName) return "What is the patient's first name?";
  if (!identity.dob) return "What is the patient's date of birth?";
  return "I found more than one matching patient.";
}

async function activateCandidate(
  state: CallState,
  candidate: PreCallPatientCandidate,
  identity: ResolvePatientIdentityInput,
  lookup: PatientResolveLookup,
  operationVersion: number,
): Promise<PatientIdentityResolution> {
  if (candidate.status === "verified") {
    const isActiveCandidate = samePatient(
      state.identity.activePatient,
      activationFromCandidate(candidate),
    );
    if (
      isActiveCandidate &&
      state.identity.activePatient?.appointmentsStatus !== "error"
    ) {
      return {
        outcome: "verified",
        reply: `${state.identity.activePatient?.name?.trim() || "The patient"} is already the active patient.`,
      };
    }
    if (isActiveCandidate) {
      return hydratePatient(
        state,
        candidate.patientId,
        identity,
        lookup,
        operationVersion,
      );
    }
    const hadActivePatient =
      state.identity.activePatient !== null ||
      state.identity.pendingIdentity?.previousPatientId != null;
    const changed = promotePatient(
      state,
      activationFromCandidate(candidate),
      "synchronous",
    );
    return {
      outcome: hadActivePatient && changed ? "switched" : "verified",
      reply: confirmedPatientReply(state),
    };
  }
  return hydratePatient(
    state,
    candidate.patientId,
    identity,
    lookup,
    operationVersion,
  );
}

async function hydratePatient(
  state: CallState,
  patientId: string,
  identity: ResolvePatientIdentityInput,
  lookup: PatientResolveLookup,
  operationVersion: number,
  source: "phone" | "full_name" = "phone",
  officePhone = getOfficeProfileByPhone(state.runtime.trunkPhone)
    .amdOfficePhone,
): Promise<PatientIdentityResolution> {
  const result = await lookup(officePhone, { patientId });
  if (!patientIdentityOperationIsCurrent(state, operationVersion)) {
    return {
      outcome: "superseded",
      reply: "The patient changed while I was looking up the record.",
    };
  }
  if (
    result.status !== "verified" ||
    !patientResolveReceiptIsComplete(result) ||
    result.patientId !== patientId ||
    !hydratedPatientMatchesIdentity(result, identity, source)
  ) {
    const failure: MiddlewareFailure | undefined =
      result.status === "verified"
        ? { status: "error", reason: "invalid_response" }
        : result.status === "error"
          ? result
          : undefined;
    return {
      outcome:
        result.status === "not_found"
          ? "not_found"
          : result.status === "multiple_matches"
            ? "multiple_matches"
            : "lookup_failed",
      reply:
        result.status === "verified"
          ? "I couldn't verify the chart receipt. Do not retry unchanged details or treat the patient as new. Connect the caller to office staff."
          : patientLookupReply(result),
      ...(failure ? { failure } : {}),
    };
  }

  const hadActivePatient =
    state.identity.activePatient !== null ||
    state.identity.pendingIdentity?.previousPatientId != null;
  const changed = promotePatient(
    state,
    activationFromResolvedPatient(result, "existing"),
    "operation",
  );
  return {
    outcome: hadActivePatient && changed ? "switched" : "verified",
    reply: confirmedPatientReply(state),
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
    preauthRequired: patient.preauthRequired,
  };
}

function advanceTransition(
  state: CallState,
  source: "operation" | "synchronous",
): void {
  if (source === "synchronous") {
    state.identity.unregisteredPatientReceipt = null;
    state.identity.operationVersion += 1;
  }
  state.identity.transitionVersion += 1;
  state.identity.pendingIdentity = null;
}

function resetPatientScopedWork(
  state: CallState,
  options: { preserveEligibilityCheck?: boolean } = {},
): void {
  resetPatientSchedulingState(state, options);
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
      !exactNamesMatch(current.firstName, next.firstName)) ||
    (current.lastName &&
      next.lastName &&
      !exactNamesMatch(current.lastName, next.lastName)) ||
    (current.dob && next.dob && !dobMatches(current.dob, next.dob)),
  );
}

function confirmedUnregisteredPatientMatches(
  state: CallState,
  identity: PatientLookupIdentity,
): boolean {
  const confirmed = state.identity.unregisteredPatientReceipt;
  const candidate = registrationDraft(identity);
  return Boolean(
    confirmed &&
    confirmed.lookupOperationVersion === state.identity.operationVersion &&
    hasFullIdentity(candidate) &&
    !registrationTargetsDifferentPatient(confirmed.identity, candidate),
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

function creationReceiptMatchesRegistration(
  receipt: SuccessfulPatientCreationReceipt,
  registration: RegistrationDraft,
): boolean {
  if (!hasFullIdentity(registration) || !receipt.name?.trim()) return false;
  if (!receipt.dob?.trim() || !dobMatches(registration.dob, receipt.dob)) {
    return false;
  }
  const receiptName = activePatientNameParts(receipt.name);
  if (!receiptName) return false;
  return (
    receiptName.firstNames.some((name) =>
      exactNamesMatch(registration.firstName, name),
    ) &&
    receiptName.lastNames.some((name) =>
      exactNamesMatch(registration.lastName, name),
    )
  );
}

function hydratedPatientMatchesIdentity(
  receipt: PatientResolveVerified,
  identity: ResolvePatientIdentityInput,
  source: "phone" | "full_name",
): boolean {
  const name = activePatientNameParts(receipt.name);
  if (!name || !identity.firstName) return false;
  // Apply fuzzy surname policy to the full surname, never a shortened component
  // that would erase a conflicting component supplied by the caller.
  const fullSurname = name.lastNames.reduce(
    (full, part) => (part.length > full.length ? part : full),
    "",
  );
  return Boolean(
    name.firstNames.some((first) =>
      source === "phone"
        ? phoneCandidateFirstNameMatches(identity.firstName, first)
        : exactNamesMatch(identity.firstName!, first),
    ) &&
    (!identity.dob || dobMatches(identity.dob, receipt.dob)) &&
    (!identity.lastName ||
      name.lastNames.some((last) =>
        exactNamesMatch(identity.lastName!, last),
      ) ||
      (source === "phone" &&
        identity.dob &&
        phoneCandidateSurnameMatches(identity.lastName, fullSurname))),
  );
}

function currentRegistrationMatches(
  state: CallState,
  expected: PatientLookupIdentity,
): boolean {
  const current = state.identity.registration;
  return Boolean(
    current &&
    hasFullIdentity(current) &&
    exactNamesMatch(current.firstName, expected.firstName) &&
    exactNamesMatch(current.lastName, expected.lastName) &&
    dobMatches(current.dob, expected.dob),
  );
}

function exactNamesMatch(left: string, right: string): boolean {
  const normalizedLeft = normalizeExactName(left);
  const normalizedRight = normalizeExactName(right);
  return Boolean(normalizedLeft && normalizedLeft === normalizedRight);
}

function normalizeExactName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
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
        exactNamesMatch(identity.lastName ?? "", name),
      )),
  );
}

function activePatientNameParts(
  name: string | null,
): { firstNames: string[]; lastNames: string[] } | null {
  const trimmed = name
    ?.normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
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
        lastParts[0],
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

function hasFullIdentity(
  identity: ResolvePatientIdentityInput,
): identity is PatientLookupIdentity {
  return Boolean(identity.firstName && identity.lastName && identity.dob);
}

function candidateDisplayName(candidate: PreCallPatientCandidate): string {
  return [candidate.firstName, candidate.lastName].filter(Boolean).join(" ");
}

function normalizeValue(value: string | null | undefined): string {
  return value?.trim().toLowerCase().replace(/\s+/g, " ") ?? "";
}

function spokenPatientName(state: CallState): string {
  const name = activePatientName(state) ?? "the patient";
  const [last, first] = name.split(",", 2).map((part) => part.trim());
  return first ? `${first} ${last}` : name;
}

function confirmedPatientReply(state: CallState): string {
  const patient = state.identity.activePatient;
  const acknowledgment = appointmentReply(
    [
      `I found you in our system, ${spokenPatientName(state)}.`,
      knownInsuranceOnFileSummary(state),
    ]
      .filter(Boolean)
      .join(" "),
    patient?.appointmentsStatus ?? null,
    patient?.appointments ?? [],
  );
  if (patient?.appointmentsStatus !== "found" || !patient.appointments.length)
    return acknowledgment;
  return `${acknowledgment}\n${currentAppointmentReferences(state)}`;
}

function knownInsuranceOnFileSummary(state: CallState): string {
  const insurance = insuranceOnFile(state);
  const carrier = (
    insurance?.currentCarrier ??
    insurance?.canonicalPlan ??
    insurance?.plan
  )?.trim();
  return carrier ? `We have ${carrier} on file.` : "";
}

function appointmentReply(
  prefix: string,
  status: AppointmentLoadStatus | null,
  appointments: CallerAppointment[],
): string {
  if (status === "found" && appointments.length > 0) {
    return `${prefix} I found ${appointments.length === 1 ? "one upcoming appointment" : `${appointments.length} upcoming appointments`}, ${appointments.map(spokenAppointmentDescription).join("; ")}.`;
  }
  if (status === "none")
    return `${prefix} I don't see any upcoming appointments.`;
  if (status === "error") {
    return `${prefix} I couldn't load the upcoming appointments. Let me reload the patient record.`;
  }
  return `${prefix} I found the patient record.`;
}

function patientLookupReply(result: PatientResolveResult): string {
  if (result.status === "not_found") {
    return "I couldn't find a matching patient.";
  }
  if (result.status === "multiple_matches") {
    return "I found more than one matching patient.";
  }
  return "I couldn't look up the patient. Let me try once more.";
}
