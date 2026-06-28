import { getOfficeConfig } from "../customer/profile.js";
import {
  activeAppointments,
  activeOfficeKey,
  activePatientId,
  completedCancellations,
  latestBookedAppointmentId,
  recordCompletedCancellation,
  removeBookedAppointmentReference,
  setLatestBookedAppointment,
  type AppointmentLoadStatus,
  type CallState,
  type CallerAppointment,
  type StoredAvailabilitySlot,
  type StoredCallerAppointment,
} from "../state/call-state.js";
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
  return state.identity.patient.appointments.find(
    (appointment) => appointment.id === appointmentId,
  );
}

function appointmentIdFromBookingResult(result: unknown): number | null {
  if (!isRecord(result)) return null;
  const appointmentId = result.appointmentId;
  if (typeof appointmentId === "number") return appointmentId;
  if (typeof appointmentId === "string" && /^\d+$/.test(appointmentId)) {
    return Number(appointmentId);
  }
  return null;
}

function appointmentTypeIdFromBookingResult(
  result: unknown,
): number | undefined {
  if (!isRecord(result)) return undefined;
  const appointmentTypeId = result.appointmentTypeId;
  if (
    typeof appointmentTypeId === "number" &&
    Number.isInteger(appointmentTypeId) &&
    appointmentTypeId > 0
  ) {
    return appointmentTypeId;
  }
  if (
    typeof appointmentTypeId === "string" &&
    /^[1-9]\d*$/.test(appointmentTypeId)
  ) {
    return Number(appointmentTypeId);
  }
  return undefined;
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
      : getOfficeConfig(activeOfficeKey(state)).displayName;
  const type =
    isRecord(result) && typeof result.appointmentTypeName === "string"
      ? result.appointmentTypeName
      : "Appointment";
  const appointmentTypeId = appointmentTypeIdFromBookingResult(result);
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
  state.identity.patient.appointments = nextAppointments;
  state.identity.patient.appointmentsStatus = "found";
  setLatestBookedAppointment(state, appointmentId);
}

export interface CancellationAppointmentSelector {
  appointmentId?: number;
  appointmentDate?: string;
  appointmentTime?: string;
  fallbackToSingleLoadedAppointment?: boolean;
}

export type CancellationAppointmentSelection =
  | { status: "selected"; appointment: CallerAppointment }
  | { status: "ambiguous"; message: string }
  | { status: "not_found"; message: string };

export function cancellationAppointmentForState(
  state: CallState,
  selector: CancellationAppointmentSelector,
): CancellationAppointmentSelection {
  if (selector.appointmentId !== undefined) {
    const appointment = activeAppointmentById(state, selector.appointmentId);
    if (appointment) return { status: "selected", appointment };
    const fallback = singleLoadedAppointmentFallback(state, selector);
    if (fallback) return fallback;
    return {
      status: "not_found",
      message:
        "No loaded appointment matches that appointment ID. Load appointments again and confirm the exact appointment before cancelling.",
    };
  }

  const selectorResult = appointmentSelectedByDateTime(state, selector);
  if (selectorResult) {
    if (selectorResult.status === "not_found") {
      const fallback = singleLoadedAppointmentFallback(state, selector);
      if (fallback) return fallback;
    }
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

function singleLoadedAppointmentFallback(
  state: CallState,
  selector: CancellationAppointmentSelector,
): CancellationAppointmentSelection | null {
  if (selector.fallbackToSingleLoadedAppointment !== true) return null;

  const appointments = activeAppointments(state);
  return appointments.length === 1
    ? { status: "selected", appointment: appointments[0] }
    : null;
}

export function removeAppointmentById(
  state: CallState,
  appointmentId: number,
): void {
  const appointment = activeAppointmentById(state, appointmentId);
  const patientId = activePatientId(state);
  if (appointment && patientId) {
    recordCompletedCancellation(state, patientId, appointment);
  }
  removeBookedAppointmentReference(state, appointmentId);
  state.identity.patient.appointments =
    state.identity.patient.appointments.filter(
      (appointment) => appointment.id !== appointmentId,
    );
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

function spokenAppointment(appointment: CallerAppointment): string {
  return [
    appointment.date,
    appointment.time ? `at ${appointment.time}` : "",
    appointment.provider ? `with ${appointment.provider}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}
