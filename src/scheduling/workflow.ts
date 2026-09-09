import {
  getOfficeProfileByFacility,
  isDemoOfficeKey,
  normalizePhoneNumber,
  type AvailabilityOfficeKey,
} from "../customers/abita/profile.js";
import { incompletePatientRegistrationMessage } from "../identity/patient-identity.js";
import { activeOfficeKey } from "../state/call-lifecycle.js";
import {
  completedBookingForPatient,
  completedRescheduleForPatient,
  recordCompletedBookingForPatient,
  recordCompletedCancellationForPatient,
  recordCompletedRescheduleForPatient,
  removeActiveAppointment,
  replaceActiveAppointments,
} from "../state/appointments.js";
import {
  activePatientDob,
  activePatientId,
  activePatientName,
  type AppointmentActionAnalytics,
  type AppointmentAnalytics,
  type CallState,
  type CallerAppointment,
  type CompletedRescheduleState,
  type SchedulingAppointmentLane,
  type StoredAvailabilitySlot,
} from "../state/call-state.js";
import {
  appointmentActions,
  recordAppointmentAction,
  recordOwnedMiddlewareFailure,
} from "../state/observability.js";
import {
  activeRoutingContext,
  clearAvailabilitySelection,
  removeAvailabilitySlot,
  applySchedulingLaneToState,
} from "./state.js";
import {
  appointmentActionStatusForBookingResult,
  bookedSlotAppointmentAnalytics,
  cancelledAppointmentAnalytics,
} from "./observability.js";
import {
  selectedAvailabilitySlot,
  storeAvailabilitySlots,
} from "./availability.js";
import {
  availabilityReadGeneration,
  availabilityReadCanRetry,
  availabilityResultHasExpiredBookingTokens,
  cacheCompletedAvailabilityRead,
  coordinatedAvailabilityRead,
  discardAvailabilityRead,
  invalidateAvailabilityCacheForExpiredResult,
  invalidateAvailabilityReads,
} from "./availability-coordinator.js";
import {
  recordBookedAppointmentInState,
  rescheduleAppointmentForState,
  cancellationAppointmentForState,
  completedCancellationForState,
} from "./appointments.js";
import {
  appointmentPatientStatusForLoadedAppointment,
  bookedAppointmentMessage,
  bookingFailureMessage,
  bookingHadPositiveStatusWithoutAppointmentId,
  bookingNoteWarning,
  bookingRequestBodyForSlot,
  bookingSucceeded,
  selectedSlotForBooking,
  slotUnavailableMessage,
  spokenSlot,
} from "./booking.js";
import {
  getAmdOfficeForToolCall,
  medicalSchedulingUnavailable,
  routingForAvailability,
  visitTypeForAppointment,
  routineVisionSchedulingUnavailable,
  selectAvailabilityOffice,
} from "./routing.js";
import {
  availabilityContextRecovery,
  ensureAvailabilityContext,
} from "./context.js";
import { SchedulingInputRequired } from "./input-required.js";
import { spokenAppointmentDate } from "./spoken-date.js";
import { throwOwnedMiddlewareFailure } from "../runtime/middleware-tool-failure.js";
import type {
  AvailabilityRequest as MiddlewareAvailabilityRequest,
  AvailabilityResult,
  BookingResult,
  BookingSuccess,
  CancellationRequest,
  CancellationResult,
  SchedulingMiddleware,
} from "./middleware.js";
import {
  addCalendarDays,
  clinicIsoDate,
  systemSchedulingClock,
  type SchedulingClock,
} from "./clock.js";

export interface AvailabilityLookupArgs {
  startDate?: string;
  appointmentLane?: SchedulingAppointmentLane;
  office?: AvailabilityOfficeKey;
}

export interface BookAppointmentArgs {
  appointmentSlotRef: string;
  appointmentReason: string;
  referringDoctor: string;
  readBack?: boolean;
}

export interface CancelAppointmentArgs {
  appointmentRef: string;
}

export interface RescheduleAppointmentArgs extends BookAppointmentArgs {
  oldAppointmentRef: string;
}

export class SchedulingWorkflow {
  constructor(
    private readonly middleware: SchedulingMiddleware,
    private readonly clock: SchedulingClock = systemSchedulingClock,
  ) {}

