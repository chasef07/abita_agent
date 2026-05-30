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
  selectedAvailabilitySlot,
} from "./availability-slots.js";
import { recordBookedAppointmentInState } from "./appointment-state.js";
import { restoreConfirmedPreCallCaller } from "./patient-state.js";
import {
  ensureRoutineVisionOffice,
  getAmdOfficeForToolCall,
  routingForAvailability,
} from "./scheduling.js";
import { disableInterruptionsForWrite, getState } from "./session.js";

type AppointmentKind = "medical" | "routine_vision" | "post_op";

export const book_appt = llm.tool({
  description:
    "Book an appointment from an active get_availability slotId. " +
    "Call only after the caller confirms the exact offered slot. " +
    "Patient ID, DOB, routing, and booking token come from session state. " +
    'Include caller-provided appointmentReason and referringDoctor; use referringDoctor "none" when there is no referrer or the caller is unsure. ' +
    "Do not ask extra clinical details once the reason is usable. " +
    "Returns booking status and removes unavailable or booked slots from state.",
  parameters: z.object({
    slotId: z
      .string()
      .describe("slotId of the caller-confirmed slot from get_availability"),
    appointmentKind: z
      .enum(["medical", "routine_vision", "post_op"])
      .describe(
        "Human-level appointment kind for the selected slot; use post_op only for recent surgery follow-up.",
      ),
    appointmentReason: z
      .string()
      .trim()
      .min(1)
      .describe("Caller-provided reason for the appointment."),
    referringDoctor: z
      .string()
      .trim()
      .min(1)
      .describe('Caller-provided referring doctor, or "none" if none.'),
  }),
  execute: async (params, { ctx }) => {
    const state = getState(ctx);
    const speechReady = disableInterruptionsForWrite(ctx);
    restoreConfirmedPreCallCaller(state);
    const patientId = activePatientId(state);
    if (!patientId) {
      return {
        outcome: "not_allowed",
        speak: "Verify or create the patient before booking.",
        facts: { reason: "booking_requires_verified_or_created_patient" },
        retryable: true,
      };
    }
    ensureRoutineVisionOffice(state);
    const selectedSlot = selectedAvailabilitySlot(state, params.slotId);
    if (!selectedSlot) {
      return {
        outcome: "not_allowed",
        speak:
          "That slot is not available from the active availability options. Search availability again before booking.",
        facts: {
          reason: "booking_requires_recent_availability",
          slotId: params.slotId,
        },
        retryable: true,
      };
    }
    const routing =
      selectedSlot.routing ??
      latestAvailabilityRouting(state) ??
      routingForAvailability(state);
    const bookingMetadata = resolveBookingNoteMetadata(
      params.appointmentReason,
      params.referringDoctor,
    );
    if ("outcome" in bookingMetadata) return bookingMetadata;
    const { appointmentReason, referringDoctor } = bookingMetadata;
    if (!speechReady) {
      return {
        outcome: "not_allowed",
        speak:
          "Booking was interrupted before it could be submitted. Please confirm the appointment slot again.",
        facts: { reason: "speech_interrupted" },
        retryable: true,
      };
    }
    const bookingToken = bookingTokenForSelectedSlot(state, selectedSlot);
    if (typeof bookingToken !== "string") return bookingToken;
    const appointmentIntent = appointmentIntentForBooking(
      state,
      routing,
      params.appointmentKind,
      appointmentReason,
    );
    const body = {
      bookingToken,
      ...appointmentIntent,
      patientId,
      appointmentReason,
      referringDoctor,
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
    if (apiResultLooksSuccessful(result)) {
      recordBookedAppointmentInState(state, selectedSlot, result);
      removeAvailabilitySlot(state, selectedSlot.slotId);
      return result;
    }
    if (isRecord(result) && result.errorClass === "slot_unavailable") {
      removeAvailabilitySlot(state, selectedSlot.slotId);
      return result;
    }
    if (isRecord(result) && result.errorClass === "invalid_appointment_type") {
      clearAvailabilitySelection(state);
      return result;
    }
    return result;
  },
});

function resolveBookingNoteMetadata(
  appointmentReason: string,
  referringDoctor: string,
) {
  const trimmedReason = appointmentReason.trim();
  const trimmedReferrer = referringDoctor.trim();
  const hasMeaningfulReason =
    trimmedReason.length > 0 && !isGenericBookingReason(trimmedReason);

  if (!hasMeaningfulReason) {
    return {
      outcome: "needs_clarification",
      speak: "Ask for the appointment reason before booking.",
      facts: {
        reason: "booking_note_metadata_missing",
        missingFacts: ["appointmentReason"],
      },
      retryable: true,
    };
  }

  if (!trimmedReferrer) {
    return {
      outcome: "needs_clarification",
      speak:
        "Ask who referred them, or whether there is no referring doctor. Do not ask for surgery details; the appointment reason is already known.",
      facts: {
        reason: "booking_note_metadata_missing",
        missingFacts: ["referringDoctor"],
      },
      retryable: true,
    };
  }

  return {
    appointmentReason: trimmedReason,
    referringDoctor: trimmedReferrer,
  };
}

function bookingTokenForSelectedSlot(
  state: CallState,
  selectedSlot: StoredAvailabilitySlot,
) {
  const bookingToken = availabilityBookingToken(state, selectedSlot.slotId);
  if (bookingToken) return bookingToken;
  clearAvailabilitySelection(state);
  return {
    outcome: "not_allowed",
    speak:
      "That cached slot is missing a signed booking token. Search availability again and choose one of the returned slots.",
    facts: {
      reason: "booking_requires_booking_token",
      slotId: selectedSlot.slotId,
    },
    retryable: true,
  };
}

function appointmentIntentForBooking(
  state: CallState,
  routing: string | null,
  appointmentKind?: AppointmentKind,
  appointmentReason?: string,
): Record<string, unknown> {
  const visitKind = inferAppointmentKindForBooking(
    state,
    routing,
    appointmentKind,
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
  appointmentKind?: AppointmentKind,
  appointmentReason?: string,
): AppointmentKind {
  if (appointmentKind) return appointmentKind;
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

function apiResultLooksSuccessful(result: unknown): boolean {
  if (!isRecord(result)) return true;
  const status =
    typeof result.status === "string" ? result.status.toLowerCase() : "";
  const outcome =
    typeof result.outcome === "string" ? result.outcome.toLowerCase() : "";
  const text = `${status} ${outcome}`;
  return (
    !text.includes("error") &&
    !text.includes("fail") &&
    !text.includes("not_found") &&
    !text.includes("not found")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
