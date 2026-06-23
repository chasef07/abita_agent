import { llm } from "@livekit/agents";
import {
  activePatientDob,
  activePatientName,
  availabilityBookingToken,
  clearAvailabilitySelection,
  currentWorkflowVisitType,
  latestAvailabilityRouting,
  type CallState,
  type CallerAppointment,
  type StoredAvailabilitySlot,
} from "../state/call-state.js";
import {
  publicProviderName,
  selectedAvailabilitySlot,
} from "./availability-slots.js";
import { routingForAvailability } from "./scheduling.js";

type AppointmentKind = "medical" | "routine_vision" | "post_op";
export type AppointmentPatientStatus = "new" | "established";

type BookingRequestInput = {
  selectedSlot: StoredAvailabilitySlot;
  patientId: string;
  appointmentReason: string;
  referringDoctor: string;
  appointmentTypeIdOverride?: number | null;
  patientStatusOverride?: AppointmentPatientStatus | null;
};

const NEW_PATIENT_APPOINTMENT_TYPE_IDS = new Set([
  1004, 1006, 1010, 4244, 6167,
]);
const ESTABLISHED_PATIENT_APPOINTMENT_TYPE_IDS = new Set([
  1005, 1007, 3364, 4245, 6169,
]);

export function selectedSlotForBooking(
  state: CallState,
  slotId: string,
): StoredAvailabilitySlot {
  const selectedSlot = selectedAvailabilitySlot(state, slotId);
  if (!selectedSlot) {
    throw new llm.ToolError(
      "Search availability again and choose one of the returned slots before booking.",
    );
  }
  return selectedSlot;
}

export function bookingRequestBodyForSlot(
  state: CallState,
  input: BookingRequestInput,
): Record<string, unknown> {
  const normalizedReason = normalizeAppointmentReason(input.appointmentReason);
  const normalizedReferrer = normalizeReferringDoctor(input.referringDoctor);
  const routing =
    input.selectedSlot.routing ??
    latestAvailabilityRouting(state) ??
    routingForAvailability(state);

  const bookingToken = availabilityBookingToken(
    state,
    input.selectedSlot.slotId,
  );
  if (!bookingToken) {
    clearAvailabilitySelection(state);
    throw new llm.ToolError(
      "Search availability again before booking because the selected slot expired.",
    );
  }

  const appointmentIntent = appointmentIntentForBooking(
    state,
    routing,
    normalizedReason,
    input.patientStatusOverride,
  );
  const patientName = activePatientName(state);
  const dob = activePatientDob(state);
  return {
    bookingToken,
    ...appointmentIntent,
    patientId: input.patientId,
    appointmentReason: normalizedReason,
    referringDoctor: normalizedReferrer,
    ...(input.appointmentTypeIdOverride != null
      ? { appointmentTypeId: input.appointmentTypeIdOverride }
      : {}),
    ...(patientName ? { patientName } : {}),
    ...(dob ? { dob } : {}),
    ...(routing ? { routing } : {}),
  };
}

export function appointmentPatientStatusForLoadedAppointment(
  appointment: CallerAppointment,
): AppointmentPatientStatus | null {
  if (
    appointment.appointmentTypeId !== undefined &&
    NEW_PATIENT_APPOINTMENT_TYPE_IDS.has(appointment.appointmentTypeId)
  ) {
    return "new";
  }
  if (
    appointment.appointmentTypeId !== undefined &&
    ESTABLISHED_PATIENT_APPOINTMENT_TYPE_IDS.has(appointment.appointmentTypeId)
  ) {
    return "established";
  }

  const normalizedType = normalizeAppointmentTypeName(appointment.type);
  if (!normalizedType) return null;
  if (/\bnew\b/.test(normalizedType)) return "new";
  if (
    /\bestablished\b/.test(normalizedType) ||
    /\bfollow\s*up\b/.test(normalizedType)
  ) {
    return "established";
  }
  return null;
}

export function bookingSucceeded(result: unknown): boolean {
  if (!isRecord(result)) return false;
  const status = bookingStatus(result);
  const appointmentId = appointmentIdFromResult(result);
  if (status === "booked" || status === "partial" || status === "success") {
    return appointmentId !== null;
  }
  if (status === "error") return false;
  return appointmentId !== null;
}

export function bookingHadPositiveStatusWithoutAppointmentId(
  result: unknown,
): boolean {
  if (!isRecord(result)) return false;
  const status = bookingStatus(result);
  return (
    (status === "booked" || status === "partial" || status === "success") &&
    appointmentIdFromResult(result) === null
  );
}

export function bookingOutcome(result: unknown): string {
  return isRecord(result) && typeof result.outcome === "string"
    ? result.outcome.toLowerCase()
    : "";
}

export function bookedAppointmentMessage(
  selectedSlot: StoredAvailabilitySlot,
  result: unknown,
): string {
  return `Booked ${spokenSlot(selectedSlot)}.${bookingNoteWarning(result)}`;
}