  async getAvailability(
    state: CallState,
    args: AvailabilityLookupArgs,
    signal?: AbortSignal,
  ): Promise<string> {
    const now = this.clock.now();
    const request = buildAvailabilityLookupRequestForState(state, {
      ...args,
      cacheDay: clinicIsoDate(now),
    });
    if ("blocked" in request) return request.blocked;

    const office = getAmdOfficeForToolCall(state);
    let result: AvailabilityResult;
    for (let attempt = 0; ; attempt += 1) {
      result = await coordinatedAvailabilityRead(
        state,
        request.backendKey,
        () =>
          this.middleware.getAvailability({
            request: request.body,
            office,
            ...(signal ? { signal } : {}),
          }),
        {
          now: this.clock.now(),
          signal,
        },
      );
      if (signal?.aborted || !availabilityRequestStillCurrent(state, request)) {
        discardAvailabilityRead(state, request.backendKey, result);
        return "The patient or appointment changed while I was checking. Let me check again with the current details.";
      }
      if (
        !availabilityResultHasExpiredBookingTokens(result, this.clock.now())
      ) {
        break;
      }

      clearAvailabilitySelection(state);
      invalidateAvailabilityCacheForExpiredResult(
        state,
        request.backendKey,
        result,
      );
      if (attempt > 0) {
        return "Those openings expired before I could offer them. Let me check again.";
      }
    }
    try {
      const response = storeAvailabilitySlots(
        state,
        result,
        request.routing,
        availabilityReadCanRetry(state, request.backendKey),
      );
      if (response.cacheable) {
        state.availability.refreshAfter = cacheCompletedAvailabilityRead(
          state,
          request.backendKey,
          result,
          this.clock.now(),
        );
      } else {
        discardAvailabilityRead(state, request.backendKey, result);
      }
      return response.message;
    } catch (error) {
      discardAvailabilityRead(state, request.backendKey, result);
      throw error;
    }
  }

  async bookAppointment(
    state: CallState,
    {
      appointmentSlotRef,
      appointmentReason,
      referringDoctor,
      readBack,
    }: BookAppointmentArgs,
    callId: string,
  ): Promise<string> {
    const incompleteRegistration = incompletePatientRegistrationMessage(state);
    if (incompleteRegistration) return incompleteRegistration;
    const patientId = activePatientId(state);
    if (patientId && hasCompletedBookingForActivePatient(state)) {
      clearAvailabilitySelection(state);
      replayAppointmentOutcome(state, callId, patientId, "booked");
      return "That appointment is already booked.";
    }

    ensureNewAppointmentBookingContext(state);

    if (!patientId) {
      throw new SchedulingInputRequired(
        "I need to verify or create the patient before booking.",
      );
    }
    const patientName = activePatientName(state);

    const unsupportedRoutineVisionScheduling =
      routineVisionSchedulingUnavailable(state);
    if (unsupportedRoutineVisionScheduling)
      return unsupportedRoutineVisionScheduling;
    const selectedSlot = selectedSlotForBooking(state, appointmentSlotRef);
    const bookingBody = bookingRequestBodyForSlot(state, {
      selectedSlot,
      patientId,
      appointmentReason,
      referringDoctor,
      now: this.clock.now(),
    });
    if (!readBack) {
      return `Let me confirm: ${spokenSlot(selectedSlot)}. Is that correct?`;
    }

    const result = await this.middleware.bookAppointment({
      request: bookingBody,
      office: getAmdOfficeForToolCall(state),
    });

    if (result.status === "error") {
      recordOwnedMiddlewareFailure(state, "bookAppointment", result);
    }

    if (activePatientId(state) !== patientId) {
      const message = bookingSucceeded(result)
        ? bookedAppointmentMessage(selectedSlot, result)
        : bookingFailureMessage(result);
      if (bookingSucceeded(result)) {
        recordCompletedBookingForPatient(state, patientId, {
          appointmentId: result.appointmentId,
          appointmentDescription: spokenSlot(selectedSlot),
        });
      }
      recordAppointmentAction(state, callId, {
        action: "booked",
        ...bookingActionEvidence(patientId, result),
        status: bookingSucceeded(result)
          ? appointmentActionStatusForBookingResult(result)
          : "error",
        toolName: "book_appointment",
        message,
        appointment: appointmentAnalyticsForCapturedBooking(
          patientName,
          selectedSlot,
          result,
        ),
      });
      if (result.status === "error") {
        return "I couldn't book the appointment, and the patient changed while I was working.";
      }
      return `${message} The patient changed while I was working.`;
    }

    if (bookingSucceeded(result)) {
      recordCompletedBookingForPatient(state, patientId, {
        appointmentId: result.appointmentId,
        appointmentDescription: spokenSlot(selectedSlot),
      });
      recordBookedAppointmentInState(state, selectedSlot, result);
      clearAvailabilitySelection(state, {
        invalidateReads: "booking_succeeded",
      });
      const message = bookedAppointmentMessage(selectedSlot, result);
      recordAppointmentAction(state, callId, {
        action: "booked",
        ...bookingActionEvidence(patientId, result),
        status: appointmentActionStatusForBookingResult(result),
        toolName: "book_appointment",
        message,
        appointment: bookedSlotAppointmentAnalytics(
          state,
          selectedSlot,
          result,
        ),
      });
      return message;
    }
    if (bookingHadPositiveStatusWithoutAppointmentId(result)) {
      clearAvailabilitySelection(state, {
        invalidateReads: "booking_authorization_invalidated",
      });
      const message = bookingFailureMessage(result);
      recordAppointmentAction(state, callId, {
        action: "booked",
        ...bookingActionEvidence(patientId, result),
        status: "error",
        toolName: "book_appointment",
        message,
        appointment: bookedSlotAppointmentAnalytics(
          state,
          selectedSlot,
          result,
        ),
      });
      if (result.status === "error") {
        throwOwnedMiddlewareFailure(
          result,
          "I couldn't book the appointment. I can try once more or connect you with the office.",
        );
      }
      return message;
    }

    if (result.status === "unavailable") {
      invalidateAvailabilityReads(state, "booking_authorization_invalidated");
      removeAvailabilitySlot(state, selectedSlot.slotId);
      state.availability.refreshAfter = 0;
      const message = slotUnavailableMessage();
      recordAppointmentAction(state, callId, {
        action: "booked",
        ...bookingActionEvidence(patientId, result),
        status: "error",
        toolName: "book_appointment",
        message,
        appointment: bookedSlotAppointmentAnalytics(
          state,
          selectedSlot,
          result,
        ),
      });
      return message;
    }
    if (result.status === "rejected") {
      clearAvailabilitySelection(state, {
        invalidateReads: "booking_authorization_invalidated",
      });
    }

    const message = bookingFailureMessage(result);
    recordAppointmentAction(state, callId, {
      action: "booked",
      ...bookingActionEvidence(patientId, result),
      status: "error",
      toolName: "book_appointment",
      message,
      appointment: bookedSlotAppointmentAnalytics(state, selectedSlot, result),
    });
    if (result.status === "error") {
      throwOwnedMiddlewareFailure(
        result,
        "I couldn't book the appointment. I can try once more or connect you with the office.",
      );
    }
    return message;
  }

