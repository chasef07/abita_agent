import {
  ownedMiddleware,
  type PatientResolveResult,
  type PatientResolveVerified,
} from "../clients/owned-middleware.js";
import { publicCallerAppointments } from "../state/appointments.js";
import {
  type AppointmentLoadStatus,
  type CallState,
  type StoredCallerAppointment,
} from "../state/call-state.js";
import { activatePatient } from "../state/identity.js";
import {
  appointmentStatusFromResult,
  extractAppointments,
} from "../scheduling/appointments.js";
import { getAmdOfficeForToolCall } from "../scheduling/routing.js";

type PatientResolveRequest = {
  body: {
    firstName: string;
    lastName: string;
    dob: string;
  };
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

export async function resolvePatientForCall(
  state: CallState,
  request: PatientResolveRequest,
): Promise<PatientResolveResult> {
  const { firstName, lastName, dob } = request.body;
  return ownedMiddleware().resolvePatient({
    office: getAmdOfficeForToolCall(state),
    identity: { firstName, lastName, dob },
  });
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
  const resultStatus = String(result.status ?? "").toLowerCase();
  activatePatient(state, {
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
    appointmentsStatus,
    appointments: publicCallerAppointments(extractedAppointments),
  });
}
