import { llm } from "@livekit/agents";
import { z } from "zod";
import { callApi } from "../clients/advancedmd-client.js";
import {
  activePatientId,
  recordAppointmentAction,
} from "../state/call-state.js";
import { cancelledAppointmentAnalytics } from "./appointment-analytics.js";
import {
  cancellationAppointmentForState,
  completedCancellationForState,
  removeAppointmentById,
} from "./appointment-state.js";
import { restoreConfirmedPreCallCaller } from "./patient-state.js";
import { getAmdOfficeForToolCall } from "./scheduling.js";
import { getState } from "./session.js";

const cancelAppointmentParameters = z
  .object({
    appointmentDate: z
      .string()
      .optional()
      .describe(
        'Date the caller used to identify a loaded appointment, such as "June 2", "June 2nd", or "2026-06-02".',
      ),
    appointmentTime: z
      .string()
      .optional()
      .describe(
        'Time the caller used to identify a loaded appointment, such as "10 AM" or "2:30 PM". Use with appointmentDate when needed.',
      ),
  })
  .strict();

export const cancel_appointment = llm.tool({
  description:
    "Cancel a loaded appointment. " +
    "Call this after the patient is verified and the caller confirms the exact appointment to cancel. " +
    "Pass appointmentDate and appointmentTime when the caller identifies the appointment by date or time. " +
    "Do not pass backend patient IDs or appointment IDs; the tool selects the appointment from loaded appointment state. " +
    "Omit all appointment selectors only for the latest booked appointment or exactly one loaded appointment.",
  parameters: cancelAppointmentParameters,
  execute: async ({ appointmentDate, appointmentTime }, { ctx }) => {
    const state = getState(ctx);
    ctx.speechHandle.allowInterruptions = false;

    restoreConfirmedPreCallCaller(state);
    const patientId = activePatientId(state);
    if (!patientId) {
      throw new llm.ToolError("Verify the patient before cancelling.");
    }

    const selector = {
      appointmentDate,
      appointmentTime,
    };
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
        return `That appointment was already cancelled on this call: ${cancelledAppointment.date} at ${cancelledAppointment.time}. Continue without calling cancel_appointment again.`;
      }
      throw new llm.ToolError(selection.message);
    }
    const appointment = selection.appointment;

    const result = (await callApi(
      "/api/appointment/cancel",
      { appointmentId: appointment.id, patientId },
      getAmdOfficeForToolCall(state),
    )) as CancelAppointmentResult;

    if (result?.status !== "cancelled") {
      const message = result?.message ?? "The appointment was not cancelled.";
      recordAppointmentAction(state, {
        action: "cancelled",
        status: "error",
        toolName: "cancel_appointment",
        message,
        cancelledAppointment: cancelledAppointmentAnalytics(state, appointment),
      });
      return message;
    }

    removeAppointmentById(state, appointment.id);
    const message = `Cancelled the appointment on ${appointment.date} at ${appointment.time}.`;
    recordAppointmentAction(state, {
      action: "cancelled",
      status: "success",
      toolName: "cancel_appointment",
      message,
      cancelledAppointment: cancelledAppointmentAnalytics(state, appointment),
    });
    return message;
  },
});

type CancelAppointmentResult = {
  status?: string;
  message?: string;
};