  async cancelAppointment(
    state: CallState,
    { appointmentRef }: CancelAppointmentArgs,
    callId: string,
  ): Promise<string> {
    const patientId = activePatientId(state);
    if (!patientId) {
      throw new SchedulingInputRequired(
        "I need to verify the patient before cancelling.",
      );
    }

    const selector = { appointmentRef };
    const selection = cancellationAppointmentForState(state, selector);
    if (selection.status === "ambiguous") {
      return selection.message;
    }
    if (selection.status === "not_found") {
      const cancelledAppointment = completedCancellationForState(
        state,
        selector,
      );
      if (cancelledAppointment) {
        replayAppointmentOutcome(
          state,
          callId,
          patientId,
          "cancelled",
          String(cancelledAppointment.id),
        );
        return completedCancellationReplayMessage(cancelledAppointment);
      }
      throw new SchedulingInputRequired(selection.message);
    }
    const appointment = selection.appointment;
    const completedCancellation = completedCancellationForState(state, {
      appointmentRef,
    });
    if (completedCancellation) {
      replayAppointmentOutcome(
        state,
        callId,
        patientId,
        "cancelled",
        String(completedCancellation.id),
      );
      return completedCancellationReplayMessage(completedCancellation);
    }
    const patientName = activePatientName(state);

    const result = await this.middleware.cancelAppointment({
      request: cancellationRequestForAppointment(appointment, patientId),
      office: getAmdOfficeForToolCall(state),
    });

    if (result.status !== "cancelled") {
      recordOwnedMiddlewareFailure(state, "cancelAppointment", result);
    }

    if (activePatientId(state) !== patientId) {
      const message =
        result.status === "cancelled"
          ? `Cancelled the appointment on ${appointment.date} at ${appointment.time}.`
          : "The appointment was not cancelled.";
      if (result.status === "cancelled") {
        recordCompletedCancellationForPatient(state, patientId, appointment);
      }
      recordAppointmentAction(state, callId, {
        action: "cancelled",
        ...cancellationActionEvidence(patientId, appointment, result),
        status: result.status === "cancelled" ? "success" : "error",
        toolName: "cancel_appointment",
        message,
        cancelledAppointment: cancelledAppointmentAnalytics(
          state,
          appointment,
          patientName,
        ),
      });
      if (result.status === "error") {
        return "I couldn't cancel that appointment because the patient changed.";
      }
      return message;
    }

    if (
      result.status === "rejected" &&
      result.reason === "invalid_cancellation_token"
    ) {
      replaceActiveAppointments(state, [], "error");
      const message =
        "The appointment details expired. I need to reload the appointments and confirm which one you want to cancel.";
      recordAppointmentAction(state, callId, {
        action: "cancelled",
        ...cancellationActionEvidence(patientId, appointment, result),
        status: "error",
        toolName: "cancel_appointment",
        message,
        cancelledAppointment: cancelledAppointmentAnalytics(state, appointment),
      });
      return message;
    }

    if (result.status !== "cancelled") {
      const message = "The appointment was not cancelled.";
      recordAppointmentAction(state, callId, {
        action: "cancelled",
        ...cancellationActionEvidence(patientId, appointment, result),
        status: "error",
        toolName: "cancel_appointment",
        message,
        cancelledAppointment: cancelledAppointmentAnalytics(state, appointment),
      });
      throwOwnedMiddlewareFailure(
        result,
        "I couldn't cancel the appointment. I can try once more or connect you with the office.",
      );
    }

    removeActiveAppointment(state, appointment.id);
    clearAvailabilitySelection(state, {
      invalidateReads: "cancellation_succeeded",
    });
    const message = `Cancelled the appointment on ${appointment.date} at ${appointment.time}.`;
    recordAppointmentAction(state, callId, {
      action: "cancelled",
      ...cancellationActionEvidence(patientId, appointment, result),
      status: "success",
      toolName: "cancel_appointment",
      message,
      cancelledAppointment: cancelledAppointmentAnalytics(state, appointment),
    });
    return message;
  }

