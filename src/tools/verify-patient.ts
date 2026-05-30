import { llm } from "@livekit/agents";
import { z } from "zod";
import type {
  PatientResolveResult,
  PatientResolveVerified,
} from "../clients/advancedmd-client.js";
import {
  applyResolvedPatientToState,
  resolvePatientForCall,
} from "./patient-state.js";
import { getState } from "./session.js";

export const verify_patient = llm.tool({
  description:
    "Finds an existing patient and loads appointments. " +
    "Call this when existing patients are not preloaded and want to schedule, confirm, or cancel appointments. " +
    "Do not call for general questions. " +
    "Returns a speech-ready verification and appointment summary.",
  parameters: z.object({
    firstName: z.string().describe("Patient's first name"),
    lastName: z.string().describe("Patient's last name"),
    dob: z.string().describe("Date of birth in MM/DD/YYYY format"),
  }),
  execute: async ({ firstName, lastName, dob }, { ctx }) => {
    const state = getState(ctx);
    const result = await resolvePatientForCall(state, {
      body: { firstName, lastName, dob },
    });
    if (result.status === "verified") {
      applyResolvedPatientToState(state, result);
      return verifiedPatientReply(result);
    }
    return patientLookupReply(result);
  },
});

function verifiedPatientReply(result: PatientResolveVerified): string {
  const patientName = result.name?.trim() || "the patient";
  if (result.appointmentsStatus === "found" && result.appointments.length > 0) {
    const appointments = result.appointments
      .slice(0, 3)
      .map(spokenAppointment)
      .join("; ");
    const remaining = result.appointments.length - 3;
    const more = remaining > 0 ? `; and ${remaining} more` : "";
    return `Found ${patientName} and loaded ${result.appointments.length} appointment${result.appointments.length === 1 ? "" : "s"}: ${appointments}${more}.`;
  }
  if (result.appointmentsStatus === "none") {
    return `Found ${patientName}. No upcoming appointments are loaded.`;
  }
  if (result.appointmentsStatus === "error") {
    return `Found ${patientName}, but appointments could not be loaded. Try verifying again before confirming or cancelling.`;
  }
  return `Found ${patientName} and loaded the patient record.`;
}

function patientLookupReply(result: PatientResolveResult): string {
  if (result.status === "not_found") {
    return (
      result.message ??
      "No matching patient was found. Confirm the spelling and date of birth, or register them as a new patient."
    );
  }
  if (result.status === "multiple_matches") {
    return "Multiple matching patients were found. Confirm the spelling and date of birth, then try again.";
  }
  return result.message ?? "Patient lookup failed. Try again.";
}

function spokenAppointment(
  appointment: PatientResolveVerified["appointments"][number],
): string {
  return [
    appointment.date,
    appointment.time ? `at ${appointment.time}` : "",
    appointment.provider ? `with ${appointment.provider}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}
