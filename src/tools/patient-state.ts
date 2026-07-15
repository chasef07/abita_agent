import {
  type PatientResolveResult,
  type PatientResolveVerified,
  resolvePatientByOffice,
} from "../clients/advancedmd-client.js";
import { activatePreloadedCandidate } from "../identity/preloaded-patient.js";
import { publicCallerAppointments } from "../state/appointments.js";
import {
  CALLER_CANDIDATE_REF,
  type AppointmentLoadStatus,
  type CallState,
  type StoredCallerAppointment,
} from "../state/call-state.js";
import { activatePatient } from "../state/identity.js";
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
  activatePatient(state, {
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
    appointments: publicCallerAppointments(result.appointments),
  });
}

export function applyPatientResult(
  state: CallState,
  result: PatientStatePayload & { appointments?: StoredCallerAppointment[] },
): void {
  const patientId = result.patientId?.trim();
  if (!patientId) return;
  const extractedAppointments = extractAppointments(result);
  const appointmentsStatus = appointmentStatusFromResult(
    result,
    extractedAppointments,
  );
  activatePatient(state, {
    status:
      String(result.status ?? "").toLowerCase() === "created"
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
    appointmentsStatus,
    appointments: publicCallerAppointments(extractedAppointments),
  });
}