  async rescheduleAppointment(
    state: CallState,
    {
      appointmentReason,
      referringDoctor,
      readBack,
      appointmentSlotRef,
      oldAppointmentRef,
    }: RescheduleAppointmentArgs,
    callId: string,
  ): Promise<string> {
    const patientId = activePatientId(state);
    if (!patientId) {
      throw new SchedulingInputRequired(
        "I need to verify the patient before rescheduling.",
      );
    }
    const patientName = activePatientName(state);
    const selectedAppointmentRef = oldAppointmentRef?.trim();
    if (!selectedAppointmentRef) {
      throw new SchedulingInputRequired(
        "Which upcoming appointment would you like to reschedule?",
      );
    }
    const completedReschedule = completedRescheduleForPatient(state, patientId);
    // A completed move protects replay of that move, not a different selected
    // appointment. Partial cancellation still requires staff recovery first.
    if (
      completedReschedule &&
      (completedReschedule.status === "needs_human_cancellation" ||
        completedReschedule.originalAppointmentRef === selectedAppointmentRef ||
        completedReschedule.replacementAppointmentRef ===
          selectedAppointmentRef)
    ) {
      const cachedSlot = selectedAvailabilitySlot(state, appointmentSlotRef);
      if (
        completedReschedule.status === "needs_human_cancellation" ||
        !cachedSlot ||
        completedRescheduleMatchesSlot(completedReschedule, cachedSlot)
      ) {
        replayAppointmentOutcome(state, callId, patientId, "rescheduled");
        return completedRescheduleReplayMessage(completedReschedule);
      }
    }

    const selectedSlot = selectedSlotForBooking(state, appointmentSlotRef);
    const selection = rescheduleAppointmentForState(
      state,
      selectedAppointmentRef,
    );
    if (selection.status === "ambiguous") {
      return selection.message;
    }
    if (selection.status === "not_found") {
      throw new SchedulingInputRequired(selection.message);
    }
    const oldAppointment = selection.appointment;
    const slotVisitType =
      selectedSlot.routing === "optical_only" ? "routine_vision" : "medical";
    if (slotVisitType !== visitTypeForAppointment(oldAppointment)) {
      return `The existing appointment is ${visitTypeForAppointment(oldAppointment) === "medical" ? "medical" : "routine vision"}. Load matching availability before rescheduling it.`;
    }
    const cancellationOffice = getAmdOfficeForCancellationAppointment(
      state,
      oldAppointment,
    );

    if (!readBack) {
      return `Let me confirm the new appointment: ${spokenSlot(selectedSlot)}. Is that correct?`;
    }

    const unsupportedRoutineVisionScheduling =
      routineVisionSchedulingUnavailable(state);
    if (unsupportedRoutineVisionScheduling)
      return unsupportedRoutineVisionScheduling;
    const bookingOffice = getAmdOfficeForToolCall(state);
    const bookingBody = bookingRequestBodyForSlot(state, {
      selectedSlot,
      patientId,
      appointmentReason,
      referringDoctor,
      now: this.clock.now(),
      appointmentTypeIdOverride:
        appointmentTypeIdForRescheduleBooking(oldAppointment),
      rescheduleToken: oldAppointment.rescheduleToken,
      patientStatusOverride:
        appointmentPatientStatusForLoadedAppointment(oldAppointment),
    });

    const bookingResult = await this.middleware.bookAppointment({
      request: bookingBody,
      office: bookingOffice,
    });

    if (bookingResult.status === "error") {
      recordOwnedMiddlewareFailure(state, "bookAppointment", bookingResult);
    }

    if (activePatientId(state) !== patientId) {
      if (bookingSucceeded(bookingResult)) {
        recordCompletedReschedule(
          state,
          patientId,
          selectedSlot,
          "needs_human_cancellation",
          selectedAppointmentRef,
        );
        const message = rescheduleCancellationFailureMessage(
          selectedSlot,
          "The active patient changed before the old appointment could be cancelled.",
        );
        recordCapturedRescheduleAction(state, callId, {
          status: "partial",
          message,
          patientName,
          selectedSlot,
          bookingResult,
          oldAppointment,
          patientId,
          cancellationResult: {
            status: "not_attempted",
            reason: "patient_changed",
          },
        });
        return message;
      }
      const message = `${bookingFailureMessage(bookingResult)} I did not cancel the existing appointment. The active patient changed before the old appointment could be cancelled.`;
      recordCapturedRescheduleAction(state, callId, {
        status: "error",
        message,
        patientName,
        selectedSlot,
        bookingResult,
        oldAppointment,
        patientId,
        cancellationResult: {
          status: "not_attempted",
          reason: "booking_failed",
        },
      });
      return message;
    }

    let replacementAppointmentRef: string;
    if (bookingSucceeded(bookingResult)) {
      replacementAppointmentRef = recordBookedAppointmentInState(
        state,
        selectedSlot,
        bookingResult,
      );
      clearAvailabilitySelection(state, {
        invalidateReads: "reschedule_succeeded",
      });
    } else {
      return handleRescheduleBookingFailure(
        state,
        patientId,
        selectedSlot,
        oldAppointment,
        bookingResult,
        callId,
      );
    }

    let cancelResult: CancellationResult;
    const cancellationRequest = cancellationRequestForAppointment(
      oldAppointment,
      patientId,
    );
    try {
      cancelResult = await this.middleware.cancelAppointment({
        request: cancellationRequest,
        office:
          "cancellationToken" in cancellationRequest
            ? bookingOffice
            : cancellationOffice,
      });
    } catch {
      recordOwnedMiddlewareFailure(state, "cancelAppointment", {
        reason: "network_error",
      });
      if (activePatientId(state) !== patientId) {
        recordCompletedReschedule(
          state,
          patientId,
          selectedSlot,
          "needs_human_cancellation",
          selectedAppointmentRef,
        );
        const message = rescheduleCancellationFailureMessage(
          selectedSlot,
          "The old appointment was not cancelled.",
        );
        recordCapturedRescheduleAction(state, callId, {
          status: "partial",
          message,
          patientName,
          selectedSlot,
          bookingResult,
          oldAppointment,
          patientId,
          cancellationResult: { status: "error", reason: "network_error" },
        });
        return message;
      }
      recordCompletedReschedule(
        state,
        patientId,
        selectedSlot,
        "needs_human_cancellation",
        selectedAppointmentRef,
      );
      const message = rescheduleCancellationFailureMessage(
        selectedSlot,
        "The old appointment was not cancelled.",
      );
      recordRescheduleAction(state, callId, {
        status: "partial",
        message,
        selectedSlot,
        bookingResult,
        oldAppointment,
        patientId,
        cancellationResult: { status: "error", reason: "network_error" },
      });
      return message;
    }

    if (cancelResult.status !== "cancelled") {
      recordOwnedMiddlewareFailure(state, "cancelAppointment", cancelResult);
    }

    if (activePatientId(state) !== patientId) {
      const cancelled = cancelResult.status === "cancelled";
      recordCompletedReschedule(
        state,
        patientId,
        selectedSlot,
        cancelled ? "rescheduled" : "needs_human_cancellation",
        selectedAppointmentRef,
        replacementAppointmentRef,
      );
      const outcomeMessage = cancelled
        ? rescheduledAppointmentMessage(
            selectedSlot,
            bookingResult,
            oldAppointment,
          )
        : rescheduleCancellationFailureMessage(
            selectedSlot,
            "The old appointment was not cancelled.",
          );
      const message = outcomeMessage;
      recordCapturedRescheduleAction(state, callId, {
        status: cancelled ? "success" : "partial",
        message,
        patientName,
        selectedSlot,
        bookingResult,
        oldAppointment,
        patientId,
        cancellationResult: { ...cancelResult },
      });
      return message;
    }

    if (cancelResult.status !== "cancelled") {
      recordCompletedReschedule(
        state,
        patientId,
        selectedSlot,
        "needs_human_cancellation",
        selectedAppointmentRef,
      );
      const message = rescheduleCancellationFailureMessage(
        selectedSlot,
        "The old appointment was not cancelled.",
      );
      recordRescheduleAction(state, callId, {
        status: "partial",
        message,
        selectedSlot,
        bookingResult,
        oldAppointment,
        patientId,
        cancellationResult: { ...cancelResult },
      });
      return message;
    }

    removeActiveAppointment(state, oldAppointment.id);
    recordCompletedReschedule(
      state,
      patientId,
      selectedSlot,
      "rescheduled",
      selectedAppointmentRef,
      replacementAppointmentRef,
    );
    const message = rescheduledAppointmentMessage(
      selectedSlot,
      bookingResult,
      oldAppointment,
    );
    recordRescheduleAction(state, callId, {
      status: "success",
      message,
      selectedSlot,
      bookingResult,
      oldAppointment,
      patientId,
      cancellationResult: { ...cancelResult },
    });
    return message;
  }
}

