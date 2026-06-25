import { llm } from "@livekit/agents";
import { z } from "zod";
import { callApi } from "../clients/advancedmd-client.js";
import {
  getOfficeConfig,
  normalizePhoneNumber,
  type OfficeKey,
} from "../customer/profile.js";
import {
  activePatientId,
  clearAvailabilitySelection,
  completedRescheduleForPatient,
  latestAvailabilityRouting,
  recordAppointmentAction,
  recordCompletedRescheduleForPatient,
  type CallerAppointment,
  type CallState,
  type CompletedRescheduleState,
  type StoredAvailabilitySlot,
} from "../state/call-state.js";
import {
  bookedSlotAppointmentAnalytics,
  cancelledAppointmentAnalytics,
} from "./appointment-analytics.js";
import {
  removeAvailabilitySlot,
  selectedAvailabilitySlot,
} from "./availability-slots.js";
import {
  lockedCancellationAppointmentForState,
  removeAppointmentById,
  recordBookedAppointmentInState,
  spokenAppointment,
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
  routingForAvailability,
} from "./scheduling.js";
import { getState } from "./session.js";

const rescheduleAppointmentParameters = z
  .object({
    appointmentSlotRef: z
      .string()
      .trim()
      .min(1)
      .describe(
        "Slot reference from get_availability for the caller-confirmed new appointment slot.",
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
    readBack: z
      .boolean()
      .optional()
      .describe(
        "Set to true only after reading back the selected new appointment date, time, and provider and the caller confirms the new appointment details are correct.",
      ),
    oldAppointmentDate: z
      .string()
      .optional()
      .describe(
        'Date the caller used to identify the old loaded appointment being moved, such as "June 2", "June 2nd", or "2026-06-02". Omit when exactly one old appointment is loaded and confirmed.',
      ),
    oldAppointmentTime: z
      .string()
      .optional()
      .describe(
        'Time the caller used to identify the old loaded appointment being moved, such as "10 AM" or "2:30 PM". Use with oldAppointmentDate when needed.',
      ),
    appointmentSelectionRef: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        "Old appointment selection reference returned by reschedule_appointment after deterministic readback. Pass only after the caller confirms that exact old loaded appointment.",
      ),
  })
  .strict();

