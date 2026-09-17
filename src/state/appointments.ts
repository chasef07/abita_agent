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
      officeId,
      office,
      visitType,
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
        officeId,
        office,
        visitType,
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
  const patient = state.identity.activePatient;
  const patientId = activePatientId(state);
  if (!patient || !patientId) return [];
  const cancelled = new Set(
    state.identity.completedCancellations
      .filter((item) => item.patientId === patientId)
      .map((item) => item.appointment.id),
  );
  const appointments = [...patient.appointments];
  const booking =
    state.identity.completedBookingsByPatientId[patientId]?.appointment;
  const reschedule = state.identity.completedReschedulesByPatientId[patientId];
  const receipts = [
    ...(booking ? [booking] : []),
    ...(reschedule?.appointments ?? []),
  ];
  for (const appointment of receipts) {
    if (!appointments.some((item) => item.id === appointment.id))
      appointments.push(appointment);
  }
  patient.appointments = normalizeCallerAppointments(
    appointments.filter((item) => !cancelled.has(item.id)),
    patientId,
  );
  if (patient.appointments.length) patient.appointmentsStatus = "found";
  else if (cancelled.size && patient.appointmentsStatus === "found")
    patient.appointmentsStatus = "none";
  return patient.appointments;
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
  const patient = state.identity.activePatient;
  if (!patient) return;
  patient.appointments = patient.appointments.filter(
    (item) => item.id !== appointmentId,
  );
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
  appointment?: CallerAppointment,
): void {
  const previous = state.identity.completedReschedulesByPatientId[patientId];
  const appointments = [...(previous?.appointments ?? [])];
  if (appointment) appointments.push(appointment);
  state.identity.completedReschedulesByPatientId[patientId] = {
    ...reschedule,
    appointments,
  };
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
    | "officeId"
    | "visitType"
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
    appointment.officeId ?? null,
    appointment.visitType ?? null,
  ]);
  const digest = createHash("sha256").update(source).digest("hex").slice(0, 24);
  return `appointment-${digest}`;
}
