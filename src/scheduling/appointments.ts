import { getOfficeProfile } from "../customers/abita/profile.js";
import { activeOfficeKey } from "../state/call-lifecycle.js";
import {
  activeAppointments,
  completedCancellations,
  latestBookedAppointmentId,
  replaceActiveAppointments,
  setLatestBookedAppointment,
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
import type { BookingSuccess } from "./middleware.js";

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
  return state.identity.patient.appointments.find(
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
    facility,
    confirmed: true,
  };
  const nextAppointments = [
    ...activeAppointments(state).filter((item) => item.id !== appointmentId),
    appointment,
  ];
  replaceActiveAppointments(state, nextAppointments, "found");
  setLatestBookedAppointment(state, appointmentId);
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

type RescheduleAppointmentSelectionOptions = {
  preferLatestBooked?: boolean;
};

export function rescheduleAppointmentForState(
  state: CallState,
  oldAppointmentRef?: string,
  options: RescheduleAppointmentSelectionOptions = {},
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
          "More than one loaded appointment has that oldAppointmentRef. Load appointments again and confirm the exact appointment before rescheduling.",
      };
    }
    return {
      status: "not_found",
      message:
        "No loaded appointment matches that oldAppointmentRef. Ask which loaded appointment to reschedule.",
    };
  }

  if (options.preferLatestBooked) {
    const latestBookedId = latestBookedAppointmentId(state);
    if (latestBookedId !== null) {
      const latestBookedAppointment = activeAppointmentById(
        state,
        latestBookedId,
      );
      if (latestBookedAppointment) {
        return { status: "selected", appointment: latestBookedAppointment };
      }
    }
  }

  if (appointments.length === 1) {
    return { status: "selected", appointment: appointments[0] };
  }

  if (appointments.length > 1) {
    return {
      status: "ambiguous",
      message: rescheduleAppointmentClarificationMessage(appointments),
    };
  }

  return {
    status: "not_found",
    message:
      "Load appointments and confirm the exact appointment before rescheduling.",
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
      message:
        "Pass the appointmentRef shown with the caller-confirmed loaded appointment before cancelling.",
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
        "More than one loaded appointment has that appointmentRef. Load appointments again and confirm the exact appointment before cancelling.",
    };
  }
  return {
    status: "not_found",
    message:
      "No loaded appointment matches that appointmentRef. Use the appointmentRef shown with the current loaded appointment.",
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

function rescheduleAppointmentClarificationMessage(
  appointments: CallerAppointment[],
): string {
  const choices = appointments
    .map(
      (appointment) =>
        `${appointment.appointmentRef}: ${spokenAppointment(appointment)}`,
    )
    .join("; ");
  return `Which loaded appointment should I reschedule? Ask the caller to choose one, then call reschedule_appointment again only with the matching oldAppointmentRef from: ${choices}. Do not call reschedule_appointment again without oldAppointmentRef.`;
}

function spokenAppointment(appointment: CallerAppointment): string {
  return [
    appointment.date,
    appointment.time ? `at ${appointment.time}` : "",
    appointment.provider ? `with ${appointment.provider}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}
