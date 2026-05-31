import { llm } from "@livekit/agents";
import { z } from "zod";
import { callApi } from "../clients/advancedmd-client.js";
import { activePatientId } from "../state/call-state.js";
import {
  cancellationAppointmentForState,
  removeAppointmentById,
} from "./appointment-state.js";
import { restoreConfirmedPreCallCaller } from "./patient-state.js";
import { getAmdOfficeForToolCall } from "./scheduling.js";
import { getState } from "./session.js";

export const cancel_appt = llm.tool({
  description:
    "Cancel a loaded appointment. " +
    "Call this after the patient is verified and the caller confirms the exact appointment to cancel. " +
    "Pass appointmentDate and appointmentTime when the caller identifies the appointment by date or time. " +
    "Omit all appointment selectors only for the latest booked appointment or exactly one loaded appointment. " +
    "For reschedules, book the new appointment before cancelling the old one.",
  parameters: z.object({
    appointmentId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Appointment ID from the loaded appointment list. Omit only when the caller confirmed the latest booked appointment or exactly one loaded appointment.",
      ),
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
  }),
  execute: async (
    { appointmentId, appointmentDate, appointmentTime },
    { ctx },
  ) => {
    const state = getState(ctx);
    ctx.speechHandle.allowInterruptions = false;

    restoreConfirmedPreCallCaller(state);
    const patientId = activePatientId(state);
    if (!patientId) {
      throw new llm.ToolError("Verify the patient before cancelling.");
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
    const appointment = selection.appointment;

    const result = (await callApi(
      "/api/appointment/cancel",
      { appointmentId: appointment.id, patientId },
      getAmdOfficeForToolCall(state),
    )) as CancelAppointmentResult;

    if (result?.status !== "cancelled") {
      return result?.message ?? "The appointment was not cancelled.";
    }

    removeAppointmentById(state, appointment.id);
    return `Cancelled the appointment on ${appointment.date} at ${appointment.time}.`;
  },
});

type CancelAppointmentResult = {
  status?: string;
  message?: string;
};
