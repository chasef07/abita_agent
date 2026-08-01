import { ToolError } from "@livekit/agents";
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
  currentWorkflowVisitType,
  latestAvailabilityRouting,
} from "./state.js";
import {
  publicProviderName,
  selectedAvailabilitySlot,
} from "./availability.js";
import { routingForAvailability } from "./routing.js";
import { spokenAppointmentDate } from "./spoken-date.js";
import type { BookingSuccess } from "./middleware.js";

export type AppointmentPatientStatus = "new" | "established";

type BookingRequestInput = {
  selectedSlot: StoredAvailabilitySlot;
  patientId: string;
  appointmentReason: string;
  referringDoctor?: string;
  now: Date;
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
    throw new ToolError(
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
      invalidateReads: "booking_authorization_invalidated",
    });
    throw new ToolError(
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

export function bookingSlotUnavailable(result: BookAppointmentResult): boolean {
  return result.status === "unavailable";
}

export function bookingTokenRejected(result: BookAppointmentResult): boolean {
  return result.status === "rejected";
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

export function slotUnavailableMessage(
  remainingSlots: StoredAvailabilitySlot[],
): string {
  const nextSlot = remainingSlots[0];
  if (nextSlot) {
    return `That time is no longer available. I can offer ${spokenSlot(nextSlot)} instead.`;
  }
  return "That time is no longer available. Check availability again before booking.";
}

export function bookingFailureMessage(result: BookAppointmentResult): string {
  if (result.status === "error" && result.detail === "missing_appointment_id") {
    return "I could not confirm the booking because the appointment ID was missing. Check availability again before booking.";
  }
  if (result.status === "needs_input") {
    if (result.missing.includes("routeToSpringHill")) {
      return "The appointment was not booked. Check routine vision availability at Spring Hill, then book a returned slot there.";
    }
    if (result.missing.includes("appointmentLane")) {
      return "The appointment was not booked. Treat the visit as medical and check Spring Hill medical availability before booking.";
    }
    if (result.missing.includes("routing")) {
      return "The appointment was not booked. Check availability at an office that supports the required medical scheduling lane before booking.";
    }
    if (result.missing.includes("office")) {
      return "The appointment was not booked. Select the scheduling office and check availability again before booking.";
    }
    const needsPatientStatus = result.missing.includes("patientStatus");
    const needsDob = result.missing.includes("dob");
    if (needsPatientStatus && needsDob) {
      return "The appointment was not booked. Confirm whether the patient is new or established and verify the patient's date of birth, then try booking again.";
    }
    if (needsPatientStatus) {
      return "The appointment was not booked. Confirm whether the patient is new or established, then try booking again.";
    }
    if (needsDob) {
      return "The appointment was not booked. Verify the patient's date of birth, then try booking again.";
    }
    return "The appointment was not booked. Verify the patient details, then try booking again.";
  }
  if (result.status === "rejected") {
    return "Check availability again before booking.";
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
    throw new ToolError(
      "Ask for a useful appointment reason before booking: the routine purpose, or the eye symptom or concern plus one caller-provided detail. When the caller has only a generic reason, record that limitation in the reason.",
    );
  }
  return trimmedReason;
}

function normalizeReferringDoctor(referringDoctor: string | undefined): string {
  const trimmedReferrer = referringDoctor?.trim();
  if (!trimmedReferrer) {
    throw new ToolError(
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
    currentWorkflowVisitType(state) === "routine_vision"
  ) {
    return "routine_vision";
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