export const reschedule_appointment = llm.tool({
  description:
    "Reschedule a loaded appointment. " +
    "Call only after the patient is verified, the caller confirms the exact old appointment to move, get_availability returns slots, the caller confirms the exact new slot, and the caller provides a referring doctor or says they have none. " +
    "Pass appointmentSlotRef for the caller-confirmed new slot. Do not pass backend patient IDs or appointment IDs; the tool selects the old appointment from loaded appointment state. " +
    "Pass oldAppointmentDate and oldAppointmentTime when the caller identifies the old appointment by date or time; the tool will return a deterministic appointmentSelectionRef to use after confirmation. " +
    "Do not reschedule until the caller confirms the tool-returned old loaded appointment and you pass appointmentSelectionRef. " +
    "Before booking the new appointment, read back the selected new appointment date, time, and provider, then get caller confirmation. " +
    "This tool books the new appointment first and cancels the old appointment only after booking succeeds.",
  parameters: rescheduleAppointmentParameters,
  execute: async (args, { ctx }) => {
    const {
      appointmentReason,
      referringDoctor,
      readBack,
      appointmentSlotRef,
      oldAppointmentDate,
      oldAppointmentTime,
      appointmentSelectionRef,
    } = args;

    const state = getState(ctx);

    restoreConfirmedPreCallCaller(state);
    const patientId = activePatientId(state);
    if (!patientId) {
      throw new llm.ToolError("Verify the patient before rescheduling.");
    }
    const completedReschedule = completedRescheduleForPatient(state, patientId);
    if (completedReschedule) {
      const cachedSlot = selectedAvailabilitySlot(state, appointmentSlotRef);
      if (
        completedReschedule.status === "needs_human_cancellation" ||
        !cachedSlot ||
        completedRescheduleMatchesSlot(completedReschedule, cachedSlot)
      ) {
        return completedRescheduleReplayMessage(completedReschedule);
      }
    }

    const selectedSlot = selectedSlotForBooking(state, appointmentSlotRef);
    const selection = lockedCancellationAppointmentForState(state, {
      action: "reschedule",
      patientId,
      appointmentSelectionRef,
      selector: {
        appointmentDate: oldAppointmentDate,
        appointmentTime: oldAppointmentTime,
      },
    });
    if (selection.status === "ambiguous") {
      return selection.message;
    }
    if (selection.status === "not_found") {
      return selection.message;
    }
    if (selection.status === "needs_confirmation") {
      return rescheduleConfirmationMessage(
        selection.appointment,
        selection.appointmentSelectionRef,
        selectedSlot,
      );
    }
    const oldAppointment = selection.appointment;
    const cancellationOffice = getAmdOfficeForCancellationAppointment(
      state,
      oldAppointment,
    );

    if (!readBack) {
      return (
        `Read back ${spokenSlot(selectedSlot)} and ask the caller to confirm it as the new appointment. ` +
        "Call reschedule_appointment again only after the caller confirms the new appointment details are correct."
      );
    }

    ensureRoutineVisionOffice(state);
    const bookingOffice = getAmdOfficeForToolCall(state);
    const bookingRouting =
      selectedSlot.routing ??
      latestAvailabilityRouting(state) ??
      routingForAvailability(state);
    const bookingBody = bookingRequestBodyForSlot(state, {
      selectedSlot,
      patientId,
      appointmentReason,
      referringDoctor,
      appointmentTypeIdOverride: appointmentTypeIdForRescheduleBooking(
        oldAppointment,
        cancellationOffice,
        bookingOffice,
        bookingRouting,
      ),
      patientStatusOverride:
        appointmentPatientStatusForLoadedAppointment(oldAppointment),
    });

    ctx.speechHandle.allowInterruptions = false;
    const bookingResult = await callApi(
      "/api/appointment/book",
      bookingBody,
      bookingOffice,
      { includeOffice: false },
    );

    if (bookingSucceeded(bookingResult)) {
      recordBookedAppointmentInState(state, selectedSlot, bookingResult);
      clearAvailabilitySelection(state);
    } else {
      return handleRescheduleBookingFailure(
        state,
        selectedSlot,
        oldAppointment,
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
      recordCompletedReschedule(
        state,
        patientId,
        selectedSlot,
        "needs_human_cancellation",
      );
      const message = rescheduleCancellationFailureMessage(
        selectedSlot,
        "The old appointment was not cancelled.",
      );
      recordRescheduleAction(state, {
        status: "partial",
        message,
        selectedSlot,
        bookingResult,
        oldAppointment,
      });
      return message;
    }

    if (cancelResult?.status !== "cancelled") {
      recordCompletedReschedule(
        state,
        patientId,
        selectedSlot,
        "needs_human_cancellation",
      );
      const message = rescheduleCancellationFailureMessage(
        selectedSlot,
        cancelResult?.message ?? "The old appointment was not cancelled.",
      );
      recordRescheduleAction(state, {
        status: "partial",
        message,
        selectedSlot,
        bookingResult,
        oldAppointment,
      });
      return message;
    }

    removeAppointmentById(state, oldAppointment.id);
    recordCompletedReschedule(state, patientId, selectedSlot, "rescheduled");
    const message = rescheduledAppointmentMessage(
      selectedSlot,
      bookingResult,
      oldAppointment,
    );
    recordRescheduleAction(state, {
      status: "success",
      message,
      selectedSlot,
      bookingResult,
      oldAppointment,
    });
    return message;
  },
});

function rescheduleConfirmationMessage(
  oldAppointment: Parameters<typeof spokenAppointment>[0],
  appointmentSelectionRef: string,
  selectedSlot: StoredAvailabilitySlot,
): string {
  return (
    `Read back exactly: I have you moving ${spokenAppointment(oldAppointment)} to ${spokenSlot(selectedSlot)}. ` +
    "Ask the caller to confirm both appointment details. " +
    `Call reschedule_appointment again with appointmentSelectionRef "${appointmentSelectionRef}" and readBack true only after the caller confirms.`
  );
}

function completedRescheduleReplayMessage(
  completedReschedule: CompletedRescheduleState,
): string {
  if (completedReschedule.status === "needs_human_cancellation") {
    return "The new appointment was already booked, but the old appointment still needs office staff to finish cancellation. Transfer the caller instead of rescheduling again.";
  }

  return `The appointment is already rescheduled to ${completedReschedule.appointmentDescription}. Tell the caller the confirmed appointment details instead of rescheduling again.`;
}

function completedRescheduleMatchesSlot(
  completedReschedule: CompletedRescheduleState,
  selectedSlot: StoredAvailabilitySlot,
): boolean {
  return (
    completedReschedule.appointmentDescription === spokenSlot(selectedSlot)
  );
}

function recordCompletedReschedule(
  state: CallState,
  patientId: string,
  selectedSlot: StoredAvailabilitySlot,
  status: CompletedRescheduleState["status"],
): void {
  recordCompletedRescheduleForPatient(state, patientId, {
    status,
    appointmentDescription: spokenSlot(selectedSlot),
  });
}

function appointmentTypeIdForRescheduleBooking(
  appointment: CallerAppointment,
  cancellationOffice: string,
  bookingOffice: string,
  bookingRouting: string | null,
): number | null {
  if (appointment.appointmentTypeId === undefined) return null;
  if (bookingRouting === "optical_only") return null;
  if (
    !RESCHEDULE_BOOKING_APPOINTMENT_TYPE_IDS.has(appointment.appointmentTypeId)
  ) {
    return null;
  }
  if (
    normalizePhoneNumber(cancellationOffice) !==
    normalizePhoneNumber(bookingOffice)
  ) {
    return null;
  }
  return appointment.appointmentTypeId;
}

const RESCHEDULE_BOOKING_APPOINTMENT_TYPE_IDS = new Set([
  1004, 1005, 1006, 1007, 1008, 1010, 3364, 4244, 4245, 6167, 6168, 6169,
]);

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
  selectedSlot: StoredAvailabilitySlot,
  oldAppointment: CallerAppointment,
  bookingResult: unknown,
): string {
  if (bookingHadPositiveStatusWithoutAppointmentId(bookingResult)) {
    clearAvailabilitySelection(state);
    const message =
      "I could not confirm the new booking because the appointment ID was missing, so I did not cancel the existing appointment. Check availability again before booking.";
    recordRescheduleAction(state, {
      status: "error",
      message,
      selectedSlot,
      bookingResult,
      oldAppointment,
    });
    return message;
  }

  const outcome = bookingOutcome(bookingResult);
  if (outcome === "slot_unavailable") {
    const remainingSlots = removeAvailabilitySlot(state, selectedSlot.slotId);
    const message = `${slotUnavailableMessage(remainingSlots)} I did not cancel the existing appointment.`;
    recordRescheduleAction(state, {
      status: "error",
      message,
      selectedSlot,
      bookingResult,
      oldAppointment,
    });
    return message;
  }
  if (
    outcome === "invalid_booking_token" ||
    outcome === "booking_token_required"
  ) {
    clearAvailabilitySelection(state);
  }

  const message = `${bookingFailureMessage(bookingResult)} I did not cancel the existing appointment.`;
  recordRescheduleAction(state, {
    status: "error",
    message,
    selectedSlot,
    bookingResult,
    oldAppointment,
  });
  return message;
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

function rescheduledAppointmentMessage(
  selectedSlot: StoredAvailabilitySlot,
  bookingResult: unknown,
  oldAppointment: CallerAppointment,
): string {
  return (
    `Rescheduled the appointment to ${spokenSlot(selectedSlot)}. ` +
    `Cancelled the old appointment on ${oldAppointment.date} at ${oldAppointment.time}.` +
    bookingNoteWarning(bookingResult)
  );
}

function recordRescheduleAction(
  state: CallState,
  input: {
    status: "success" | "partial" | "error";
    message: string;
    selectedSlot: StoredAvailabilitySlot;
    bookingResult: unknown;
    oldAppointment: CallerAppointment;
  },
): void {
  recordAppointmentAction(state, {
    action: "rescheduled",
    status: input.status,
    toolName: "reschedule_appointment",
    message: input.message,
    appointment: bookedSlotAppointmentAnalytics(
      state,
      input.selectedSlot,
      input.bookingResult,
    ),
    cancelledAppointment: cancelledAppointmentAnalytics(
      state,
      input.oldAppointment,
    ),
  });
}

type CancelAppointmentResult = {
  status?: string;
  message?: string;
};
