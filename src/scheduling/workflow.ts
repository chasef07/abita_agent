import { incompletePatientRegistrationMessage } from "../identity/patient-identity.js";
import {
  appointmentRefForPatient,
  completedBookingForPatient,
  completedRescheduleForPatient,
  recordCompletedBookingForPatient,
  recordCompletedCancellationForPatient,
  recordCompletedRescheduleForPatient,
  removeActiveAppointment,
  replaceActiveAppointments,
} from "../state/appointments.js";
import {
  activePatientId,
  activePatientName,
  type AppointmentActionAnalytics,
  type AppointmentAnalytics,
  type CallState,
  type CallerAppointment,
  type CompletedRescheduleState,
  type StoredAvailabilitySlot,
} from "../state/call-state.js";
import {
  appointmentActions,
  recordAppointmentAction,
} from "../state/observability.js";
import {
  clearAvailabilitySelection,
  removeAvailabilitySlot,
  selectedAvailabilitySlot,
} from "./availability.js";
import {
  appointmentActionStatusForBookingResult,
  bookedSlotAppointmentAnalytics,
  cancelledAppointmentAnalytics,
} from "./observability.js";

import {
  recordBookedAppointmentInState,
  bookedAppointmentFromReceipt,
  rescheduleAppointmentForState,
  cancellationAppointmentForState,
  completedCancellationForState,
} from "./appointments.js";
import {
  bookedAppointmentMessage,
  bookingFailureMessage,
  bookingNoteWarning,
  bookingRequestBodyForSlot,
  bookingSucceeded,
  selectedSlotForBooking,
  slotUnavailableMessage,
  spokenSlot,
  type BookingSuccess,
} from "./booking.js";
import { getAmdOfficeForToolCall, visitTypeForAppointment } from "./routing.js";
import { SchedulingInputRequired } from "./input-required.js";
import type {
  BookAppointmentResult,
  CancelAppointmentResult,
  RescheduleAppointmentResult,
} from "../clients/owned-middleware.js";
import type { SchedulingMiddleware } from "./middleware.js";

