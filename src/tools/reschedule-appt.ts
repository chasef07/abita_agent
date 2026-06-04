import { llm } from "@livekit/agents";
import { z } from "zod";
import { callApi } from "../clients/advancedmd-client.js";
import { getOfficeConfig, type OfficeKey } from "../customer/profile.js";
import {
  activePatientId,
  clearAvailabilitySelection,
  type CallerAppointment,
  type CallState,
  type StoredAvailabilitySlot,
} from "../state/call-state.js";
import { removeAvailabilitySlot } from "./availability-slots.js";
import {
  cancellationAppointmentForState,
  removeAppointmentById,
  recordBookedAppointmentInState,
} from "./appointment-state.js";
import {
  appointmentPatientStatusForLoadedAppointment,
  bookingFailureMessage,
  bookingHadPositiveStatusWithoutAppointmentId,
  bookingNoteWarning,
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
import { ensureSchedulingTurnContext } from "./turn-context-guard.js";

export const reschedule_appt = llm.tool({
  description:
    "Reschedule a loaded appointment. " +
    "Call only after the patient is verified, the caller confirms the exact old appointment to move, get_availability returns slots, the caller confirms the exact new slot, and the caller provides a referring doctor or says they have none. " +
    "This tool books the new appointment first and cancels the old appointment only after booking succeeds.",
  parameters: z.object({
    slotId: z
      .string()
      .trim()
      .min(1)
      .describe(
        "slotId from get_availability for the caller-confirmed new slot.",
      ),
    appointmentReason: z
      .string()
      .trim()
      .min(1)
      .describe("Caller-provided reason for the new appointment."),
    referringDoctor: z
      .string()
      .trim()
      .min(1)
      .describe(
        'Caller-provided referring doctor, or "none" if the caller has no referring doctor.',
      ),
    appointmentId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Old appointment ID from the loaded appointment list. Omit only when the caller confirmed exactly one loaded appointment.",
      ),
    appointmentDate: z
      .string()
      .optional()
      .describe(
        'Date the caller used to identify the old loaded appointment, such as "June 2", "June 2nd", or "2026-06-02".',
      ),
    appointmentTime: z
      .string()
      .optional()
      .describe(
        'Time the caller used to identify the old loaded appointment, such as "10 AM" or "2:30 PM". Use with appointmentDate when needed.',
      ),
  }),
  execute: async (
    {
      slotId,
      appointmentReason,
      referringDoctor,
      appointmentId,
      appointmentDate,
      appointmentTime,
    },
    { ctx },
  ) => {
    const state = getState(ctx);
    ensureSchedulingTurnContext(state, "rescheduling");
    ctx.speechHandle.allowInterruptions = false;

    restoreConfirmedPreCallCaller(state);
    const patientId = activePatientId(state);
    if (!patientId) {
      throw new llm.ToolError("Verify the patient before rescheduling.");
    }

    const selection = cancellationAppointmentForState(state, {
      appointmentId,
      appointmentDate,
      appointmentTime,
    });
    if (selection.status === "ambiguous") {
      return selection.message;
    }
    if (selection.status === "not_found") {
      throw new llm.ToolError(selection.message);
    }
    const oldAppointment = selection.appointment;
    const cancellationOffice = getAmdOfficeForCancellationAppointment(
      state,
      oldAppointment,
    );

    ensureRoutineVisionOffice(state);
    const selectedSlot = selectedSlotForBooking(state, slotId);
    const bookingBody = bookingRequestBodyForSlot(state, {
      selectedSlot,
      patientId,
      appointmentReason,
      referringDoctor,
      patientStatusOverride:
        appointmentPatientStatusForLoadedAppointment(oldAppointment),
    });

    const bookingResult = await callApi(
      "/api/appointment/book",
      bookingBody,
      getAmdOfficeForToolCall(state),
      { includeOffice: false },
    );

    if (bookingSucceeded(bookingResult)) {
      recordBookedAppointmentInState(state, selectedSlot, bookingResult);
      removeAvailabilitySlot(state, selectedSlot.slotId);
    } else {
      return handleRescheduleBookingFailure(
        state,
        selectedSlot.slotId,
        bookingResult,
      );
    }

    let cancelResult: CancelAppointmentResult;
    try {
      cancelResult = (await callApi(
        "/api/appointment/cancel",
        { appointmentId: oldAppointment.id, patientId },
        cancellationOffice,
      )) as CancelAppointmentResult;
    } catch {
      return rescheduleCancellationFailureMessage(
        selectedSlot,
        "The old appointment was not cancelled.",
      );
    }

    if (cancelResult?.status !== "cancelled") {
      return rescheduleCancellationFailureMessage(
        selectedSlot,
        cancelResult?.message ?? "The old appointment was not cancelled.",
      );
    }

    removeAppointmentById(state, oldAppointment.id);
    return rescheduledAppointmentToolResult(
      selectedSlot,
      bookingResult,
      oldAppointment,
      cancelResult,
    );
  },
});

