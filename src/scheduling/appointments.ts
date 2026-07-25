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
  type AppointmentLoadStatus,
  type CallState,
  type CallerAppointment,
  type StoredAvailabilitySlot,
  type StoredCallerAppointment,
} from "../state/call-state.js";
import { activePatientId } from "../state/identity.js";
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
): void {
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
}

export interface CancellationAppointmentSelector {
  appointmentId?: number;
  appointmentDate?: string;
  appointmentTime?: string;
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
    const index = appointments.findIndex(
      (appointment, index) => oldAppointmentRefFor(appointment, index) === ref,
    );
    if (index >= 0)
      return { status: "selected", appointment: appointments[index] };
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
  if (selector.appointmentId !== undefined) {
    const appointment = activeAppointmentById(state, selector.appointmentId);
    if (appointment) return { status: "selected", appointment };
    return {
      status: "not_found",
      message:
        "No loaded appointment matches that appointment ID. Load appointments again and confirm the exact appointment before cancelling.",
    };
  }

  const selectorResult = appointmentSelectedByDateTime(state, selector);
  if (selectorResult) {
    return selectorResult;
  }

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

  const appointments = activeAppointments(state);
  if (appointments.length === 1) {
    return { status: "selected", appointment: appointments[0] };
  }

  if (appointments.length > 1) {
    return {
      status: "ambiguous",
      message: appointmentClarificationMessage(
        "Which appointment should I cancel?",
        appointments,
      ),
    };
  }