export function bookedAppointmentToolResult(
  selectedSlot: StoredAvailabilitySlot,
  result: unknown,
): Record<string, unknown> {
  const receipt = isRecord(result) ? result : {};
  const providerName =
    stringField(receipt, "providerName") ?? selectedSlot.provider;
  const startDatetime =
    stringField(receipt, "startDatetime") ?? selectedSlot.datetime;
  return {
    status: stringField(receipt, "status") ?? "booked",
    message: bookedAppointmentMessage(selectedSlot, result),
    appointmentDate: selectedSlot.date,
    appointmentTime: selectedSlot.time,
    ...(providerName ? { providerName } : {}),
    ...(startDatetime ? { startDatetime } : {}),
  };
}

export function bookingNoteWarning(result: unknown): string {
  return isRecord(result) && result.status === "partial"
    ? " The appointment was booked, but the patient note did not save."
    : "";
}

export function slotUnavailableMessage(
  remainingSlots: StoredAvailabilitySlot[],
): string {
  const nextSlot = remainingSlots[0];
  if (nextSlot) {
    return `That time is no longer available. I can offer ${spokenSlot(nextSlot)} instead.`;
  }
  return "That time is no longer available. Check availability again before booking.";
}

export function bookingFailureMessage(result: unknown): string {
  const status = bookingStatus(result);
  if (status === "booked" || status === "partial" || status === "success") {
    return "I could not confirm the booking because the appointment ID was missing. Check availability again before booking.";
  }
  if (isRecord(result) && typeof result.message === "string") {
    return result.message;
  }
  return "The appointment was not booked.";
}

export function spokenSlot(slot: StoredAvailabilitySlot): string {
  const date = spokenIsoDate(slot.date) ?? slot.date;
  const provider = slot.provider
    ? ` with ${publicProviderName(slot.provider)}`
    : "";
  return `${date} at ${slot.time}${provider}`;
}

function normalizeAppointmentReason(appointmentReason: string): string {
  const trimmedReason = appointmentReason.trim();
  if (!trimmedReason || isGenericBookingReason(trimmedReason)) {
    throw new llm.ToolError("Ask for the appointment reason before booking.");
  }
  return trimmedReason;
}

function normalizeReferringDoctor(referringDoctor: string | undefined): string {
  const trimmedReferrer = referringDoctor?.trim();
  if (!trimmedReferrer) {
    throw new llm.ToolError(
      'Ask whether the caller has a referring doctor before booking. If they have none, pass "none".',
    );
  }
  return trimmedReferrer;
}

function appointmentIntentForBooking(
  state: CallState,
  routing: string | null,
  appointmentReason?: string,
  patientStatusOverride?: AppointmentPatientStatus | null,
): Record<string, unknown> {
  const visitKind = inferAppointmentKindForBooking(
    state,
    routing,
    appointmentReason,
  );
  const visitCategory =
    visitKind === "routine_vision" ? "routine_vision" : "medical";
  const visitReason = appointmentReason?.trim();

  return {
    visitCategory,
    visitKind,
    patientStatus:
      patientStatusOverride ?? patientStatusForAppointmentIntent(state),
    ...(visitKind === "post_op" ? { isPostOp: true } : {}),
    ...(visitReason ? { visitReason } : {}),
  };
}

function inferAppointmentKindForBooking(
  state: CallState,
  routing: string | null,
  appointmentReason?: string,
): AppointmentKind {
  if (
    routing === "optical_only" ||
    currentWorkflowVisitType(state) === "routine_vision"
  ) {
    return "routine_vision";
  }
  if (looksLikePostOpVisit(appointmentReason)) {
    return "post_op";
  }
  return "medical";
}

function patientStatusForAppointmentIntent(
  state: CallState,
): AppointmentPatientStatus {
  return state.identity.patient.status === "created" ||
    state.identity.patient.status === "new"
    ? "new"
    : "established";
}

function looksLikePostOpVisit(visitReason: string | undefined): boolean {
  const normalized = visitReason?.trim().toLowerCase() ?? "";
  return /\bpost\s*-?\s*op\b|\bpost\s+operative\b|\bpostoperative\b|\bsurgery\s+follow\s*-?\s*up\b|\brecent\s+surgery\b/.test(
    normalized,
  );
}

function isGenericBookingReason(value: string): boolean {
  return /^(appointment|appt|visit|office visit|booking)$/i.test(value.trim());
}

function bookingStatus(result: unknown): string {
  return isRecord(result) && typeof result.status === "string"
    ? result.status.toLowerCase()
    : "";
}

function stringField(
  record: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = record[field];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function appointmentIdFromResult(
  result: Record<string, unknown>,
): number | null {
  const appointmentId = result.appointmentId;
  if (typeof appointmentId === "number") return appointmentId;
  if (typeof appointmentId === "string" && /^\d+$/.test(appointmentId)) {
    return Number(appointmentId);
  }
  return null;
}

function spokenIsoDate(date: string | undefined): string | undefined {
  if (!date) return undefined;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(parsed);
}

function normalizeAppointmentTypeName(value: string | undefined): string {
  return (
    value?.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ") ??
    ""
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
