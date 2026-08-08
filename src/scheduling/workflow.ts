import {
  getOfficeProfileByFacility,
  normalizePhoneNumber,
  type AvailabilityOfficeKey,
} from "../customers/abita/profile.js";
import {
  incompletePatientRegistrationMessage,
  restoreConfirmedPreCallPatient,
} from "../identity/promotion.js";
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
  recordAppointmentAction,
  recordOwnedMiddlewareFailure,
} from "../state/observability.js";
import {
  activeRoutingContext,
  clearAvailabilitySelection,
  currentAvailabilityDate,
  removeAvailabilitySlot,
  setCurrentAvailabilityDate,
  applyTurnContextToState,
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
  bookingSlotUnavailable,
  bookingSucceeded,
  bookingTokenRejected,
  selectedSlotForBooking,
  slotUnavailableMessage,
  spokenSlot,
} from "./booking.js";
import {
  getAmdOfficeForToolCall,
  medicalSchedulingUnavailable,
  routingForAvailability,
  routineVisionSchedulingUnavailable,
  selectAvailabilityOffice,
} from "./routing.js";
import {
  availabilityContextRecovery,
  ensureAvailabilityContext,
  prepareAvailabilityLookupContext,
} from "./context.js";
import { SchedulingInputRequired } from "./input-required.js";
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
  clinicIsoDate,
  resolveAvailabilityWhen,
  systemSchedulingClock,
  type SchedulingClock,
} from "./availability-when.js";

