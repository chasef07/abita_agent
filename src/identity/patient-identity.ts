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
  activePatientName,
  type ActivePatient,
  type AppointmentLoadStatus,
  type CallState,
  type CallerAppointment,
  type InsuranceEligibilityCheck,
  type PatientIdentityOutcome,
  type PreCallPatientCandidate,
  recordPatientIdentityTransition,
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
} from "../scheduling/appointments.js";
import {
  getAmdOfficeForToolCall,
  visitTypeForAppointment,
} from "../scheduling/routing.js";
import { spokenAppointmentDate } from "../scheduling/spoken-date.js";
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
  allowedProviders: string[];
  routingAmbiguous: boolean;
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
  const differentPatient =
    explicitSwitch ||
    (input.patientContext !== "correction" &&
      pending?.details.firstName &&
      supplied.firstName &&
      !exactNamesMatch(pending.details.firstName, supplied.firstName));
  const previousPatientId = explicitSwitch
    ? (state.identity.activePatient?.patientId ??
      pending?.previousPatientId ??
      null)
    : pending?.previousPatientId;
  if (differentPatient) {
    advanceTransition(state, "synchronous");
    if (explicitSwitch) {
      resetPatientScopedWork(state);
      state.identity.activePatient = null;
      state.identity.registration = null;
      setInsuranceOnFile(state, null);
    }
  }
  const identity = { ...state.identity.pendingIdentity?.details, ...supplied };
  state.identity.pendingIdentity = { details: identity, previousPatientId };
  const key = patientResolutionKey(state);
  const existing = patientResolutions.get(state);
  if (
    existing?.key === key &&
    existing.operationVersion === state.identity.operationVersion
  ) {
    return existing.result;
  }
  const operationVersion = beginPatientIdentityOperation(state);
  const result = resolvePatientEvidence(
    state,
    identity,
    lookup,
    operationVersion,
  );
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
    return recordResolutionOutcome(state, {
      outcome: "needs_identity",
      reply:
        "That date of birth is invalid. Ask the caller to re-check it, read it back, and wait for confirmation. Use MM/DD/YYYY.",
    });
  }
  const preloaded = await resolvePrivateCandidate(
    state,
    identity,
    lookup,
    operationVersion,
  );
  if (preloaded) return recordResolutionOutcome(state, preloaded);
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
    return recordResolutionOutcome(state, {
      outcome: "verified",
      reply: `${active.name?.trim() || "The patient"} is already the active patient.`,
    });
  }

  if (!identity.firstName || !identity.dob) {
    return recordResolutionOutcome(state, {
      outcome: "needs_identity",
      reply: missingIdentityReply(identity),
    });
  }
  return recordResolutionOutcome(
    state,
    await resolveNameCandidates(
      state,
      {
        firstName: identity.firstName,
        dob: identity.dob,
        lastName: identity.lastName,
      },
      lookup,
      operationVersion,
    ),
  );
}