  return {
    status: "not_found",
    message:
      "Load appointments and confirm the exact appointment before cancelling.",
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

  if (selector.appointmentId !== undefined) {
    return (
      cancelledAppointments.find(
        (appointment) => appointment.id === selector.appointmentId,
      ) ?? null
    );
  }

  const dateText = selector.appointmentDate?.trim();
  const timeText = selector.appointmentTime?.trim();
  if (dateText || timeText) {
    const date = dateText ? parseDateParts(dateText) : null;
    const time = timeText ? parseTimeParts(timeText) : null;
    if ((dateText && !date) || (timeText && !time)) return null;

    const matches = cancelledAppointments.filter((appointment) => {
      if (date && !appointmentDateMatches(appointment.date, date)) return false;
      if (time && !appointmentTimeMatches(appointment.time, time)) return false;
      return true;
    });
    return matches.length === 1 ? matches[0] : null;
  }

  return cancelledAppointments.length === 1 ? cancelledAppointments[0] : null;
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

function appointmentSelectedByDateTime(
  state: CallState,
  selector: CancellationAppointmentSelector,
): CancellationAppointmentSelection | null {
  const dateText = selector.appointmentDate?.trim();
  const timeText = selector.appointmentTime?.trim();
  if (!dateText && !timeText) return null;

  const date = dateText ? parseDateParts(dateText) : null;
  if (dateText && !date) {
    return {
      status: "not_found",
      message:
        "I could not match that appointment date. Use one of the loaded appointment dates before cancelling.",
    };
  }
  const time = timeText ? parseTimeParts(timeText) : null;
  if (timeText && !time) {
    return {
      status: "not_found",
      message:
        "I could not match that appointment time. Use one of the loaded appointment times before cancelling.",
    };
  }

  const matches = activeAppointments(state).filter((appointment) => {
    if (date && !appointmentDateMatches(appointment.date, date)) return false;
    if (time && !appointmentTimeMatches(appointment.time, time)) return false;
    return true;
  });

  if (matches.length === 1) {
    return { status: "selected", appointment: matches[0] };
  }
  if (matches.length > 1) {
    return {
      status: "ambiguous",
      message: appointmentClarificationMessage(
        "I found more than one matching appointment.",
        matches,
      ),
    };
  }
  return {
    status: "not_found",
    message:
      "No loaded appointment matches those details. Load appointments again or ask which loaded appointment to cancel.",
  };
}

interface DateParts {
  month: number;
  day: number;
  year?: number;
}

interface TimeParts {
  hour: number;
  minute: number;
  meridiem?: "am" | "pm";
}

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

const WEEKDAYS = new Set([
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
]);

function parseDateParts(value: string): DateParts | null {
  const normalized = value
    .toLowerCase()
    .replace(/\b(\d{1,2})(st|nd|rd|th)\b/g, "$1")
    .replace(/[,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const iso = normalized.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) {
    return {
      year: Number(iso[1]),
      month: Number(iso[2]),
      day: Number(iso[3]),
    };
  }

  const slash = normalized.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (slash) {
    const year = slash[3] ? Number(normalizeYear(slash[3])) : undefined;
    return { month: Number(slash[1]), day: Number(slash[2]), year };
  }

  const tokens = normalized
    .split(" ")
    .filter((token) => token && !WEEKDAYS.has(token));
  for (let i = 0; i < tokens.length; i += 1) {
    const month = MONTHS[tokens[i]];
    if (!month) continue;
    const day = Number(tokens[i + 1]);
    if (!Number.isInteger(day) || day < 1 || day > 31) return null;
    const rawYear = tokens[i + 2];
    const year =
      rawYear && /^\d{2,4}$/.test(rawYear)
        ? Number(normalizeYear(rawYear))
        : undefined;
    return { month, day, year };
  }

  return null;
}

function normalizeYear(value: string): string {
  return value.length === 2 ? `20${value}` : value;
}

function appointmentDateMatches(
  appointmentDate: string,
  selectorDate: DateParts,
): boolean {
  const appointment = parseDateParts(appointmentDate);
  if (!appointment) return false;
  if (
    selectorDate.year !== undefined &&
    appointment.year !== undefined &&
    appointment.year !== selectorDate.year
  ) {
    return false;
  }
  return (
    appointment.month === selectorDate.month &&
    appointment.day === selectorDate.day
  );
}

function parseTimeParts(value: string): TimeParts | null {
  const normalized = value
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/\s+/g, " ")
    .trim();
  const match = normalized.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
  if (!match) return null;

  let hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  let meridiem = match[3] as "am" | "pm" | undefined;
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute > 59) {
    return null;
  }
  if (!meridiem && hour > 12 && hour <= 23) {
    meridiem = hour >= 12 ? "pm" : "am";
    hour = hour % 12 || 12;
  }
  if (hour < 1 || hour > 12) return null;
  return { hour, minute, meridiem };
}

function appointmentTimeMatches(
  appointmentTime: string,
  selectorTime: TimeParts,
): boolean {
  const appointment = parseTimeParts(appointmentTime);
  if (!appointment) return false;
  if (
    selectorTime.meridiem &&
    appointment.meridiem &&
    selectorTime.meridiem !== appointment.meridiem
  ) {
    return false;
  }
  return (
    appointment.hour === selectorTime.hour &&
    appointment.minute === selectorTime.minute
  );
}

function appointmentClarificationMessage(
  prefix: string,
  appointments: CallerAppointment[],
): string {
  const choices = appointments.slice(0, 3).map(spokenAppointment).join("; ");
  const remaining = appointments.length - 3;
  const more = remaining > 0 ? `; and ${remaining} more` : "";
  return `${prefix} Loaded appointments: ${choices}${more}.`;
}

function rescheduleAppointmentClarificationMessage(
  appointments: CallerAppointment[],
): string {
  const choices = appointments
    .map(
      (appointment, index) =>
        `${oldAppointmentRefFor(appointment, index)}: ${spokenAppointment(appointment)}`,
    )
    .join("; ");
  return `Which loaded appointment should I reschedule? Ask the caller to choose one, then call reschedule_appointment again only with the matching oldAppointmentRef from: ${choices}. Do not call reschedule_appointment again without oldAppointmentRef.`;
}

function oldAppointmentRefFor(
  appointment: CallerAppointment,
  index: number,
): string {
  return `old-appointment-${index + 1}-${appointmentRefDigest(appointment)}`;
}

function appointmentRefDigest(appointment: CallerAppointment): string {
  const source = [
    appointment.id,
    appointment.date,
    appointment.time,
    appointment.provider,
    appointment.type,
    appointment.facility,
  ].join("|");
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
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