export interface AvailabilityLookupArgs {
  when: string;
  appointmentLane?: SchedulingAppointmentLane;
  oldAppointmentRef?: string;
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
  oldAppointmentRef?: string;
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
    const resolvedWhen = resolveAvailabilityWhen(
      args.when,
      { now: () => now },
      currentAvailabilityDate(state),
    );
    const request = buildAvailabilityLookupRequestForState(state, {
      ...args,
      cacheDay: clinicIsoDate(now),
      requestedDate: resolvedWhen.requestedDate,
      preferredTime: resolvedWhen.preferredTime,
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
          onCacheExpired: () => clearAvailabilitySelection(state),
          signal,
        },
      );
      if (signal?.aborted || !availabilityRequestStillCurrent(state, request)) {
        discardAvailabilityRead(state, request.backendKey, result);
        return "Availability search was superseded because the patient or appointment context changed. Check availability again with the current details.";
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
        return "Availability expired before it could be offered. Check availability again.";
      }
    }
    try {
      setCurrentAvailabilityDate(
        state,
        availabilityReferenceDate(request.body, result),
      );
      const response = storeAvailabilitySlots(state, result, request.routing);
      if (response.cacheable) {
        cacheCompletedAvailabilityRead(
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
  ): Promise<string> {
    restoreConfirmedPreCallPatient(state);
    const incompleteRegistration = incompletePatientRegistrationMessage(state);
    if (incompleteRegistration) return incompleteRegistration;
    const patientId = activePatientId(state);
    if (patientId && hasCompletedBookingForActivePatient(state)) {
      clearAvailabilitySelection(state);
      return "The appointment is already booked. Tell the caller the confirmed appointment details instead of booking again.";
    }

    ensureNewAppointmentBookingContext(state);

    if (!patientId) {
      throw new SchedulingInputRequired(
        "Verify or create the patient before booking.",
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
      return (
        `Read back ${spokenSlot(selectedSlot)} and ask the caller to confirm it. ` +
        "Call book_appointment again only after the caller confirms the appointment details are correct."
      );
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
      recordAppointmentAction(state, {
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
        return "I couldn't book the appointment, and the active patient changed. Continue with the current patient and do not retry this request.";
      }
      return `${message} The active patient changed before the booking result returned. Continue with the current patient's state.`;
    }

    if (bookingSucceeded(result)) {
      recordCompletedBookingForPatient(state, patientId, {
        appointmentId: result.appointmentId,
        appointmentDescription: spokenSlot(selectedSlot),
      });
      const appointmentRef = recordBookedAppointmentInState(
        state,
        selectedSlot,
        result,
      );
      clearAvailabilitySelection(state, {
        invalidateReads: "booking_succeeded",
      });
      const message = bookedAppointmentMessage(selectedSlot, result);
      recordAppointmentAction(state, {
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
      return `${message} Internal context: appointmentRef ${appointmentRef}. Use this exact appointmentRef if the caller asks to cancel this appointment during this call. Keep this opaque reference internal.`;
    }
    if (bookingHadPositiveStatusWithoutAppointmentId(result)) {
      clearAvailabilitySelection(state, {
        invalidateReads: "booking_authorization_invalidated",
      });
      const message = bookingFailureMessage(result);
      recordAppointmentAction(state, {
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

    if (bookingSlotUnavailable(result)) {
      invalidateAvailabilityReads(state, "booking_authorization_invalidated");
      const remainingSlots = removeAvailabilitySlot(state, selectedSlot.slotId);
      const message = slotUnavailableMessage(remainingSlots);
      recordAppointmentAction(state, {
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
    if (bookingTokenRejected(result)) {
      clearAvailabilitySelection(state, {
        invalidateReads: "booking_authorization_invalidated",
      });
    }

    const message = bookingFailureMessage(result);
    recordAppointmentAction(state, {
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
  ): Promise<string> {
    restoreConfirmedPreCallPatient(state);
    const patientId = activePatientId(state);
    if (!patientId) {
      throw new SchedulingInputRequired(
        "Verify the patient before cancelling.",
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
        return completedCancellationReplayMessage(cancelledAppointment);
      }
      throw new SchedulingInputRequired(selection.message);
    }
    const appointment = selection.appointment;
    const completedCancellation = completedCancellationForState(state, {
      appointmentRef,
    });
    if (completedCancellation) {
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
      recordAppointmentAction(state, {
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
        return "I couldn't cancel the appointment, and the active patient changed. Continue with the current patient and do not retry this request.";
      }
      return `${message} The active patient changed before the cancellation result returned. Continue with the current patient's state.`;
    }

    if (
      result.status === "rejected" &&
      result.reason === "invalid_cancellation_token"
    ) {
      replaceActiveAppointments(state, [], "error");
      const message =
        "That loaded appointment authorization is no longer valid. Load appointments again, confirm the exact appointment with the caller, then use its new appointmentRef to cancel.";
      recordAppointmentAction(state, {
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
      recordAppointmentAction(state, {
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
    recordAppointmentAction(state, {
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
  ): Promise<string> {
    restoreConfirmedPreCallPatient(state);
    const patientId = activePatientId(state);
    if (!patientId) {
      throw new SchedulingInputRequired(
        "Verify the patient before rescheduling.",
      );
    }
    const patientName = activePatientName(state);
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

    if (
      !completedReschedule &&
      state.workflow.current?.intent !== "change_appointment"
    ) {
      clearAvailabilitySelection(state, {
        invalidateReads: "scheduling_context_changed",
      });
      return "Check availability again for the loaded appointment the caller wants to reschedule before moving it.";
    }

    const availabilityOldAppointmentRef =
      !completedReschedule &&
      state.workflow.current?.intent === "change_appointment"
        ? state.workflow.current.oldAppointmentRef
        : undefined;
    const requestedOldAppointmentRef = oldAppointmentRef?.trim();
    if (
      availabilityOldAppointmentRef &&
      requestedOldAppointmentRef &&
      requestedOldAppointmentRef !== availabilityOldAppointmentRef
    ) {
      clearAvailabilitySelection(state, {
        invalidateReads: "scheduling_context_changed",
      });
      return "The appointment selected to reschedule changed. Check availability again for the exact appointment the caller wants to move.";
    }

    const selectedSlot = selectedSlotForBooking(state, appointmentSlotRef);
    const selection = rescheduleAppointmentForState(
      state,
      completedReschedule
        ? undefined
        : (availabilityOldAppointmentRef ?? requestedOldAppointmentRef),
      { preferLatestBooked: Boolean(completedReschedule) },
    );
    if (selection.status === "ambiguous") {
      return selection.message;
    }
    if (selection.status === "not_found") {
      throw new SchedulingInputRequired(selection.message);
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
        );
        const message = rescheduleCancellationFailureMessage(
          selectedSlot,
          "The active patient changed before the old appointment could be cancelled.",
        );
        recordCapturedRescheduleAction(state, {
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
      recordCapturedRescheduleAction(state, {
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
        );
        const message = rescheduleCancellationFailureMessage(
          selectedSlot,
          "The old appointment was not cancelled. The active patient changed before the cancellation result returned. Continue with the current patient's state.",
        );
        recordCapturedRescheduleAction(state, {
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
      const message = `${outcomeMessage} The active patient changed before the cancellation result returned. Continue with the current patient's state.`;
      recordCapturedRescheduleAction(state, {
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
        patientId,
        cancellationResult: { ...cancelResult },
      });
      return message;
    }

    removeActiveAppointment(state, oldAppointment.id);
    applyTurnContextToState(state, {
      intent: "change_appointment",
      appointmentLane: "not_applicable",
      oldAppointmentRef: replacementAppointmentRef,
    });
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
    requestedDate?: string;
    preferredTime?: MiddlewareAvailabilityRequest["preferredTime"];
  },
): AvailabilityWorkflowRequest | { blocked: string } {
  const { cacheDay, requestedDate, preferredTime } = args;
  const incompleteRegistration = incompletePatientRegistrationMessage(state);
  if (incompleteRegistration) {
    return { blocked: incompleteRegistration };
  }
  const patientId = activePatientId(state);
  if (!patientId) {
    return {
      blocked: "Verify or create the patient before checking availability.",
    };
  }

  const officeSelection = selectAvailabilityOffice(state, args.office);
  if (officeSelection) return { blocked: officeSelection };

  prepareAvailabilityLookupContext(
    state,
    args.appointmentLane,
    args.oldAppointmentRef,
  );
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
  const body: MiddlewareAvailabilityRequest = {};
  if (requestedDate) body.requestedDate = requestedDate;
  if (preferredTime) body.preferredTime = preferredTime;
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
    oldAppointmentRef: turn?.oldAppointmentRef ?? null,
    cacheDay: input.cacheDay,
    requestedDate: input.body.requestedDate?.trim() || null,
    preferredTime: input.body.preferredTime ?? null,
    dob:
      typeof input.body.dob === "string" ? input.body.dob.trim() || null : null,
    routing: input.routing,
    preauthRequired: input.body.preauthRequired === true,
  });
}

function availabilityReferenceDate(
  request: MiddlewareAvailabilityRequest,
  result: AvailabilityResult,
): string | undefined {
  if (result.status === "error") {
    return request.requestedDate?.trim() || undefined;
  }
  if (result.status !== "found") {
    return (
      result.searchedFrom?.trim() ||
      result.requestedDate?.trim() ||
      request.requestedDate?.trim() ||
      undefined
    );
  }
  const dates = result.slots.flatMap((slot) => {
    const date = slot.date.trim() || slot.datetime.split("T")[0]?.trim();
    return date ? [date] : [];
  });
  const distinctDates = [...new Set(dates)];
  return distinctDates.length === 1 ? distinctDates[0] : undefined;
}

function ensureNewAppointmentBookingContext(state: CallState): void {
  const turn = state.workflow.current;
  if (turn?.intent === "change_appointment") {
    throw new SchedulingInputRequired(
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
  throw new SchedulingInputRequired(
    "Search availability again with visitType medical or routine_vision before booking a new appointment.",
  );
}

function hasCompletedBookingForActivePatient(state: CallState): boolean {
  const patientId = activePatientId(state);
  return Boolean(patientId && completedBookingForPatient(state, patientId));
}

function completedCancellationReplayMessage(
  appointment: CallerAppointment,
): string {
  return `That appointment was already cancelled on this call: ${appointment.date} at ${appointment.time}. Continue without calling cancel_appointment again.`;
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
): string {
  if (bookingHadPositiveStatusWithoutAppointmentId(bookingResult)) {
    clearAvailabilitySelection(state, {
      invalidateReads: "booking_authorization_invalidated",
    });
    const message =
      "I could not confirm the new booking because the appointment ID was missing, so I did not cancel the existing appointment. Check availability again before booking.";
    recordRescheduleAction(state, {
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

  if (bookingSlotUnavailable(bookingResult)) {
    invalidateAvailabilityReads(state, "booking_authorization_invalidated");
    const remainingSlots = removeAvailabilitySlot(state, selectedSlot.slotId);
    const message = `${slotUnavailableMessage(remainingSlots)} I did not cancel the existing appointment.`;
    recordRescheduleAction(state, {
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
      "The appointment was not booked because the reschedule authorization expired. Load appointments again, reselect the exact appointment, and check availability again. I did not cancel the existing appointment.";
    recordRescheduleAction(state, {
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
  if (bookingTokenRejected(bookingResult)) {
    clearAvailabilitySelection(state, {
      invalidateReads: "booking_authorization_invalidated",
    });
  }

  const message = `${bookingFailureMessage(bookingResult)} I did not cancel the existing appointment.`;
  recordRescheduleAction(state, {
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
  recordAppointmentAction(state, {
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