function cancellationRequestForAppointment(
  appointment: CallerAppointment,
  patientId: string,
): CancellationRequest {
  const cancellationToken = appointment.cancellationToken?.trim();
  return cancellationToken
    ? { cancellationToken }
    : { appointmentId: appointment.id, patientId };
}

function availabilityRequestStillCurrent(
  state: CallState,
  request: AvailabilityWorkflowRequest,
): boolean {
  return (
    state.availability.requestedStartDate === request.body.startDate &&
    availabilityBackendKey(state, {
      body: request.body,
      cacheDay: request.cacheDay,
      patientId: activePatientId(state),
      routing: request.routing,
    }) === request.backendKey
  );
}

type AvailabilityWorkflowRequest = {
  body: MiddlewareAvailabilityRequest;
  backendKey: string;
  cacheDay: string;
  routing: string | null;
};

function buildAvailabilityLookupRequestForState(
  state: CallState,
  args: AvailabilityLookupArgs & {
    cacheDay: string;
  },
): AvailabilityWorkflowRequest | { blocked: string } {
  const { cacheDay } = args;
  if (args.startDate && args.startDate <= cacheDay) {
    return {
      blocked:
        `Same-day and past-date appointments cannot be scheduled here. The earliest search date is ${spokenAppointmentDate(addCalendarDays(cacheDay, 1))}. ` +
        "Ask whether that date or later works; do not retry the same date or change it without the caller's agreement. Follow office policy if the caller needs help today.",
    };
  }
  const incompleteRegistration = incompletePatientRegistrationMessage(state);
  if (incompleteRegistration) {
    return { blocked: incompleteRegistration };
  }
  const patientId = activePatientId(state);
  if (!patientId) {
    return {
      blocked:
        "I need to verify or create the patient before checking availability.",
    };
  }

  const officeSelection = selectAvailabilityOffice(state, args.office);
  if (officeSelection) return { blocked: officeSelection };

  if (args.appointmentLane)
    applySchedulingLaneToState(state, args.appointmentLane);
  const contextRecovery = availabilityContextRecovery(state);
  if (contextRecovery) return { blocked: contextRecovery };
  ensureAvailabilityContext(state, "checking availability");
  const unsupportedMedicalScheduling = medicalSchedulingUnavailable(state);
  if (unsupportedMedicalScheduling)
    return { blocked: unsupportedMedicalScheduling };
  const unsupportedRoutineVisionScheduling =
    routineVisionSchedulingUnavailable(state);
  if (unsupportedRoutineVisionScheduling)
    return { blocked: unsupportedRoutineVisionScheduling };
  const routing = routingForAvailability(state);
  const startDate = args.startDate ?? addCalendarDays(cacheDay, 1);
  state.availability.requestedStartDate = startDate;
  const body: MiddlewareAvailabilityRequest = { startDate, rangeDays: 14 };
  const dob = activePatientDob(state);
  if (dob) body.dob = dob;
  if (routing) body.routing = routing;
  if (activeRoutingContext(state).preauthRequired) body.preauthRequired = true;
  return {
    body,
    backendKey: availabilityBackendKey(state, {
      body,
      cacheDay,
      patientId,
      routing,
    }),
    cacheDay,
    routing,
  };
}

