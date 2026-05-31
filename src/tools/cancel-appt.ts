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
import { getState } from "./session.js";

export const cancel_appt = llm.tool({
  description:
    "Cancel a loaded appointment. " +
    "Call this after the patient is verified and the caller confirms the exact appointment to cancel. " +
    "For reschedules, book the new appointment before cancelling the old one.",
  parameters: z.object({
    appointmentId: z
      .number()
      .int()
      .positive()
      .describe("Appointment ID from the loaded appointment list"),
  }),
  execute: async ({ appointmentId }, { ctx }) => {
    const state = getState(ctx);
    ctx.speechHandle.allowInterruptions = false;

    restoreConfirmedPreCallCaller(state);
    const patientId = activePatientId(state);
    if (!patientId) {
      throw new llm.ToolError("Verify the patient before cancelling.");
    }

    const appointment = activeAppointmentById(state, appointmentId);
    if (!appointment) {
      throw new llm.ToolError(
        "Load appointments and confirm the exact appointment before cancelling.",
      );
    }

    let cancelToken = cancelTokenForAppointment(state, appointmentId);
    if (!cancelToken) {
      cancelToken = await refreshCancelTokenForAppointment(
        state,
        appointmentId,
      );
    }
    if (!cancelToken) {
      throw new llm.ToolError("Load appointments again before cancelling.");
    }

    const result = (await callApi(
      "/api/appointment/cancel",
      { appointmentId, patientId, cancelToken },
      getAmdOfficeForToolCall(state),
      { includeOffice: false },
    )) as CancelAppointmentResult;

    if (result?.status !== "cancelled") {
      return result?.message ?? "The appointment was not cancelled.";
    }

    removeAppointmentById(state, appointmentId);
    return `Cancelled the appointment on ${appointment.date} at ${appointment.time}.`;
  },
});

type CancelAppointmentResult = {
  status?: string;
  message?: string;
};