function getAmdOfficeForCancellationAppointment(
  state: CallState,
  appointment: CallerAppointment,
): string {
  const officeKey = officeKeyForAppointmentFacility(appointment.facility);
  if (!officeKey) return getAmdOfficeForToolCall(state);
  return (
    state.office.phoneOverrides?.[officeKey] ??
    getOfficeConfig(officeKey).amdOfficePhone
  );
}

function officeKeyForAppointmentFacility(
  facility: string | undefined,
): OfficeKey | null {
  const normalized = normalizeFacilityName(facility);
  if (!normalized) return null;

  if (
    normalized.includes("crystal river") ||
    normalized.includes("eye radiance")
  ) {
    return "crystal-river";
  }
  if (normalized.includes("spring hill")) return "spring-hill";
  if (normalized.includes("hollywood")) return "hollywood";
  if (normalized.includes("sweetwater")) return "sweetwater";

  for (const key of OFFICE_KEYS) {
    const displayName = normalizeFacilityName(getOfficeConfig(key).displayName);
    if (displayName && normalized.includes(displayName)) return key;
  }

  return null;
}

function normalizeFacilityName(value: string | undefined): string {
  return (
    value
      ?.trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim() ?? ""
  );
}

const OFFICE_KEYS: OfficeKey[] = [
  "spring-hill",
  "crystal-river",
  "hollywood",
  "sweetwater",
  "dev",
];

function handleRescheduleBookingFailure(
  state: CallState,
  slotId: string,
  bookingResult: unknown,
): string {
  if (bookingHadPositiveStatusWithoutAppointmentId(bookingResult)) {
    clearAvailabilitySelection(state);
    return "I could not confirm the new booking because the appointment ID was missing, so I did not cancel the existing appointment. Check availability again before booking.";
  }

  const outcome = bookingOutcome(bookingResult);
  if (outcome === "slot_unavailable") {
    const remainingSlots = removeAvailabilitySlot(state, slotId);
    return `${slotUnavailableMessage(remainingSlots)} I did not cancel the existing appointment.`;
  }
  if (
    outcome === "invalid_booking_token" ||
    outcome === "booking_token_required"
  ) {
    clearAvailabilitySelection(state);
  }

  return `${bookingFailureMessage(bookingResult)} I did not cancel the existing appointment.`;
}

function rescheduleCancellationFailureMessage(
  selectedSlot: Parameters<typeof spokenSlot>[0],
  failureMessage: string,
): string {
  return (
    `Booked the new appointment for ${spokenSlot(selectedSlot)}, but I could not cancel the old appointment. ` +
    `${failureMessage} ` +
    "I need to transfer you so the office can finish the cancellation."
  );
}

function rescheduledAppointmentToolResult(
  selectedSlot: StoredAvailabilitySlot,
  bookingResult: unknown,
  oldAppointment: CallerAppointment,
  cancelResult: CancelAppointmentResult,
): Record<string, unknown> {
  const receipt = isRecord(bookingResult) ? bookingResult : {};
  const message =
    `Rescheduled the appointment to ${spokenSlot(selectedSlot)}. ` +
    `Cancelled the old appointment on ${oldAppointment.date} at ${oldAppointment.time}.` +
    bookingNoteWarning(bookingResult);

  return {
    ...receipt,
    status: "rescheduled",
    bookingStatus:
      typeof receipt.status === "string" ? receipt.status : "booked",
    message,
    startDatetime:
      stringField(receipt, "startDatetime") ?? selectedSlot.datetime,
    appointmentDate: selectedSlot.date,
    appointmentTime: selectedSlot.time,
    providerName: stringField(receipt, "providerName") ?? selectedSlot.provider,
    cancelledAppointmentId: oldAppointment.id,
    cancelledAppointmentDate: oldAppointment.date,
    cancelledAppointmentTime: oldAppointment.time,
    cancelledAppointmentProvider: oldAppointment.provider,
    cancellationStatus: cancelResult.status ?? "cancelled",
  };
}

function stringField(
  record: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = record[field];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type CancelAppointmentResult = {
  status?: string;
  message?: string;
};
