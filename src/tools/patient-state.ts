import {
  type PatientResolveResult,
  type PatientResolveVerified,
  resolvePatientByOffice,
} from "../clients/advancedmd-client.js";
import { activatePreloadedCandidate } from "../identity/preloaded-patient.js";
import {
  CALLER_CANDIDATE_REF,
  insuranceSnapshot,
  publicCallerAppointments,
  resetPatientScopedBookingState,
  setInsuranceOnFile,
  setPatientBackendRefs,
  setRoutingContext,
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
import { getAmdOfficeForToolCall } from "./scheduling.js";

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
  const preCall = state.identity.preCall;
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
  if (
    state.identity.patient.identityConfirmed ||
    state.identity.patient.status === "created"
  ) {
    return;
  }
  activatePreloadedCandidate(state, candidate, "confirmed_by_identity_tool");
}

export async function resolvePatientForCall(
  state: CallState,
  request: PatientResolveRequest,
): Promise<PatientResolveResult> {
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
    resetPatientScopedBookingState(state);
  }
  setPatientBackendRefs(state, {
    insPlanId: payload.insPlanId ?? null,
    respPartyId: payload.respPartyId ?? null,
  });
  const coverageType =
    payload.routing === "optical_only" ? "routine_vision" : undefined;
  state.identity.patient = {
    ...state.identity.patient,
    status:
      String(payload.status ?? "").toLowerCase() === "created"
        ? "created"
        : payload.patientId
          ? "verified"
          : state.identity.patient.status,
    identityConfirmed: Boolean(payload.patientId),
    patientId: payload.patientId ?? null,
    name: payload.name ?? null,
    dob: payload.dob ?? null,
    phone: payload.phone ?? null,
    appointments,
    appointmentsStatus: payload.appointmentsStatus ?? null,
  };
  setInsuranceOnFile(
    state,
    payload.insuranceCarrier
      ? insuranceSnapshot({
          plan: payload.insuranceCarrier,
          canonicalPlan: payload.insuranceCarrier,
          coverageType: coverageType ?? null,
          currentCarrier: payload.insuranceCarrier,
        })
      : null,
  );
  setRoutingContext(state, {
    routing: payload.routing,
    allowedProviders: payload.allowedProviders,
    routingAmbiguous: payload.routingAmbiguous,
    preauthRequired: payload.preauthRequired,
  });
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