import { systemSchedulingClock, type SchedulingClock } from "./clock.js";

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

  async bookAppointment(
    state: CallState,
    args: BookAppointmentArgs,
    callId: string,
  ): Promise<string> {
    return this.mutate(state, () => this.book(state, args, callId));
  }
  async cancelAppointment(
    state: CallState,
    args: CancelAppointmentArgs,
    callId: string,
  ): Promise<string> {
    return this.mutate(state, () => this.cancel(state, args, callId));
  }
  async rescheduleAppointment(
    state: CallState,
    args: RescheduleAppointmentArgs,
    callId: string,
  ): Promise<string> {
    return this.mutate(state, () => this.reschedule(state, args, callId));
  }
  private async mutate(
    state: CallState,
    execute: () => Promise<string>,
  ): Promise<string> {
    const patientId = activePatientId(state);
    const blocked =
      patientId && state.identity.schedulingWriteBlocks?.[patientId];
    if (blocked) return blocked;
    if (state.identity.schedulingWritePending)
      return "An appointment change is still in progress. Wait for its result before making another change.";
    state.identity.schedulingWritePending = true;
    try {
      return await execute();
    } finally {
      state.identity.schedulingWritePending = false;
    }
  }

  private async book(
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

    let result: BookAppointmentResult;
    try {
      result = await this.middleware.bookAppointment({
        booking: bookingBody,
        office: getAmdOfficeForToolCall(state),
      });
    } catch {
      result = { status: "error", reason: "network_error" };
    }
    if (
      bookingSucceeded(result) &&
      result.patientId &&
      result.patientId !== patientId
    )
      result = { status: "error", reason: "invalid_response" };
    if (result.status === "error" && !result.noWrite) {
      const message =
        "The booking outcome is uncertain. Do not book or cancel again; office staff must reconcile the appointments.";
      blockPatientWrites(state, patientId, message);
      if (activePatientId(state) === patientId)
        clearAvailabilitySelection(state, { invalidateReads: true });
      recordAppointmentAction(state, callId, {
        action: "booked",
        status: "error",
        toolName: "book_appointment",
        message,
        ...bookingActionEvidence(patientId, result),
      });
      return message;
    }

    if (activePatientId(state) !== patientId) {
      const message = bookingSucceeded(result)
        ? bookedAppointmentMessage(selectedSlot, result)
        : bookingFailureMessage(result);
      if (bookingSucceeded(result)) {
        recordCompletedBookingForPatient(state, patientId, {
          appointment: bookedAppointmentFromReceipt(selectedSlot, result),
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
        appointment: bookedAppointmentFromReceipt(selectedSlot, result),
        appointmentId: result.appointmentId,
        appointmentDescription: spokenSlot(selectedSlot),
      });
      recordBookedAppointmentInState(state, selectedSlot, result);
      clearAvailabilitySelection(state, {
        invalidateReads: true,
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
    if (result.status === "unavailable") {
      removeAvailabilitySlot(state, selectedSlot.slotId);
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
        invalidateReads: true,
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
      clearAvailabilitySelection(state, { invalidateReads: true });
      return `${message} Search availability again and confirm a new slot before another attempt.`;
    }
    return message;
  }

  private async cancel(
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

    const cancellationToken = appointment.cancellationToken?.trim();
    if (!cancellationToken) {
      replaceActiveAppointments(state, [], "error");
      throw new SchedulingInputRequired(
        "Reload the appointments and confirm the exact appointment before cancelling; its authorization is missing.",
      );
    }
    let result: CancelAppointmentResult;
    try {
      result = await this.middleware.cancelAppointment({
        cancellationToken,
        office: getAmdOfficeForToolCall(state),
      });
    } catch {
      result = { status: "error", reason: "network_error" };
    }
    if (result.status === "error" && !result.noWrite) {
      const message =
        "The cancellation outcome is uncertain. Do not book or cancel again; office staff must reconcile the appointments.";
      blockPatientWrites(state, patientId, message);
      if (activePatientId(state) === patientId)
        clearAvailabilitySelection(state, { invalidateReads: true });
      recordAppointmentAction(state, callId, {
        action: "cancelled",
        status: "error",
        toolName: "cancel_appointment",
        message,
        ...cancellationActionEvidence(patientId, appointment, result),
      });
      return message;
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
      return `${message} Reload appointments and confirm the exact appointment before another attempt.`;
    }

    removeActiveAppointment(state, appointment.id);
    clearAvailabilitySelection(state, {
      invalidateReads: true,
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

  private async reschedule(
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
    const visitType = visitTypeForAppointment(oldAppointment);
    if (!visitType || !oldAppointment.rescheduleToken) {
      replaceActiveAppointments(state, [], "error");
      clearAvailabilitySelection(state, { invalidateReads: true });
      return "Reload the appointments before rescheduling: the visit type or authorization is missing. If still unknown, ask staff for help.";
    }
    if (state.workflow.visitType !== visitType)
      return "Load availability matching the existing appointment's visit type before rescheduling.";
    const bookingBody = bookingRequestBodyForSlot(state, {
      selectedSlot,
      patientId,
      appointmentReason,
      referringDoctor,
      now: this.clock.now(),
      rescheduleToken: oldAppointment.rescheduleToken,
    });
    if (!readBack)
      return `Let me confirm the new appointment: ${spokenSlot(selectedSlot)}. Is that correct?`;
    let result: RescheduleAppointmentResult;
    try {
      result = await this.middleware.rescheduleAppointment({
        office: getAmdOfficeForToolCall(state),
        booking: {
          ...bookingBody,
          visitCategory: visitType,
          rescheduleToken: oldAppointment.rescheduleToken,
        },
      });
    } catch {
      result = { status: "uncertain", outcome: "network_error" };
    }
    if (activePatientId(state) === patientId)
      clearAvailabilitySelection(state, { invalidateReads: true });
    if (
      "booking" in result &&
      result.booking.appointmentId === oldAppointment.id
    )
      result = { status: "uncertain" };
    if (result.status === "failed") {
      if (
        activePatientId(state) === patientId &&
        (result.outcome === "invalid_reschedule_token" ||
          result.outcome === "ownership_mismatch")
      )
        replaceActiveAppointments(state, [], "error");
      const message =
        "The reschedule failed without a confirmed replacement. Reload appointments and search again, then confirm the exact appointment and new slot before a fresh attempt.";
      recordCapturedRescheduleAction(state, callId, {
        status: "error",
        message,
        patientName,
        selectedSlot,
        oldAppointment,
        patientId,
        bookingResult: {
          status: "error",
          reason: "request_rejected",
          noWrite: true,
        },
        cancellationResult: {
          status: "not_attempted",
          reason: result.outcome ?? "reschedule_failed",
        },
      });
      return message;
    }
    if (result.status === "uncertain") {
      const message =
        "The reschedule outcome is uncertain. Do not book or cancel again. Office staff must reconcile the appointments before any further changes.";
      blockPatientWrites(state, patientId, message);
      recordCapturedRescheduleAction(state, callId, {
        status: "error",
        message,
        patientName,
        selectedSlot,
        oldAppointment,
        patientId,
        bookingResult: { status: "error", reason: "middleware_error" },
        cancellationResult: { status: "uncertain", outcome: result.outcome },
      });
      return message;
    }
    const bookingResult = result.booking;
    const cancelled =
      result.status === "completed" &&
      result.cancellation?.appointmentId === oldAppointment.id;
    if (cancelled)
      recordCompletedCancellationForPatient(state, patientId, oldAppointment);
    const replacementAppointment = bookedAppointmentFromReceipt(
      selectedSlot,
      bookingResult,
    );
    const replacementAppointmentRef = appointmentRefForPatient(
      patientId,
      replacementAppointment,
    );
    if (activePatientId(state) === patientId)
      recordBookedAppointmentInState(state, selectedSlot, bookingResult);
    recordCompletedRescheduleForPatient(
      state,
      patientId,
      {
        status: cancelled ? "rescheduled" : "needs_human_cancellation",
        originalAppointmentRef: selectedAppointmentRef,
        replacementAppointmentRef,
        appointmentDescription: spokenSlot(selectedSlot),
      },
      replacementAppointment,
    );
    const message = cancelled
      ? rescheduledAppointmentMessage(
          selectedSlot,
          bookingResult,
          oldAppointment,
        )
      : `Booked the replacement for ${spokenSlot(selectedSlot)}. The original cancellation is unconfirmed. Do not book or cancel again; office staff must reconcile the appointments.`;
    if (!cancelled) blockPatientWrites(state, patientId, message);
    recordCapturedRescheduleAction(state, callId, {
      status: cancelled ? "success" : "partial",
      message,
      patientName,
      selectedSlot,
      bookingResult,
      oldAppointment,
      patientId,
      cancellationResult: result.cancellation ?? { status: "unconfirmed" },
    });
    return message;
  }
}

function blockPatientWrites(
  state: CallState,
  patientId: string,
  message: string,
): void {
  (state.identity.schedulingWriteBlocks ??= {})[patientId] = message;
}

function ensureNewAppointmentBookingContext(state: CallState): void {
  if (state.workflow.visitType) return;
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
  result: BookAppointmentResult,
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

function recordCapturedRescheduleAction(
  state: CallState,
  callId: string,
  input: {
    status: "success" | "partial" | "error";
    message: string;
    patientName: string | null;
    selectedSlot: StoredAvailabilitySlot;
    bookingResult: BookAppointmentResult;
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
  bookingResult: BookAppointmentResult,
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
  result: BookAppointmentResult,
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
  result: CancelAppointmentResult,
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
