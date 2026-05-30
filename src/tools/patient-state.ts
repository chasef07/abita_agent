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

type PatientResolveRequest = {
  body: Record<string, unknown>;
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

export async function resolvePatientForCall(
  state: CallState,
  request: PatientResolveRequest,
): Promise<PatientResolveResult> {
  ensureRoutineVisionOffice(state);
  return resolvePatientByOffice(getAmdOfficeForToolCall(state), request.body);
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
