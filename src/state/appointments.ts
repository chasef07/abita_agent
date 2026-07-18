import type {
  AppointmentLoadStatus,
  CallState,
  CallerAppointment,
  CompletedCancellationState,
  CompletedRescheduleState,
  StoredCallerAppointment,
} from "./call-state.js";
import { activePatientId } from "./identity.js";

export function publicCallerAppointments(
  appointments: readonly StoredCallerAppointment[] | null | undefined,
): CallerAppointment[] {
  return (appointments ?? []).map(
    ({
      id,
      date,
      time,
      provider,
      type,
      appointmentTypeId,
      facility,
      confirmed,
    }) => ({
      id,
      date,
      time,
      provider,
      type,
      ...(appointmentTypeId !== undefined ? { appointmentTypeId } : {}),
      facility,
      confirmed,
    }),
  );
}

export function activeAppointments(state: CallState): CallerAppointment[] {
  return [...state.identity.patient.appointments];
}

export function activeAppointmentsStatus(
  state: CallState,
): AppointmentLoadStatus | null {
  return state.identity.patient.appointmentsStatus ?? null;
}

export function replaceActiveAppointments(
  state: CallState,
  appointments: CallerAppointment[],
  status: AppointmentLoadStatus | null,
): void {
  state.identity.patient.appointments = appointments;
  state.identity.patient.appointmentsStatus = status;
}

export function removeActiveAppointment(
  state: CallState,
  appointmentId: number,
): void {
  const appointment = state.identity.patient.appointments.find(
    (item) => item.id === appointmentId,
  );
  const patientId = activePatientId(state);
  if (appointment && patientId) {
    recordCompletedCancellation(state, patientId, appointment);
  }
  removeBookedAppointmentReference(state, appointmentId);
  state.identity.patient.appointments =
    state.identity.patient.appointments.filter(
      (item) => item.id !== appointmentId,
    );
}

function removeBookedAppointmentReference(
  state: CallState,
  appointmentId: number,
): void {
  if (state.identity.latestBookedAppointmentId === appointmentId) {
    delete state.identity.latestBookedAppointmentId;
  }
}

export function setLatestBookedAppointment(
  state: CallState,
  appointmentId: number,
): void {
  state.identity.latestBookedAppointmentId = appointmentId;
}

export function latestBookedAppointmentId(state: CallState): number | null {
  return state.identity.latestBookedAppointmentId ?? null;
}

function recordCompletedCancellation(
  state: CallState,
  patientId: string,
  appointment: CallerAppointment,
): void {
  state.identity.completedCancellations = [
    ...state.identity.completedCancellations.filter(
      (item) =>
        item.patientId !== patientId || item.appointment.id !== appointment.id,
    ),
    { patientId, appointment },
  ];
}

export function completedCancellations(
  state: CallState,
): CompletedCancellationState[] {
  return [...state.identity.completedCancellations];
}

export function completedRescheduleForPatient(
  state: CallState,
  patientId: string,
): CompletedRescheduleState | null {
  return state.identity.completedReschedulesByPatientId[patientId] ?? null;
}

export function recordCompletedRescheduleForPatient(
  state: CallState,
  patientId: string,
  reschedule: CompletedRescheduleState,
): void {
  state.identity.completedReschedulesByPatientId[patientId] = reschedule;
}
