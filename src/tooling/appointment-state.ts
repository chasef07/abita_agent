import { getOfficeConfig } from "../customer/profile.js";
import {
  ensureActivePatientContext,
  nextFlowEventId,
  reduceFlowEvent,
  type AppointmentLoadStatus,
  type CallerAppointment,
} from "../flow/index.js";
import { resolvePatientByOffice } from "./advancedmd-client.js";
import {
  appointmentCancelTokenMap,
  publicCallerAppointments,
  type CallState,
  type StoredAvailabilitySlot,
  type StoredCallerAppointment,
} from "./call-state.js";
import { publicProviderName } from "./availability-slots.js";

export function extractAppointments(
  result: unknown,
): StoredCallerAppointment[] | null {
  if (Array.isArray(result)) return result as StoredCallerAppointment[];
  if (isRecord(result) && Array.isArray(result.appointments)) {
    return result.appointments as StoredCallerAppointment[];
  }
  return null;
}

export function appointmentStatusFromResult(
  result: unknown,
  appointments: StoredCallerAppointment[] | null,
): AppointmentLoadStatus | null {
  const explicitStatus = extractAppointmentsStatus(result);
  if (explicitStatus) return explicitStatus;
  if (isNoAppointmentsResult(result)) return "none";
  if (appointments) return appointments.length > 0 ? "found" : "none";
  return null;
}

export function activeAppointmentById(
  state: CallState,
  appointmentId: number,
): CallerAppointment | undefined {
  const activePatient = ensureActivePatientContext(state.flow);
  return (
    activePatient.appointments.find(
      (appointment) => appointment.id === appointmentId,
    ) ??
    state.appointments.find((appointment) => appointment.id === appointmentId)
  );
}

export function appointmentIdFromBookingResult(result: unknown): number | null {
  if (!isRecord(result)) return null;
  const appointmentId = result.appointmentId;
  if (typeof appointmentId === "number") return appointmentId;
  if (typeof appointmentId === "string" && /^\d+$/.test(appointmentId)) {
    return Number(appointmentId);
  }
  return null;
}

export function recordBookedAppointmentInState(
  state: CallState,
  selectedSlot: StoredAvailabilitySlot,
  result: unknown,
): void {
  const appointmentId = appointmentIdFromBookingResult(result);
  if (appointmentId === null) return;

  const provider =
    isRecord(result) && typeof result.providerName === "string"
      ? publicProviderName(result.providerName)
      : selectedSlot.provider;
  const facility =
    isRecord(result) && typeof result.locationName === "string"
      ? result.locationName
      : getOfficeConfig(state.officeKey).displayName;
  const type =
    isRecord(result) && typeof result.appointmentTypeName === "string"
      ? result.appointmentTypeName
      : "Appointment";
  const appointment: CallerAppointment = {
    id: appointmentId,
    date: selectedSlot.date,
    time: selectedSlot.time,
    provider,
    type,
    facility,
    confirmed: true,
  };
  state.appointments = [
    ...state.appointments.filter((item) => item.id !== appointmentId),
    appointment,
  ];
  reduceFlowEvent(state.flow, {
    id: nextFlowEventId("active_patient_appointments"),
    type: "active_patient_appointments_recorded",
    source: "tool_result",
    createdAt: Date.now(),
    appointments: [
      ...state.appointments.filter((item) => item.id !== appointmentId),
      appointment,
    ],
    appointmentsStatus: state.appointmentsStatus,
  });
}

export function cancelTokenForAppointment(
  state: CallState,
  appointmentId: number,
): string | null {
  const token = state.appointmentCancelTokens?.[String(appointmentId)];
  return token?.trim() ? token : null;
}

export async function refreshCancelTokenForAppointment(
  state: CallState,
  appointmentId: number,
): Promise<string | null> {
  if (!state.patientId) return null;
  const result = await resolvePatientByOffice(amdOfficePhoneForState(state), {
    patientId: state.patientId,
  });
  if (result.status !== "verified") return null;

  const appointments = publicCallerAppointments(result.appointments);
  state.appointments = appointments;
  state.appointmentsStatus = result.appointmentsStatus;
  state.appointmentCancelTokens = appointmentCancelTokenMap(
    result.appointments,
  );
  reduceFlowEvent(state.flow, {
    id: nextFlowEventId("active_patient_appointments"),
    type: "active_patient_appointments_recorded",
    source: "tool_result",
    createdAt: Date.now(),
    appointments,
    appointmentsStatus: result.appointmentsStatus,
  });
  return cancelTokenForAppointment(state, appointmentId);
}

export function removeAppointmentById(
  state: CallState,
  appointmentId: number,
): void {
  state.appointments = state.appointments.filter(
    (appointment) => appointment.id !== appointmentId,
  );
  if (state.appointmentCancelTokens) {
    delete state.appointmentCancelTokens[String(appointmentId)];
  }
  reduceFlowEvent(state.flow, {
    id: nextFlowEventId("active_patient_appointment_removed"),
    type: "active_patient_appointment_removed",
    source: "tool_result",
    createdAt: Date.now(),
    appointmentId,
  });
}

function extractAppointmentsStatus(
  result: unknown,
): AppointmentLoadStatus | null {
  if (!isRecord(result)) return null;
  const status = result.appointmentsStatus;
  return status === "found" || status === "none" || status === "error"
    ? status
    : null;
}

function isNoAppointmentsResult(result: unknown): boolean {
  return (
    isRecord(result) &&
    (result.status === "no_appointments" ||
      result.appointmentsStatus === "none")
  );
}

function amdOfficePhoneForState(
  state: Pick<CallState, "officeKey" | "amdOfficePhone">,
): string {
  return (
    state.amdOfficePhone || getOfficeConfig(state.officeKey).amdOfficePhone
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