async function resolveNameCandidates(
  state: CallState,
  identity: { firstName: string; dob: string; lastName?: string },
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
  let search = state.identity.nameSearch;
  if (
    !search ||
    search.officePhone !== officePhone ||
    !exactNamesMatch(search.firstName, identity.firstName) ||
    !dobMatches(search.dob, identity.dob)
  ) {
    const result = await lookup(officePhone, {
      firstName: identity.firstName,
      dob: identity.dob,
    });
    if (!patientIdentityOperationIsCurrent(state, operationVersion))
      return {
        outcome: "superseded",
        reply: "The patient changed while I was looking up the record.",
      };
    if (result.status !== "candidates")
      return {
        outcome: "lookup_failed",
        reply:
          "The first-name search could not be verified. Connect the caller to office staff; this does not mean the patient is new.",
        failure:
          result.status === "error"
            ? result
            : { status: "error", reason: "invalid_response" },
      };
    search = {
      officePhone,
      firstName: identity.firstName,
      dob: identity.dob,
      result,
    };
    state.identity.nameSearch = search;
  }
  if (!search.result.complete)
    return {
      outcome: "lookup_failed",
      reply:
        "The patient search is incomplete. Connect the caller to office staff; a partial result cannot identify a unique patient.",
      failure: { status: "error", reason: "invalid_response" },
    };
  const matches = search.result.matches.filter(
    (candidate) =>
      exactNamesMatch(identity.firstName, candidate.firstName) &&
      dobMatches(identity.dob, candidate.dob),
  );
  const uniqueIds = new Set(matches.map((candidate) => candidate.patientId));
  if (uniqueIds.size !== matches.length)
    return {
      outcome: "lookup_failed",
      reply:
        "The patient search returned duplicate chart entries. Connect the caller to office staff.",
      failure: { status: "error", reason: "invalid_response" },
    };
  if (matches.length === 0) {
    // A partial identity search never grants permission to create a chart.
    if (hasFullIdentity(identity))
      state.identity.unregisteredPatientReceipt = {
        identity,
        lookupOperationVersion: operationVersion,
        insuranceCheckVersion: 0,
      };
    return {
      outcome: "not_found",
      reply:
        "No chart matched that spelled first name and confirmed date of birth. Correct either detail if needed; otherwise connect an existing patient to staff. Use registration only for explicit new-patient intent.",
    };
  }
  const lastName = identity.lastName;
  const selected =
    matches.length > 1 && lastName
      ? matches.filter((candidate) =>
          exactNamesMatch(lastName, candidate.lastName),
        )
      : matches;
  if (selected.length !== 1)
    return {
      outcome: "multiple_matches",
      reply: !identity.lastName
        ? "More than one chart matches that first name and date of birth. Ask the caller to spell the patient's last name."
        : "The supplied surname does not distinguish one chart. Confirm its spelling or connect the caller to office staff.",
    };
  const candidate = selected[0]!;
  if (candidate.patientId === state.identity.pendingIdentity?.previousPatientId)
    return {
      outcome: "multiple_matches",
      reply:
        "These details identify the previous patient's chart. Connect the caller to staff to identify the different patient.",
    };
  return hydratePatient(
    state,
    candidate.patientId,
    matches.length === 1 ? { ...identity, lastName: undefined } : identity,
    lookup,
    operationVersion,
    "first_name",
    officePhone,
  );
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
  recordPatientIdentityTransition(state, {
    outcome: "new",
    source: "create_patient",
  });
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
      allowedProviders: receipt.allowedProviders ?? [],
      routingAmbiguous: receipt.routingAmbiguous ?? false,
      preauthRequired: receipt.preauthRequired ?? false,
    },
    "create_patient",
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

export function patientModelProjection(state: CallState): string {
  const patient = state.identity.activePatient;
  if (!patient) {
    if (state.identity.registration) {
      return "Patient situation: new-patient registration is in progress; no patient chart is active.";
    }
    const count = state.identity.privateCandidates.length;
    const firstNameSpellings = [
      ...new Set(
        state.identity.privateCandidates.flatMap(({ firstName }) => {
          const name = firstName?.trim().normalize("NFC");
          if (!name) return [];
          return [
            name
              .toUpperCase()
              .split(/\s+/u)
              .map((word) => Array.from(word).join("-"))
              .join(" "),
          ];
        }),
      ),
    ];
    const lookup =
      count > 0
        ? `Phone lookup found ${count} possible patient${count === 1 ? "" : "s"}. For patient-specific work, ask only for the intended patient's first name if unknown. Once supplied, call resolve_patient immediately; a firstName alone is enough to try the phone matches. A volunteered surname does not block a unique phone match. If unresolved, ask for the spelled first name and confirmed DOB; request surname spelling only to distinguish remaining matches. Include any identity already supplied, confirming a supplied DOB before resolving.`
        : state.runtime.preCallLookup.status === "lookup_failed"
          ? "Phone lookup failed; this does not mean the patient is new. Use resolve_patient with caller-provided identity to look up the record."
          : state.runtime.preCallLookup.status === "no_match"
            ? "Phone lookup found no matches; the patient may still be registered. Use resolve_patient with caller-provided identity to look up the record."
            : "Phone lookup has not provided patient candidates. Use resolve_patient with caller-provided identity for patient-specific work.";
    const spellingHint = firstNameSpellings.length
      ? ` Private first-name spelling hints: ${JSON.stringify(firstNameSpellings)}. Never read these hints aloud or substitute them for caller-provided identity.`
      : "";
    return `Patient situation: no patient is active. ${lookup}${spellingHint}`;
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
  source: "resolve_patient" | "create_patient",
): boolean {
  return promotePatient(state, patient, source, "synchronous");
}

function promotePatient(
  state: CallState,
  patient: PatientActivation,
  source: "resolve_patient" | "create_patient",
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
        reply:
          "The supplied surname does not distinguish these phone records. Ask the caller to spell the last name, or connect them to office staff.",
      };
  }

  if (matches.length > 1) {
    return {
      outcome: "multiple_matches",
      reply:
        !identity.dob || !identity.lastName
          ? missingIdentityReply(identity)
          : "I couldn't distinguish these patient records. Do not retry unchanged details. Connect the caller to office staff for help.",
    };
  }

  if (
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
  if (!identity.firstName)
    return "What is the patient's first name? Please ask them to spell it.";
  if (!identity.dob)
    return "Ask the caller to spell the patient's first name and provide their date of birth. Read the date of birth back and wait for confirmation before resolving.";
  return "Ask the caller to spell the patient's last name to distinguish the matching charts.";
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
      "resolve_patient",
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
  source: "phone" | "first_name" = "phone",
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
    if (source === "phone")
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
    "resolve_patient",
    "operation",
  );
  if (source === "phone")
    state.runtime.preCallLookup.hydrationOutcome = "verified";
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
  if (source === "synchronous") {
    state.identity.unregisteredPatientReceipt = null;
    state.identity.operationVersion += 1;
  }
  state.identity.transitionVersion += 1;
  state.identity.pendingIdentity = null;
  state.identity.nameSearch = null;
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
  source: "phone" | "first_name",
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

