import { llm } from "@livekit/agents";
import { z } from "zod";
import { callApi } from "../clients/advancedmd-client.js";
import { activePatientId } from "../state/call-state.js";
import {
  activeAppointmentById,
  cancelTokenForAppointment,
  refreshCancelTokenForAppointment,
  removeAppointmentById,
} from "./appointment-state.js";
import { restoreConfirmedPreCallCaller } from "./patient-state.js";
import { getAmdOfficeForToolCall } from "./scheduling.js";
import { disableInterruptionsForWrite, getState } from "./session.js";

export const cancel_appt = llm.tool({
  description:
    "Cancel a loaded appointment. " +
    "Call this before saying an appointment is cancelled; cancellation is not complete until this tool succeeds. " +
    "Requires appointmentId from caller context or verify_patient. " +
    "For reschedules, book the new appointment before cancelling the old one. " +
    "Returns cancellation status.",
  parameters: z.object({
    appointmentId: z
      .number()
      .describe(
        "Appointment ID from caller context or verify_patient response",
      ),
  }),
  execute: async ({ appointmentId }, { ctx }) => {
    const state = getState(ctx);
    const speechReady = disableInterruptionsForWrite(ctx);
    if (!speechReady) {
      return {
        outcome: "not_allowed",
        speak:
          "Cancellation was interrupted before it could be submitted. Please confirm the cancellation again.",
        facts: { reason: "speech_interrupted" },
        retryable: true,
      };
    }
    restoreConfirmedPreCallCaller(state);
    const patientId = activePatientId(state);
    if (!patientId) {
      return {
        outcome: "not_allowed",
        speak: "Verify the patient before cancelling.",
        facts: { reason: "cancel_requires_verified_or_created_patient" },
        retryable: true,
      };
    }
    const loadedAppointment = activeAppointmentById(state, appointmentId);
    if (!loadedAppointment) {
      return {
        outcome: "not_allowed",
        speak:
          "Load the patient's appointments again, read back the exact appointment, and confirm before cancelling.",
        facts: {
          reason: "cancel_requires_loaded_appointment",
          appointmentId,
        },
        retryable: true,
      };
    }
    let cancelToken = cancelTokenForAppointment(state, appointmentId);
    if (!cancelToken) {
      cancelToken = await refreshCancelTokenForAppointment(
        state,
        appointmentId,
      );
    }
    if (!cancelToken) {
      return {
        outcome: "not_allowed",
        speak:
          "Load the patient's appointments again, read back the exact appointment, and confirm before cancelling.",
        facts: {
          reason: "cancel_requires_cancel_token",
          appointmentId,
        },
        retryable: true,
      };
    }
    const result = await callApi(
      "/api/appointment/cancel",
      { appointmentId, patientId, cancelToken },
      getAmdOfficeForToolCall(state),
      { includeOffice: false },
    );
    const cancelResultReason = cancellationFailureReason(result);
    if (
      cancelResultReason === "appointment_already_cancelled" ||
      (cancelResultReason === "cancel_failed" &&
        apiResultLooksSuccessful(result))
    ) {
      removeAppointmentById(state, appointmentId);
      return result;
    }
    return result;
  },
});

function cancellationFailureReason(result: unknown): string {
  if (!isRecord(result)) return "cancel_failed";
  const status =
    typeof result.status === "string" ? result.status.toLowerCase() : "";
  const outcome =
    typeof result.outcome === "string" ? result.outcome.toLowerCase() : "";
  const message =
    typeof result.message === "string" ? result.message.toLowerCase() : "";
  const text = `${status} ${outcome} ${message}`;
  if (text.includes("already") && text.includes("cancel")) {
    return "appointment_already_cancelled";
  }
  if (
    text.includes("not found") ||
    text.includes("not_found") ||
    text.includes("missing appointment")
  ) {
    return "appointment_not_found";
  }
  if (text.includes("canceltoken") || text.includes("cancel token")) {
    return "cancel_token_invalid";
  }
  if (status === "error") return "middleware_error";
  return "cancel_failed";
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
