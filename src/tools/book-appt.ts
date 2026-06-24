import { llm } from "@livekit/agents";
import { z } from "zod";
import { callApi } from "../clients/advancedmd-client.js";
import {
  activePatientId,
  clearAvailabilitySelection,
  latestBookedAppointmentId,
  type CallState,
} from "../state/call-state.js";
import { removeAvailabilitySlot } from "./availability-slots.js";
import { recordBookedAppointmentInState } from "./appointment-state.js";
import {
  bookedAppointmentToolResult,
  bookingFailureMessage,
  bookingHadPositiveStatusWithoutAppointmentId,
  bookingOutcome,
  bookingRequestBodyForSlot,
  bookingSucceeded,
  selectedSlotForBooking,
  slotUnavailableMessage,
  spokenSlot,
} from "./booking-state.js";
import { restoreConfirmedPreCallCaller } from "./patient-state.js";
import {
  ensureRoutineVisionOffice,
  getAmdOfficeForToolCall,
} from "./scheduling.js";
import { getState } from "./session.js";

const bookAppointmentParameters = z
  .object({
    appointmentSlotRef: z
      .string()
      .trim()
      .min(1)
      .describe(
        "Slot reference from get_availability for the caller-confirmed slot; this is not a backend ID.",
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
      .describe(
        'Caller-provided referring doctor, or "none" if the caller has no referring doctor.',
      ),
    readBack: z
      .boolean()
      .optional()
      .describe(
        "Set to true only after reading back the selected appointment date, time, and provider and the caller confirms the appointment details are correct.",
      ),
  })
  .strict();

export const book_appointment = llm.tool({
  description:
    "Book a caller-confirmed appointment slot. " +
    "Use only for new appointments after get_availability recorded appointmentLane; do not use for reschedules or other appointment changes. " +
    "Call only after get_availability returns slots with the right appointment lane, the caller confirms the exact offered slot, and the caller provides a referring doctor or says they have none. " +
    "Before booking, read back the selected appointment date, time, and provider, then get caller confirmation. ",
  parameters: bookAppointmentParameters,
  execute: async (
    { appointmentSlotRef, appointmentReason, referringDoctor, readBack },
    { ctx },
  ) => {
    const state = getState(ctx);

    restoreConfirmedPreCallCaller(state);
    const patientId = activePatientId(state);
    if (patientId && hasCompletedBookingForActivePatient(state)) {
      clearAvailabilitySelection(state);
      return "The appointment is already booked. Tell the caller the confirmed appointment details instead of booking again.";
    }

    ensureNewAppointmentBookingContext(state);

    if (!patientId) {
      throw new llm.ToolError("Verify or create the patient before booking.");
    }

    ensureRoutineVisionOffice(state);
    const selectedSlot = selectedSlotForBooking(state, appointmentSlotRef);
    const bookingBody = bookingRequestBodyForSlot(state, {
      selectedSlot,
      patientId,
      appointmentReason,
      referringDoctor,
    });
    if (!readBack) {
      return (
        `Read back ${spokenSlot(selectedSlot)} and ask the caller to confirm it. ` +
        "Call book_appointment again only after the caller confirms the appointment details are correct."
      );
    }

    ctx.speechHandle.allowInterruptions = false;
    const result = await callApi(
      "/api/appointment/book",
      bookingBody,
      getAmdOfficeForToolCall(state),
      { includeOffice: false },
    );

    if (bookingSucceeded(result)) {
      recordBookedAppointmentInState(state, selectedSlot, result);
      removeAvailabilitySlot(state, selectedSlot.slotId);
      return bookedAppointmentToolResult(selectedSlot, result);
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

function ensureNewAppointmentBookingContext(state: CallState): void {
  const turn = state.workflow.current;
  if (turn?.intent === "change_appointment") {
    throw new llm.ToolError(
      "Use reschedule_appointment for appointment changes so the old appointment is cancelled after the new booking succeeds.",
    );
  }
  if (
    turn?.intent === "schedule" &&
    (turn.appointmentLane === "medical_md" ||
      turn.appointmentLane === "routine_od")
  ) {
    return;
  }
  throw new llm.ToolError(
    "Search availability again with appointmentLane medical_md or routine_od before booking a new appointment.",
  );
}

function hasCompletedBookingForActivePatient(state: CallState): boolean {
  const appointmentId = latestBookedAppointmentId(state);
  return Boolean(
    appointmentId !== null &&
    state.identity.patient.appointments.some(
      (appointment) => appointment.id === appointmentId,
    ),
  );
}
