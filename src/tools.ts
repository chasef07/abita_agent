// tools.ts — Tool definitions for the voice agent
// Each tool makes an HTTP call to the AdvancedMD middleware on Railway.

import { llm } from "@livekit/agents";
import { z } from "zod";

const BASE_URL = process.env.AMD_API_URL ?? "https://advancedmd-token-management-production.up.railway.app";
const AUTH_TOKEN = process.env.AMD_API_TOKEN ?? "";

// Office identifier (trunk phone number) — set once per call from main.ts
let currentOffice = "";

export function setOffice(phone: string) {
  currentOffice = phone;
  console.log(`[tools] office set to: ${phone}`);
}

async function callApi(path: string, body: Record<string, unknown>): Promise<unknown> {
  if (currentOffice) {
    body.office = currentOffice;
  }
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: AUTH_TOKEN,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API error ${res.status}: ${text}`);
  }
  return res.json();
}

// --- verify_patient ---
export const verify_patient = llm.tool({
  description:
    "Verifies a patient's identity in the AdvancedMD system. Requires last name, first name, and date of birth. Returns patient ID needed for all subsequent operations.",
  parameters: z.object({
    lastName: z.string().describe("Patient's last name (always ask them to spell it)"),
    firstName: z.string().describe("Patient's first name"),
    dob: z.string().describe("Patient's date of birth in MM/DD/YYYY format"),
  }),
  execute: async ({ lastName, firstName, dob }) => {
    return callApi("/api/verify-patient", { lastName, firstName, dob });
  },
});

// --- add_patient ---
export const add_patient = llm.tool({
  description:
    "Creates a new patient record and attaches their insurance. Use when verify_patient returns no match and the caller wants to register.",
  parameters: z.object({
    firstName: z.string().describe("Patient's first name"),
    lastName: z.string().describe("Patient's last name"),
    dob: z.string().describe("Date of birth in MM/DD/YYYY format"),
    phone: z.string().describe("Cell phone number, 10 digits only"),
    email: z.string().describe("Email address"),
    street: z.string().describe("Street address"),
    aptSuite: z.string().default("").describe("Apartment or suite number, empty string if none"),
    city: z.string().describe("City"),
    state: z.string().describe("State, 2-letter abbreviation"),
    zip: z.string().describe("Zip code"),
    sex: z.enum(["male", "female"]).describe("Patient's sex"),
    insurance: z.string().describe("Insurance carrier name"),
    subscriberName: z.string().describe("Name of the person on the insurance policy"),
    subscriberNum: z.string().describe("Insurance subscriber/member ID number"),
  }),
  execute: async (params) => {
    return callApi("/api/add-patient", params);
  },
});

// --- get_availability ---
export const get_availability = llm.tool({
  description:
    "Gets schedule availability from the AdvancedMD scheduler. Requires a date and optionally a routing rule from verify_patient or add_patient.",
  parameters: z.object({
    date: z.string().describe("Start date to search, formatted YYYY-MM-DD"),
    routing: z.string().optional().describe("Routing rule from verify_patient or add_patient (e.g. bach_only, bach_licht, all_three)"),
  }),
  execute: async ({ date, routing }) => {
    const body: Record<string, unknown> = { date };
    if (routing) body.routing = routing;
    return callApi("/api/scheduler/availability", body);
  },
});

// --- confirm_appt ---
export const confirm_appt = llm.tool({
  description:
    "Retrieves upcoming appointments for a verified patient. Requires the patient ID from verify_patient. Returns appointments with date, time, provider, type, and facility.",
  parameters: z.object({
    patientId: z.string().describe("Patient ID from verify_patient response"),
  }),
  execute: async ({ patientId }) => {
    return callApi("/api/patient/appointments", { patientId });
  },
});

// --- cancel_appt ---
export const cancel_appt = llm.tool({
  description:
    "Cancels an existing appointment. Requires the appointment ID from the confirm_appt response.",
  parameters: z.object({
    appointmentId: z.number().describe("Appointment ID from the confirm_appt response"),
  }),
  execute: async ({ appointmentId }) => {
    return callApi("/api/appointment/cancel", { appointmentId });
  },
});

// --- book_appt ---
export const book_appt = llm.tool({
  description:
    "Books an appointment after the patient confirms their preferred time slot. Use columnId, profileId, slotDuration, and datetime from the get_availability response.",
  parameters: z.object({
    patientId: z.string().describe("Patient ID from verify_patient or add_patient"),
    columnId: z.number().describe("columnId of the selected provider from get_availability"),
    profileId: z.number().describe("profileId of the selected provider from get_availability"),
    startDatetime: z.string().describe("Slot datetime from get_availability, format YYYY-MM-DDTHH:MM"),
    duration: z.number().describe("Slot duration in minutes from get_availability (15 or 30)"),
    appointmentTypeId: z.number().describe("Appointment type: 1004=New Pediatric, 1005=Est Pediatric, 1006=New Adult, 1007=Est Adult, 1008=Post Op"),
  }),
  execute: async (params) => {
    return callApi("/api/appointment/book", params);
  },
});
