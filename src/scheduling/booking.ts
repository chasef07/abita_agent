import type {
  BookAppointmentInput,
  BookAppointmentResult,
} from "../clients/owned-middleware.js";
import {
  activePatientDob,
  activePatientName,
  type CallState,
  type CallerAppointment,
  type StoredAvailabilitySlot,
} from "../state/call-state.js";
import {
  availabilityBookingToken,
  clearAvailabilitySelection,
  latestAvailabilityRouting,
  publicProviderName,
  selectedAvailabilitySlot,
} from "./availability.js";
import { routingForAvailability } from "./routing.js";
import { spokenAppointmentDate } from "./spoken-date.js";
import { SchedulingInputRequired } from "./input-required.js";

export type BookingSuccess = Extract<
  BookAppointmentResult,
  { status: "booked" | "partial" }
>;

export type AppointmentPatientStatus = "new" | "established";

type BookingRequestInput = {
  selectedSlot: StoredAvailabilitySlot;
  patientId: string;
  appointmentReason: string;
  referringDoctor?: string;
  now: Date;
  appointmentTypeIdOverride?: number | null;
  patientStatusOverride?: AppointmentPatientStatus | null;
  rescheduleToken?: string;
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
    throw new SchedulingInputRequired(
      "Search availability again and choose one of the returned slots before booking.",
    );
  }
  return selectedSlot;
}

export function bookingRequestBodyForSlot(
  state: CallState,
  input: BookingRequestInput,
): BookAppointmentInput {
  const normalizedReason = normalizeAppointmentReason(input.appointmentReason);
  const normalizedReferrer = normalizeReferringDoctor(input.referringDoctor);
  const routing =
    input.selectedSlot.routing ??
    latestAvailabilityRouting(state) ??
    routingForAvailability(state);

  const bookingToken = availabilityBookingToken(
    state,
    input.selectedSlot.slotId,
    input.now,
  );
  if (!bookingToken) {
    clearAvailabilitySelection(state, {
      invalidateReads: true,
    });
    throw new SchedulingInputRequired(
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
    ...(input.rescheduleToken
      ? { rescheduleToken: input.rescheduleToken }
      : {}),
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

export function bookingSucceeded(
  result: BookAppointmentResult,
): result is BookingSuccess {
  return result.status === "booked" || result.status === "partial";
}

export function bookingHadPositiveStatusWithoutAppointmentId(
  result: BookAppointmentResult,
): boolean {
  return (
    result.status === "error" && result.detail === "missing_appointment_id"
  );
}

export function bookedAppointmentMessage(
  selectedSlot: StoredAvailabilitySlot,
  result: BookingSuccess,
): string {
  return `Booked ${spokenSlot(selectedSlot)}.${bookingNoteWarning(result)}`;
}

export function bookingNoteWarning(result: BookingSuccess): string {
  return result.status === "partial"
    ? " The appointment was booked, but the patient note did not save."
    : "";
}

export function slotUnavailableMessage(): string {
  return "That time is no longer available. Let me refresh the appointments and find another time that fits.";
}

export function bookingFailureMessage(result: BookAppointmentResult): string {
  if (result.status === "error" && result.detail === "missing_appointment_id") {
    return "I couldn't confirm that booking. Let me check availability again.";
  }
  if (result.status === "needs_input") {
    if (result.missing.includes("routeToSpringHill")) {
      return "I couldn't book that here. Let me check routine vision availability at Spring Hill.";
    }
    if (result.missing.includes("appointmentLane")) {
      return "I couldn't book that. Let me check Spring Hill medical availability.";
    }
    if (result.missing.includes("routing")) {
      return "I couldn't book that at this office. Let me check an office that supports the visit.";
    }
    if (result.missing.includes("office")) {
      return "I couldn't book that yet. Which office would you prefer?";
    }
    const needsPatientStatus = result.missing.includes("patientStatus");
    const needsDob = result.missing.includes("dob");
    if (needsPatientStatus && needsDob) {
      return "I couldn't book that yet. Is the patient new or established, and what is their date of birth?";
    }
    if (needsPatientStatus) {
      return "I couldn't book that yet. Is the patient new or established?";
    }
    if (needsDob) {
      return "I couldn't book that yet. What is the patient's date of birth?";
    }
    return "I couldn't book that yet. I need to verify the patient details.";
  }
  if (result.status === "rejected") {
    return "I couldn't book that slot. Let me check availability again.";
  }
  return "The appointment was not booked.";
}

export function spokenSlot(slot: StoredAvailabilitySlot): string {
  const provider = slot.provider
    ? ` with ${publicProviderName(slot.provider)}`
    : "";
  return `${spokenAppointmentDate(slot.date)} at ${slot.time}${provider}`;
}

function normalizeAppointmentReason(appointmentReason: string): string {
  const trimmedReason = appointmentReason.trim();
  if (!trimmedReason || isGenericBookingReason(trimmedReason)) {
    throw new SchedulingInputRequired(
      "Ask for a useful appointment reason before booking: the routine purpose, or the eye symptom or concern plus one caller-provided detail. When the caller has only a generic reason, record that limitation in the reason.",
    );
  }
  return trimmedReason;
}

function normalizeReferringDoctor(referringDoctor: string | undefined): string {
  const trimmedReferrer = referringDoctor?.trim();
  if (!trimmedReferrer) {
    throw new SchedulingInputRequired(
      'Ask whether the caller has a referring doctor before booking. If they have none, pass "none".',
    );
  }
  return trimmedReferrer;
}

function appointmentIntentForBooking(
  state: CallState,
  routing: string | null,
  appointmentReason: string,
  patientStatusOverride?: AppointmentPatientStatus | null,
): Pick<
  BookAppointmentInput,
  "visitCategory" | "patientStatus" | "visitReason"
> {
  return {
    visitCategory: visitCategoryForBooking(state, routing),
    patientStatus:
      patientStatusOverride ?? patientStatusForAppointmentIntent(state),
    visitReason: appointmentReason,
  };
}

function visitCategoryForBooking(
  state: CallState,
  routing: string | null,
): BookAppointmentInput["visitCategory"] {
  if (
    routing === "optical_only" ||
    state.workflow.visitType === "routine_vision"
  ) {
    return "routine_vision";
  }
  return "medical";
}

function patientStatusForAppointmentIntent(
  state: CallState,
): AppointmentPatientStatus {
  return state.identity.activePatient?.kind === "created" ||
    state.identity.registration !== null
    ? "new"
    : "established";
}

function isGenericBookingReason(value: string): boolean {
  return /^(appointment|appt|visit|office visit|booking|(?:my )?eyes?|(?:my )?eye (?:exam|issues?|problems?|concerns?))$/i.test(
    value.trim(),
  );
}

function normalizeAppointmentTypeName(value: string | undefined): string {
  return (
    value?.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ") ??
    ""
  );
}