function availabilityBackendKey(
  state: CallState,
  input: {
    body: MiddlewareAvailabilityRequest;
    cacheDay: string;
    patientId: string | null;
    routing: string | null;
  },
): string {
  const turn = state.workflow.current;
  return JSON.stringify({
    availabilityGeneration: availabilityReadGeneration(state),
    patientContextGeneration: state.identity.transitionVersion,
    patientId: input.patientId?.trim() || null,
    officeProfile: state.office.activeKey,
    providerOffice: normalizePhoneNumber(getAmdOfficeForToolCall(state)),
    intent: turn?.intent ?? null,
    appointmentLane: turn?.appointmentLane ?? null,
    cacheDay: input.cacheDay,
    startDate: input.body.startDate,
    dob:
      typeof input.body.dob === "string" ? input.body.dob.trim() || null : null,
    routing: input.routing,
    preauthRequired: input.body.preauthRequired === true,
  });
}

function ensureNewAppointmentBookingContext(state: CallState): void {
  const turn = state.workflow.current;
  if (turn?.intent === "change_appointment") {
    throw new SchedulingInputRequired(
      "This is an appointment change, so I need to move the existing appointment instead of booking another one.",
    );
  }
  if (
    turn?.intent === "schedule" &&
    (turn.appointmentLane === "medical_md" ||
      turn.appointmentLane === "routine_od")
  ) {
    return;
  }
  throw new SchedulingInputRequired(
    "Is this visit for medical care or routine vision?",
  );
}

