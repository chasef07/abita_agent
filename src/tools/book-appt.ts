import { llm } from "@livekit/agents";
import { z } from "zod";
import { callApi } from "../clients/advancedmd-client.js";
import {
  activeInsuranceContext,
  activePatientDob,
  activePatientId,
  activePatientName,
  availabilityBookingToken,
  clearAvailabilitySelection,
  latestAvailabilityRouting,
  type CallState,
  type StoredAvailabilitySlot,
} from "../state/call-state.js";
import {
  removeAvailabilitySlot,
  publicProviderName,
  selectedAvailabilitySlot,
} from "./availability-slots.js";
import { recordBookedAppointmentInState } from "./appointment-state.js";
import { restoreConfirmedPreCallCaller } from "./patient-state.js";
import {
  ensureRoutineVisionOffice,
  getAmdOfficeForToolCall,
  routingForAvailability,
} from "./scheduling.js";
import { getState } from "./session.js";
import { ensureSchedulingTurnContext } from "./turn-context-guard.js";

type AppointmentKind = "medical" | "routine_vision" | "post_op";

export const book_appt = llm.tool({
  description:
    "Book a caller-confirmed appointment slot. " +
    "Requires record_turn_context to have recorded a scheduling lane first. " +
    "Call only after get_availability returns slots and the caller confirms the exact offered slot. ",
  parameters: z.object({
    slotId: z
      .string()
      .trim()
      .min(1)
      .describe("slotId from get_availability for the caller-confirmed slot."),
    appointmentReason: z
      .string()
      .trim()
      .min(1)
      .describe("Caller-provided reason for the appointment."),
    referringDoctor: z
      .string()
      .trim()
      .optional()
      .describe("Referring doctor if the caller gives one. Omit if none."),
  }),
  execute: async ({ slotId, appointmentReason, referringDoctor }, { ctx }) => {
    const state = getState(ctx);
    ensureSchedulingTurnContext(state, "booking");
    ctx.speechHandle.allowInterruptions = false;

    restoreConfirmedPreCallCaller(state);
    const patientId = activePatientId(state);
    if (!patientId) {
      throw new llm.ToolError("Verify or create the patient before booking.");
    }

    ensureRoutineVisionOffice(state);
    const selectedSlot = selectedAvailabilitySlot(state, slotId);
    if (!selectedSlot) {
      throw new llm.ToolError(
        "Search availability again and choose one of the returned slots before booking.",
      );
    }

    const normalizedReason = normalizeAppointmentReason(appointmentReason);
    const normalizedReferrer = normalizeReferringDoctor(referringDoctor);
    const routing =
      selectedSlot.routing ??
      latestAvailabilityRouting(state) ??
      routingForAvailability(state);

    const bookingToken = availabilityBookingToken(state, selectedSlot.slotId);
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
    );
    const body = {
      bookingToken,
      ...appointmentIntent,
      patientId,
      appointmentReason: normalizedReason,
      referringDoctor: normalizedReferrer,
      ...(activePatientName(state)
        ? { patientName: activePatientName(state) }
        : {}),
      ...(activePatientDob(state) ? { dob: activePatientDob(state) } : {}),
      ...(routing ? { routing } : {}),
    };
    const result = await callApi(
      "/api/appointment/book",
      body,
      getAmdOfficeForToolCall(state),
      { includeOffice: false },
    );

    if (bookingSucceeded(result)) {
      recordBookedAppointmentInState(state, selectedSlot, result);
      removeAvailabilitySlot(state, selectedSlot.slotId);
      return bookedAppointmentMessage(selectedSlot, result);
    }
    if (bookingHadPositiveStatusWithoutAppointmentId(result)) {
      clearAvailabilitySelection(state);
      return bookingFailureMessage(result);
    }

    const outcome = bookingOutcome(result);
    if (outcome === "slot_unavailable") {
      const remainingSlots = removeAvailabilitySlot(state, selectedSlot.slotId);
      return slotUnavailableMessage(remainingSlots);
    }
    if (
      outcome === "invalid_booking_token" ||
      outcome === "booking_token_required"
    ) {
      clearAvailabilitySelection(state);
    }

    return bookingFailureMessage(result);
  },
});

function normalizeAppointmentReason(appointmentReason: string): string {
  const trimmedReason = appointmentReason.trim();
  if (!trimmedReason || isGenericBookingReason(trimmedReason)) {
    throw new llm.ToolError("Ask for the appointment reason before booking.");
  }
  return trimmedReason;
}

function normalizeReferringDoctor(referringDoctor: string | undefined): string {
  return referringDoctor?.trim() || "none";
}

function appointmentIntentForBooking(
  state: CallState,
  routing: string | null,
  appointmentReason?: string,
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
    patientStatus: patientStatusForAppointmentIntent(state),
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
    activeInsuranceContext(state).coverageType === "routine_vision" ||
    state.scheduling.visitType === "routine_vision"
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
): "new" | "established" {
  return state.patient.status === "created" || state.patient.status === "new"
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

function bookingSucceeded(result: unknown): boolean {
  if (!isRecord(result)) return false;
  const status = bookingStatus(result);
  const appointmentId = appointmentIdFromResult(result);
  if (status === "booked" || status === "partial" || status === "success") {
    return appointmentId !== null;
  }
  if (status === "error") return false;
  return appointmentId !== null;
}

function bookingHadPositiveStatusWithoutAppointmentId(
  result: unknown,
): boolean {
  if (!isRecord(result)) return false;
  const status = bookingStatus(result);
  return (
    (status === "booked" || status === "partial" || status === "success") &&
    appointmentIdFromResult(result) === null
  );
}

function bookingStatus(result: unknown): string {
  return isRecord(result) && typeof result.status === "string"
    ? result.status.toLowerCase()
    : "";
}

function bookingOutcome(result: unknown): string {
  return isRecord(result) && typeof result.outcome === "string"
    ? result.outcome.toLowerCase()
    : "";
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

function bookedAppointmentMessage(
  selectedSlot: StoredAvailabilitySlot,
  result: unknown,
): string {
  const noteWarning =
    isRecord(result) && result.status === "partial"
      ? " The appointment was booked, but the patient note did not save."
      : "";
  return `Booked ${spokenSlot(selectedSlot)}.${noteWarning}`;
}

function slotUnavailableMessage(
  remainingSlots: StoredAvailabilitySlot[],
): string {
  const nextSlot = remainingSlots[0];
  if (nextSlot) {
    return `That time is no longer available. I can offer ${spokenSlot(nextSlot)} instead.`;
  }
  return "That time is no longer available. Check availability again before booking.";
}

function bookingFailureMessage(result: unknown): string {
  const status = bookingStatus(result);
  if (status === "booked" || status === "partial" || status === "success") {
    return "I could not confirm the booking because the appointment ID was missing. Check availability again before booking.";
  }
  if (isRecord(result) && typeof result.message === "string") {
    return result.message;
  }
  return "The appointment was not booked.";
}

function spokenSlot(slot: StoredAvailabilitySlot): string {
  const date = spokenIsoDate(slot.date) ?? slot.date;
  const provider = slot.provider
    ? ` with ${publicProviderName(slot.provider)}`
    : "";
  return `${date} at ${slot.time}${provider}`;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
