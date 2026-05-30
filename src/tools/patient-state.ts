import {
  type PatientResolveResult,
  type PatientResolveVerified,
  resolvePatientByOffice,
} from "../clients/advancedmd-client.js";
import {
  appointmentCancelTokenMap,
  CALLER_CANDIDATE_REF,
  clearAvailabilitySelection,
  normalizeSchedulingRouting,
  publicCallerAppointments,
  runtimeCallerPhone,
  setAppointmentCancelTokens,
  setPatientBackendRefs,
  snapshotActivePatientIdentity,
  type AppointmentLoadStatus,
  type CallState,
  type PatientIdentitySnapshot,
  type StoredCallerAppointment,
} from "../state/call-state.js";
import {
  appointmentStatusFromResult,
  extractAppointments,
} from "./appointment-state.js";
import {
  ensureRoutineVisionOffice,
  getAmdOfficeForToolCall,
} from "./scheduling.js";

export type PatientResolveArgs = {
  firstName?: string;
  lastName?: string;
  dob?: string;
};

export type BuiltPatientResolveRequest = {
  body: Record<string, unknown>;
  callerPhone: string | null;
  usesCallerPhone: boolean;
  usesFullIdentity: boolean;
};

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
};

export function restoreConfirmedPreCallCaller(state: CallState): void {
  const preCall = state.preCall;
  if (
    preCall?.status !== "single_match_confirmed" &&
    preCall?.status !== "multiple_match_confirmed"
  ) {
    return;
  }
  const selectedRef = preCall.selectedCandidateRef ?? CALLER_CANDIDATE_REF;
  const candidate = preCall.candidates.find(
    (candidate) => candidate.ref === selectedRef,
  );
  if (!candidate?.patientId) return;
  applyPreCallCandidateToState(state, candidate);
}

export function confirmPendingPreCallCallerFromVerifyArgs(
  state: CallState,
  args: PatientResolveArgs,
): void {
  if (!args.firstName) return;
  const preCall = state.preCall;
  if (preCall?.status !== "single_match_pending_confirmation") return;
  if (preCall.candidates.length !== 1) return;
  const [candidate] = preCall.candidates;
  if (candidate?.ref !== CALLER_CANDIDATE_REF) return;
  if (
    identityArgConflicts(candidate.lastName, args.lastName) ||
    identityArgConflicts(candidate.dob, args.dob)
  ) {
    return;
  }

  preCall.status = "single_match_confirmed";
  applyPreCallCandidateToState(state, candidate);
}

export function buildPatientResolveRequest(
  state: CallState,
  args: PatientResolveArgs,
): BuiltPatientResolveRequest {
  const callerPhone = runtimeCallerPhone(state).trim() || null;
  const usesFullIdentity = Boolean(args.lastName && args.dob);
  const usesCallerPhone = Boolean(
    callerPhone && args.firstName && !usesFullIdentity,
  );
  const body: Record<string, unknown> = {};
  if (args.firstName) body.firstName = args.firstName;
  if (args.lastName) body.lastName = args.lastName;
  if (args.dob) body.dob = args.dob;
  if (usesCallerPhone && callerPhone) body.phone = callerPhone;
  return { body, callerPhone, usesCallerPhone, usesFullIdentity };
}

export async function resolvePatientForCall(
  state: CallState,
  request: BuiltPatientResolveRequest,
): Promise<PatientResolveResult> {
  ensureRoutineVisionOffice(state);
  return resolvePatientByOffice(getAmdOfficeForToolCall(state), request.body, {
    fallbackPhone: request.usesCallerPhone ? request.callerPhone : null,
  });
}

export function applyResolvedPatientToState(
  state: CallState,
  result: PatientResolveVerified,
): void {
  applyPatientPayloadToState(state, {
    status: result.status,
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
    rawAppointments: result.appointments,
  });
}

export function applyPatientResult(state: CallState, result: any): void {
  const extractedAppointments = extractAppointments(result);
  const appointmentsStatus = appointmentStatusFromResult(
    result,
    extractedAppointments,
  );
  applyPatientPayloadToState(state, {
    status: result.status ?? null,
    patientId: result.patientId ?? null,
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
    appointmentsStatus,
    rawAppointments: extractedAppointments ?? [],
  });
}

export function publicPatientResolveResult(
  result: PatientResolveResult,
  request?: Pick<BuiltPatientResolveRequest, "usesFullIdentity">,
) {
  if (result.status === "verified") {
    return {
      status: "verified",
      patient: {
        id: result.patientId,
        name: result.name,
        dob: result.dob,
        insuranceCarrier: result.insuranceCarrier,
        routing: result.routing,
        routingAmbiguous: result.routingAmbiguous,
        preauthRequired: result.preauthRequired,
      },
      appointments: {
        status: result.appointmentsStatus,
        ...(result.appointmentsMessage
          ? { message: result.appointmentsMessage }
          : {}),
        items: publicCallerAppointments(result.appointments),
      },
      next: "continue",
    };
  }
  if (result.status === "multiple_matches") {
    return {
      status: "multiple_matches",
      message: result.message,
      matches: result.matches.flatMap(publicMultiplePatientMatch),
      next: "ask_first_name",
    };
  }
  if (result.status === "not_found") {
    return {
      status: "not_found",
      message: result.message,
      next: request?.usesFullIdentity
        ? "ask_spelled_name_or_register"
        : "ask_last_name_and_dob",
    };
  }
  return {
    status: "error",
    message: result.message,
    next: "retry",
  };
}

export function clearSessionPatientRecord(state: CallState): void {
  state.private.patientBackend = {};
  state.private.appointments = {};
  state.patient = {
    ...state.patient,
    status: "unknown",
    identityConfirmed: false,
    patientId: null,
    name: null,
    dob: null,
    phone: null,
    appointments: [],
    appointmentsStatus: null,
  };
}