function hasCompletedBookingForActivePatient(state: CallState): boolean {
  const patientId = activePatientId(state);
  return Boolean(patientId && completedBookingForPatient(state, patientId));
}

function completedCancellationReplayMessage(
  appointment: CallerAppointment,
): string {
  return `That appointment was already cancelled on this call. It was scheduled for ${appointment.date} at ${appointment.time}.`;
}

function appointmentAnalyticsForCapturedBooking(
  patientName: string | null,
  selectedSlot: StoredAvailabilitySlot,
  result: BookingResult,
): AppointmentAnalytics {
  const booking = bookingSucceeded(result) ? result : null;
  return {
    ...(patientName ? { patientName } : {}),
    appointmentDate: selectedSlot.date,
    appointmentTime: selectedSlot.time,
    startDatetime: selectedSlot.datetime,
    providerName: booking?.providerName ?? selectedSlot.provider,
    ...(booking?.locationName ? { locationName: booking.locationName } : {}),
    ...(booking?.appointmentTypeName
      ? { appointmentTypeName: booking.appointmentTypeName }
      : {}),
  };
}

function completedRescheduleReplayMessage(
  completedReschedule: CompletedRescheduleState,
): string {
  if (completedReschedule.status === "needs_human_cancellation") {
    return "The new appointment is booked, but the old appointment still needs office staff to cancel it. Would you like me to transfer you?";
  }
  return `You're already rescheduled for ${completedReschedule.appointmentDescription}.`;
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
  originalAppointmentRef: string,
  replacementAppointmentRef?: string,
): void {
  recordCompletedRescheduleForPatient(state, patientId, {
    status,
    originalAppointmentRef,
    ...(replacementAppointmentRef ? { replacementAppointmentRef } : {}),
    appointmentDescription: spokenSlot(selectedSlot),
  });
}

function appointmentTypeIdForRescheduleBooking(
  appointment: CallerAppointment,
): number | null {
  if (appointment.appointmentTypeId === undefined) return null;
  if (
    !appointment.rescheduleToken &&
    !RESCHEDULE_BOOKING_APPOINTMENT_TYPE_IDS.has(appointment.appointmentTypeId)
  )
    return null;
  return appointment.appointmentTypeId;
}

const RESCHEDULE_BOOKING_APPOINTMENT_TYPE_IDS = new Set([
  1004, 1005, 1006, 1007, 1008, 1010, 3364, 4244, 4245, 6167, 6168, 6169,
]);

function getAmdOfficeForCancellationAppointment(
  state: CallState,
  appointment: CallerAppointment,
): string {
  if (isDemoOfficeKey(activeOfficeKey(state))) {
    return getAmdOfficeForToolCall(state);
  }
  const office = getOfficeProfileByFacility(appointment.facility);
  if (!office) return getAmdOfficeForToolCall(state);
  return state.office.phoneOverrides?.[office.key] ?? office.amdOfficePhone;
}

function handleRescheduleBookingFailure(
  state: CallState,
  patientId: string,
  selectedSlot: StoredAvailabilitySlot,
  oldAppointment: CallerAppointment,
  bookingResult: BookingResult,
  callId: string,
): string {
  if (bookingHadPositiveStatusWithoutAppointmentId(bookingResult)) {
    clearAvailabilitySelection(state, {
      invalidateReads: "booking_authorization_invalidated",
    });
    const message =
      "I couldn't confirm the new booking, so your existing appointment is still scheduled. Let me check availability again.";
    recordRescheduleAction(state, callId, {
      status: "error",
      message,
      selectedSlot,
      bookingResult,
      oldAppointment,
      patientId,
      cancellationResult: {
        status: "not_attempted",
        reason: "booking_failed",
      },
    });
    if (bookingResult.status === "error") {
      throwOwnedMiddlewareFailure(
        bookingResult,
        "I couldn't book the new appointment. I did not cancel the existing appointment.",
      );
    }
    return message;
  }

  if (bookingResult.status === "unavailable") {
    invalidateAvailabilityReads(state, "booking_authorization_invalidated");
    removeAvailabilitySlot(state, selectedSlot.slotId);
    state.availability.refreshAfter = 0;
    const message = `${slotUnavailableMessage()} I did not cancel the existing appointment.`;
    recordRescheduleAction(state, callId, {
      status: "error",
      message,
      selectedSlot,
      bookingResult,
      oldAppointment,
      patientId,
      cancellationResult: {
        status: "not_attempted",
        reason: "booking_failed",
      },
    });
    return message;
  }
  if (
    bookingResult.status === "rejected" &&
    bookingResult.reason === "invalid_reschedule_token"
  ) {
    clearAvailabilitySelection(state, {
      invalidateReads: "booking_authorization_invalidated",
    });
    replaceActiveAppointments(state, [], "error");
    const message =
      "I couldn't reschedule because the appointment details expired. Your existing appointment is still scheduled. I need to reload it and check availability again.";
    recordRescheduleAction(state, callId, {
      status: "error",
      message,
      selectedSlot,
      bookingResult,
      oldAppointment,
      patientId,
      cancellationResult: {
        status: "not_attempted",
        reason: "booking_authorization_invalidated",
      },
    });
    return message;
  }
  if (bookingResult.status === "rejected") {
    clearAvailabilitySelection(state, {
      invalidateReads: "booking_authorization_invalidated",
    });
  }

  const message = `${bookingFailureMessage(bookingResult)} I did not cancel the existing appointment.`;
  recordRescheduleAction(state, callId, {
    status: "error",
    message,
    selectedSlot,
    bookingResult,
    oldAppointment,
    patientId,
    cancellationResult: {
      status: "not_attempted",
      reason: "booking_failed",
    },
  });
  if (bookingResult.status === "error") {
    throwOwnedMiddlewareFailure(
      bookingResult,
      "I couldn't book the new appointment. I did not cancel the existing appointment.",
    );
  }
  return message;
}

