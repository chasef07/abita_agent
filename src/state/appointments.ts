import { createHash } from "node:crypto";
import type {
  AppointmentLoadStatus,
  CallState,
  CallerAppointment,
  CompletedBookingState,
  CompletedCancellationState,
  CompletedRescheduleState,
  StoredCallerAppointment,
} from "./call-state.js";
import { activePatientId } from "./call-state.js";

export function normalizeCallerAppointments(
  appointments: readonly StoredCallerAppointment[] | null | undefined,
  patientId: string | null | undefined,
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
      cancellationToken,
      rescheduleToken,
    }) => {
      const appointment = {
        id,
        date,
        time,
        provider,
        type,
        ...(appointmentTypeId !== undefined ? { appointmentTypeId } : {}),
        facility,
        confirmed,
        ...(cancellationToken?.trim()
          ? { cancellationToken: cancellationToken.trim() }
          : {}),
        ...(rescheduleToken?.trim()
          ? { rescheduleToken: rescheduleToken.trim() }
          : {}),
      };
      const owner = patientId?.trim();
      return {
        ...appointment,
        ...(owner
          ? { appointmentRef: appointmentRefForPatient(owner, appointment) }
          : {}),
      };
    },
  );
}

export function activeAppointments(state: CallState): CallerAppointment[] {
  return normalizeCallerAppointments(
    state.identity.activePatient?.appointments,
    activePatientId(state),
  );
}

export function activeAppointmentsStatus(
  state: CallState,
): AppointmentLoadStatus | null {
  return state.identity.activePatient?.appointmentsStatus ?? null;
}

export function replaceActiveAppointments(
  state: CallState,
  appointments: CallerAppointment[],
  status: AppointmentLoadStatus | null,
): void {
  const patient = state.identity.activePatient;
  if (!patient) return;
  patient.appointments = normalizeCallerAppointments(
    appointments,
    activePatientId(state),
  );
  patient.appointmentsStatus = status;
}

export function removeActiveAppointment(
  state: CallState,
  appointmentId: number,
): void {
  const appointment = activeAppointments(state).find(
    (item) => item.id === appointmentId,
  );
  const patientId = activePatientId(state);
  if (appointment && patientId) {
    recordCompletedCancellationForPatient(state, patientId, appointment);
  }
  removeBookedAppointmentReference(state, appointmentId);
  const patient = state.identity.activePatient;
  if (!patient) return;
  patient.appointments = patient.appointments.filter(
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

export function recordCompletedCancellationForPatient(
  state: CallState,
  patientId: string,
  appointment: CallerAppointment,
): void {
  if (
    state.identity.completedBookingsByPatientId[patientId]?.appointmentId ===
    appointment.id
  ) {
    delete state.identity.completedBookingsByPatientId[patientId];
  }
  state.identity.completedCancellations = [
    ...state.identity.completedCancellations.filter(
      (item) =>
        item.patientId !== patientId || item.appointment.id !== appointment.id,
    ),
    { patientId, appointment },
  ];
}

export function completedBookingForPatient(
  state: CallState,
  patientId: string,
): CompletedBookingState | null {
  return state.identity.completedBookingsByPatientId[patientId] ?? null;
}

export function recordCompletedBookingForPatient(
  state: CallState,
  patientId: string,
  booking: CompletedBookingState,
): void {
  state.identity.completedBookingsByPatientId[patientId] = booking;
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

export function appointmentRefForPatient(
  patientId: string,
  appointment: Pick<
    CallerAppointment,
    | "id"
    | "date"
    | "time"
    | "provider"
    | "type"
    | "appointmentTypeId"
    | "facility"
  >,
): string {
  const source = JSON.stringify([
    patientId,
    appointment.id,
    appointment.date,
    appointment.time,
    appointment.provider,
    appointment.type,
    appointment.appointmentTypeId ?? null,
    appointment.facility,
  ]);
  const digest = createHash("sha256").update(source).digest("hex").slice(0, 24);
  return `appointment-${digest}`;
}