export function changedKnownIdentityValue(
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

function applyPreCallCandidateToState(
  state: CallState,
  candidate: NonNullable<CallState["preCall"]>["candidates"][number],
): void {
  if (!candidate.patientId) return;
  state.patient = {
    ...state.patient,
    status: "verified",
    identityConfirmed: true,
    patientId: candidate.patientId,
    name: [candidate.firstName, candidate.lastName].filter(Boolean).join(" "),
    dob: candidate.dob ?? null,
    insurance: candidate.insuranceCarrier
      ? {
          plan: candidate.insuranceCarrier,
          canonicalPlan: candidate.insuranceCarrier,
          coverageType:
            candidate.routing === "optical_only" ? "routine_vision" : null,
          currentCarrier: candidate.insuranceCarrier,
        }
      : state.patient.insurance,
    appointments: candidate.appointments,
    appointmentsStatus: candidate.appointmentsStatus ?? null,
  };
  setAppointmentCancelTokens(state, candidate.appointmentCancelTokens);
  setPatientBackendRefs(state, {
    insPlanId: candidate.insPlanId ?? null,
    respPartyId: candidate.respPartyId ?? null,
  });
  state.scheduling.routing = normalizeSchedulingRouting(candidate.routing);
  state.scheduling.allowedProviders = candidate.allowedProviders ?? [];
  state.scheduling.routingAmbiguous = candidate.routingAmbiguous ?? false;
  state.scheduling.preauthRequired = candidate.preauthRequired ?? false;
}

function applyPatientPayloadToState(
  state: CallState,
  payload: PatientStatePayload,
): void {
  const rawAppointments = payload.rawAppointments ?? [];
  const appointments = publicCallerAppointments(rawAppointments);
  const patientIdentityBefore = snapshotActivePatientIdentity(state);
  const invalidatePatientState = shouldInvalidatePatientScopedState(
    patientIdentityBefore,
    payload,
  );

  if (invalidatePatientState) {
    clearAvailabilitySelection(state);
  }
  setPatientBackendRefs(state, {
    insPlanId: payload.insPlanId ?? null,
    respPartyId: payload.respPartyId ?? null,
  });
  setAppointmentCancelTokens(state, appointmentCancelTokenMap(rawAppointments));
  const coverageType =
    payload.routing === "optical_only" ? "routine_vision" : undefined;
  const routing = normalizeSchedulingRouting(payload.routing);
  state.patient = {
    ...state.patient,
    status:
      String(payload.status ?? "").toLowerCase() === "created"
        ? "created"
        : payload.patientId
          ? "verified"
          : state.patient.status,
    identityConfirmed: Boolean(payload.patientId),
    patientId: payload.patientId ?? null,
    name: payload.name ?? null,
    dob: payload.dob ?? null,
    phone: payload.phone ?? null,
    appointments,
    appointmentsStatus: payload.appointmentsStatus ?? null,
    insurance: payload.insuranceCarrier
      ? {
          plan: payload.insuranceCarrier,
          coverageType,
          canonicalPlan: payload.insuranceCarrier,
          currentCarrier: payload.insuranceCarrier,
        }
      : state.patient.insurance,
  };
  state.checkedInsurance = {
    plan: payload.insuranceCarrier ?? state.checkedInsurance.plan,
    canonicalPlan:
      payload.insuranceCarrier ?? state.checkedInsurance.canonicalPlan,
    coverageType: coverageType ?? state.checkedInsurance.coverageType,
    currentCarrier:
      payload.insuranceCarrier ?? state.checkedInsurance.currentCarrier,
  };
  state.scheduling.routing = routing;
  state.scheduling.allowedProviders = payload.allowedProviders ?? [];
  state.scheduling.routingAmbiguous = payload.routingAmbiguous ?? false;
  state.scheduling.preauthRequired = payload.preauthRequired ?? false;
  state.scheduling.coverageType = coverageType ?? state.scheduling.coverageType;
  if (coverageType === "routine_vision") {
    state.scheduling.visitType = "routine_vision";
  }
}

function shouldInvalidatePatientScopedState(
  previousIdentity: PatientIdentitySnapshot,
  result: {
    patientId?: string | null;
    name?: string | null;
    dob?: string | null;
  },
): boolean {
  if (sameKnownIdentityValue(previousIdentity.patientId, result.patientId)) {
    return false;
  }
  return (
    changedKnownIdentityValue(previousIdentity.patientId, result.patientId) ||
    changedKnownIdentityValue(previousIdentity.name, result.name) ||
    changedKnownIdentityValue(previousIdentity.dob, result.dob)
  );
}

function publicMultiplePatientMatch(
  match: Extract<
    PatientResolveResult,
    { status: "multiple_matches" }
  >["matches"][number],
): Array<{ firstName: string }> {
  if ("firstName" in match && match.firstName) {
    return [{ firstName: match.firstName }];
  }
  if (!("status" in match)) return [];
  const firstName = firstNameFromPatientName(match.name);
  return firstName ? [{ firstName }] : [];
}

function firstNameFromPatientName(name: string | null): string | undefined {
  if (!name) return undefined;
  const [, firstAndMiddle] = name
    .split(",", 2)
    .map((part) => part.trim())
    .filter(Boolean);
  if (firstAndMiddle) return firstAndMiddle.split(/\s+/).filter(Boolean)[0];
  return name.trim().split(/\s+/).filter(Boolean)[0];
}

function identityArgConflicts(
  existing: string | undefined,
  next: string | undefined,
): boolean {
  if (!existing || !next) return false;
  return normalizeIdentityValue(existing) !== normalizeIdentityValue(next);
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