function rescheduleCancellationFailureMessage(
  selectedSlot: StoredAvailabilitySlot,
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
  bookingResult: BookingSuccess,
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
  callId: string,
  input: {
    status: "success" | "partial" | "error";
    message: string;
    selectedSlot: StoredAvailabilitySlot;
    bookingResult: BookingResult;
    oldAppointment: CallerAppointment;
    patientId: string;
    cancellationResult: Record<string, unknown>;
  },
): void {
  recordAppointmentAction(state, callId, {
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
    ...rescheduleActionEvidence(
      input.patientId,
      input.oldAppointment,
      input.bookingResult,
      input.cancellationResult,
    ),
  });
}

function recordCapturedRescheduleAction(
  state: CallState,
  callId: string,
  input: {
    status: "success" | "partial" | "error";
    message: string;
    patientName: string | null;
    selectedSlot: StoredAvailabilitySlot;
    bookingResult: BookingResult;
    oldAppointment: CallerAppointment;
    patientId: string;
    cancellationResult: Record<string, unknown>;
  },
): void {
  recordAppointmentAction(state, callId, {
    action: "rescheduled",
    status: input.status,
    toolName: "reschedule_appointment",
    message: input.message,
    appointment: appointmentAnalyticsForCapturedBooking(
      input.patientName,
      input.selectedSlot,
      input.bookingResult,
    ),
    cancelledAppointment: cancelledAppointmentAnalytics(
      state,
      input.oldAppointment,
      input.patientName,
    ),
    ...rescheduleActionEvidence(
      input.patientId,
      input.oldAppointment,
      input.bookingResult,
      input.cancellationResult,
    ),
  });
}

function replayAppointmentOutcome(
  state: CallState,
  callId: string,
  patientId: string,
  outcome: "booked" | "cancelled" | "rescheduled",
  appointmentId?: string,
): void {
  const action = appointmentActions(state)
    .reverse()
    .find(
      (candidate) =>
        candidate.action === outcome &&
        candidate.externalPatientId === patientId &&
        (!appointmentId || candidate.oldAppointmentId === appointmentId),
    );
  if (action)
    recordAppointmentAction(state, callId, action, { replayed: true });
}

function rescheduleActionEvidence(
  patientId: string,
  oldAppointment: CallerAppointment,
  bookingResult: BookingResult,
  cancellationResult: Record<string, unknown>,
): Pick<
  AppointmentActionAnalytics,
  | "externalPatientId"
  | "oldAppointmentId"
  | "newAppointmentId"
  | "bookingResult"
  | "cancellationResult"
> {
  return {
    ...bookingActionEvidence(patientId, bookingResult),
    oldAppointmentId: String(oldAppointment.id),
    cancellationResult,
  };
}

function bookingActionEvidence(
  patientId: string,
  result: BookingResult,
): Pick<
  AppointmentActionAnalytics,
  "externalPatientId" | "newAppointmentId" | "bookingResult"
> {
  const appointmentId =
    "appointmentId" in result && typeof result.appointmentId === "number"
      ? String(result.appointmentId)
      : undefined;
  return {
    externalPatientId: patientId,
    ...(appointmentId ? { newAppointmentId: appointmentId } : {}),
    bookingResult: { ...result },
  };
}

function cancellationActionEvidence(
  patientId: string,
  appointment: CallerAppointment,
  result: CancellationResult,
): Pick<
  AppointmentActionAnalytics,
  "externalPatientId" | "oldAppointmentId" | "cancellationResult"
> {
  return {
    externalPatientId: patientId,
    oldAppointmentId: String(appointment.id),
    cancellationResult: { ...result },
  };
}