function confirmedPatientReply(state: CallState): string {
  const patient = state.identity.activePatient;
  return appointmentReply(
    [
      `I verified ${activePatientName(state) ?? "the patient"}.`,
      knownInsuranceOnFileSummary(state),
    ]
      .filter(Boolean)
      .join(" "),
    patient?.appointmentsStatus ?? null,
    patient?.appointments ?? [],
  );
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
    return `${prefix} I found ${appointments.length === 1 ? "one upcoming appointment" : `${appointments.length} upcoming appointments`}, ${appointments.map(spokenCallerAppointment).join("; ")}.`;
  }
  if (status === "none")
    return `${prefix} I don't see any upcoming appointments.`;
  if (status === "error") {
    return `${prefix} I couldn't load the upcoming appointments. Let me confirm the patient's identity again.`;
  }
  return `${prefix} I found the patient record.`;
}

function appointmentProjection(
  status: AppointmentLoadStatus | null,
  appointments: CallerAppointment[],
): string {
  if (status === "found" && appointments.length > 0) {
    return `Upcoming appointments: ${appointments.map(spokenInternalAppointment).join("; ")}.`;
  }
  if (status === "none") return "No upcoming appointments are loaded.";
  if (status === "error") return "Upcoming appointments could not be loaded.";
  return "Patient record is loaded.";
}

function spokenCallerAppointment(appointment: CallerAppointment): string {
  const spoken = [
    spokenAppointmentDate(appointment.date),
    appointment.time ? `at ${appointment.time}` : "",
    appointment.provider ? `with ${appointment.provider}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return spoken;
}

function spokenInternalAppointment(appointment: CallerAppointment): string {
  const spoken = spokenCallerAppointment(appointment);
  return appointment.appointmentRef
    ? `${spoken} (appointmentRef ${appointment.appointmentRef}, visitType ${visitTypeForAppointment(appointment)})`
    : spoken;
}

function patientLookupReply(result: PatientResolveResult): string {
  if (result.status === "not_found") {
    return "No chart matched these details. Do not repeat an unchanged lookup. Correct a mistaken detail if needed. If the caller says they are already registered, connect them to staff; use new-patient registration only when the caller explicitly says they are new.";
  }
  if (result.status === "multiple_matches") {
    return "More than one chart matches these details. Do not retry unchanged details or create a new chart. Connect the caller to office staff to distinguish the records.";
  }
  return "Patient lookup failed. Do not retry unchanged details or treat the patient as new. Connect the caller to office staff.";
}
