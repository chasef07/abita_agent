import { getOfficeProfile } from "../customers/abita/profile.js";
import { activeOfficeKey } from "../state/call-lifecycle.js";
import {
  activeAppointments,
  completedCancellations,
  replaceActiveAppointments,
} from "../state/appointments.js";
import {
  activePatientId,
  type AppointmentLoadStatus,
  type CallState,
  type CallerAppointment,
  type StoredAvailabilitySlot,
  type StoredCallerAppointment,
} from "../state/call-state.js";
import { publicProviderName } from "./availability.js";
import type { BookingSuccess } from "./booking.js";
import { visitTypeForAppointment } from "./routing.js";
import { spokenAppointmentDate } from "./spoken-date.js";

export function currentAppointmentReferences(state: CallState): string {
  const references = activeAppointments(state).flatMap((appointment) => {
    if (!appointment.appointmentRef) return [];
    const description = spokenAppointmentDescription(appointment);
    return [
      `${description} (appointmentRef ${appointment.appointmentRef}, visitType ${visitTypeForAppointment(appointment)})`,
    ];
  });
  return references.length
    ? `Internal appointment references (do not read aloud): ${references.join("; ")}.`
    : "";
}

export function spokenAppointmentDescription(
  appointment: CallerAppointment,
): string {
  return [
    spokenAppointmentDate(appointment.date),
    appointment.time ? `at ${appointment.time}` : "",
    appointment.provider ? `with ${appointment.provider}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

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

function activeAppointmentById(
  state: CallState,
  appointmentId: number,
): CallerAppointment | undefined {
  return state.identity.activePatient?.appointments.find(
    (appointment) => appointment.id === appointmentId,
  );
}

export function recordBookedAppointmentInState(
  state: CallState,
  selectedSlot: StoredAvailabilitySlot,
  result: BookingSuccess,
): string {
  const appointmentId = result.appointmentId;
  const provider = result.providerName
    ? publicProviderName(result.providerName)
    : selectedSlot.provider;
  const facility =
    result.locationName ?? getOfficeProfile(activeOfficeKey(state)).displayName;
  const type = result.appointmentTypeName ?? "Appointment";
  const appointmentTypeId = result.appointmentTypeId;
  const appointment: CallerAppointment = {
    id: appointmentId,
    date: selectedSlot.date,
    time: selectedSlot.time,
    provider,
    type,
    ...(appointmentTypeId !== undefined ? { appointmentTypeId } : {}),
    ...(result.rescheduleToken
      ? { rescheduleToken: result.rescheduleToken }
      : {}),
    facility,
    confirmed: true,
  };
  const nextAppointments = [
    ...activeAppointments(state).filter((item) => item.id !== appointmentId),
    appointment,
  ];
  replaceActiveAppointments(state, nextAppointments, "found");
  const appointmentRef = activeAppointmentById(
    state,
    appointmentId,
  )?.appointmentRef;
  if (!appointmentRef) {
    throw new Error("Booked appointment reference was not recorded.");
  }
  return appointmentRef;
}

export interface CancellationAppointmentSelector {
  appointmentRef: string;
}

export type CancellationAppointmentSelection =
  | { status: "selected"; appointment: CallerAppointment }
  | { status: "ambiguous"; message: string }
  | { status: "not_found"; message: string };

export function rescheduleAppointmentForState(
  state: CallState,
  oldAppointmentRef: string,
): CancellationAppointmentSelection {
  const appointments = activeAppointments(state);
  const ref = oldAppointmentRef?.trim();

  if (ref) {
    const matches = appointments.filter(
      (appointment) => appointment.appointmentRef === ref,
    );
    if (matches.length === 1) {
      return { status: "selected", appointment: matches[0] };
    }
    if (matches.length > 1) {
      return {
        status: "ambiguous",
        message:
          "I need to reload the appointments and confirm the exact one before rescheduling.",
      };
    }
    return {
      status: "not_found",
      message:
        "I couldn't match that appointment. Which upcoming appointment would you like to reschedule?",
    };
  }

  return {
    status: "not_found",
    message: "Which upcoming appointment would you like to reschedule?",
  };
}

export function cancellationAppointmentForState(
  state: CallState,
  selector: CancellationAppointmentSelector,
): CancellationAppointmentSelection {
  const appointmentRef = selector.appointmentRef?.trim();
  if (!appointmentRef) {
    return {
      status: "not_found",
      message: "Which upcoming appointment would you like to cancel?",
    };
  }
  const matches = activeAppointments(state).filter(
    (appointment) => appointment.appointmentRef === appointmentRef,
  );
  if (matches.length === 1) {
    return { status: "selected", appointment: matches[0] };
  }
  if (matches.length > 1) {
    return {
      status: "ambiguous",
      message:
        "I need to reload the appointments and confirm the exact one before cancelling.",
    };
  }
  return {
    status: "not_found",
    message:
      "I couldn't match that appointment. Which upcoming appointment would you like to cancel?",
  };
}

export function completedCancellationForState(
  state: CallState,
  selector: CancellationAppointmentSelector,
): CallerAppointment | null {
  const patientId = activePatientId(state);
  if (!patientId) return null;
  const cancelledAppointments = completedCancellations(state)
    .filter((item) => item.patientId === patientId)
    .map((item) => item.appointment);
  if (cancelledAppointments.length === 0) return null;
  const appointmentRef = selector.appointmentRef?.trim();
  if (!appointmentRef) return null;
  const matches = cancelledAppointments.filter(
    (appointment) => appointment.appointmentRef === appointmentRef,
  );
  return matches.length === 1 ? matches[0] : null;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
