// tools.ts — Tool definitions for the voice agent
// Each tool makes an HTTP call to the AdvancedMD middleware on Railway.

import { llm, voice } from "@livekit/agents";
import { SipClient } from "livekit-server-sdk";
import { readFileSync } from "fs";
import { join } from "path";
import { z } from "zod";

const WORKSPACE = join(import.meta.dirname, "..", "workspace");

const BASE_URL = process.env.AMD_API_URL ?? "https://advancedmd-token-management-dev.up.railway.app";
const AUTH_TOKEN = process.env.AMD_API_TOKEN ?? "";
const OFFICE_TRANSFER_NUMBER = process.env.OFFICE_TRANSFER_NUMBER ?? "";

// --- Session-scoped call state ---

export interface CallerAppointment {
  id: number;
  date: string;
  time: string;
  provider: string;
  type: string;
  facility: string;
  confirmed: boolean;
}

export interface CallerMatch {
  status: "verified";
  patientId: string;
  name: string;
  dob: string;
  phone: string;
  insuranceCarrier: string;
  routing: string;
  allowedProviders: string[];
  routingAmbiguous: boolean;
  appointments: CallerAppointment[] | null;
}

export interface CallerMultipleMatches {
  status: "multiple_matches";
  message: string;
  matches: Array<{ firstName: string }>;
}

export type PhoneLookupResult = CallerMatch | CallerMultipleMatches | null;

export interface CallState {
  office: string;
  sipRoomName: string;
  sipParticipantIdentity: string;
  callerPhone: string;
  // Populated by phone lookup, verify_patient, or add_patient
  patientId: string | null;
  patientName: string | null;
  dob: string | null;
  insuranceCarrier: string | null;
  routing: string | null;
  allowedProviders: string[];
  routingAmbiguous: boolean;
  preauthRequired: boolean;
  appointments: CallerAppointment[];
}

// Per-call state lives on session.userData so concurrent calls don't collide
function getState(ctx: voice.RunContext): CallState {
  return ctx.session.userData as CallState;
}

/** Pre-call phone lookup — called from main.ts before session starts. */
export async function lookupByPhone(phone: string, office: string): Promise<PhoneLookupResult> {
  try {
    const data = await callApi("/api/patient-lookup", { phone }, office) as any;
    if (data.status === "verified") {
      return {
        status: "verified",
        patientId: data.patientId,
        name: data.name,
        dob: data.dob,
        phone: data.phone,
        insuranceCarrier: data.insuranceCarrier,
        routing: data.routing,
        allowedProviders: data.allowedProviders ?? [],
        routingAmbiguous: data.routingAmbiguous ?? false,
        appointments: data.appointments ?? null,
      };
    }
    if (data.status === "multiple_matches") {
      return { status: "multiple_matches", message: data.message, matches: data.matches };
    }
    return null;
  } catch {
    return null;
  }
}

async function callApi(path: string, body: Record<string, unknown>, office?: string): Promise<unknown> {
  if (office) {
    body.office = office;
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
    lastName: z.string().describe("Patient's last name"),
    firstName: z.string().describe("Patient's first name"),
    dob: z.string().describe("Patient's date of birth in MM/DD/YYYY format"),
  }),
  execute: async ({ lastName, firstName, dob }, { ctx }) => {
    const result = await callApi("/api/verify-patient", { lastName, firstName, dob }, getState(ctx).office) as any;
    if (result?.patientId) {
      const state = getState(ctx);
      state.patientId = result.patientId;
      state.patientName = result.name ?? null;
      state.dob = result.dob ?? null;
      state.insuranceCarrier = result.insuranceCarrier ?? null;
      state.routing = result.routing ?? null;
      state.allowedProviders = result.allowedProviders ?? [];
      state.routingAmbiguous = result.routingAmbiguous ?? false;
    }
    return result;
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
  execute: async (params, { ctx }) => {
    const result = await callApi("/api/add-patient", params, getState(ctx).office) as any;
    if (result?.patientId) {
      const state = getState(ctx);
      state.patientId = result.patientId;
      state.patientName = result.name ?? null;
      state.dob = result.dob ?? null;
      state.routing = result.routing ?? null;
      state.allowedProviders = result.allowedProviders ?? [];
      state.preauthRequired = result.preauthRequired ?? false;
    }
    return result;
  },
});

// --- get_availability ---
export const get_availability = llm.tool({
  description:
    "Gets schedule availability from the AdvancedMD scheduler. Requires a date. Routing and preauth are automatically applied from session state.",
  parameters: z.object({
    date: z.string().describe("Start date to search, formatted YYYY-MM-DD"),
  }),
  execute: async ({ date }, { ctx }) => {
    const state = getState(ctx);
    const body: Record<string, unknown> = { date };
    if (state.routing) body.routing = state.routing;
    if (state.preauthRequired) body.preauthRequired = true;
    return callApi("/api/scheduler/availability", body, state.office);
  },
});

// --- confirm_appt ---
export const confirm_appt = llm.tool({
  description:
    "Retrieves upcoming appointments for a verified patient. Patient ID is automatically used from session state.",
  parameters: z.object({
    patientId: z.string().optional().describe("Patient ID — auto-filled from session state if omitted"),
  }),
  execute: async ({ patientId }, { ctx }) => {
    const state = getState(ctx);
    const id = patientId ?? state.patientId;
    if (!id) return "No patient verified yet. Verify the patient first.";
    return callApi("/api/patient/appointments", { patientId: id }, state.office);
  },
});

// --- cancel_appt ---
export const cancel_appt = llm.tool({
  description:
    "Cancels an existing appointment. Requires the appointment ID from the confirm_appt response.",
  parameters: z.object({
    appointmentId: z.number().describe("Appointment ID from the confirm_appt response"),
  }),
  execute: async ({ appointmentId }, { ctx }) => {
    return callApi("/api/appointment/cancel", { appointmentId }, getState(ctx).office);
  },
});

// --- book_appt ---
export const book_appt = llm.tool({
  description:
    "Books an appointment after the patient confirms their preferred time slot. Use columnId, profileId, slotDuration, and datetime from the get_availability response. Patient ID is automatically used from session state.",
  parameters: z.object({
    patientId: z.string().optional().describe("Patient ID — auto-filled from session state if omitted"),
    columnId: z.number().describe("columnId of the selected provider from get_availability"),
    profileId: z.number().describe("profileId of the selected provider from get_availability"),
    startDatetime: z.string().describe("Slot datetime from get_availability, format YYYY-MM-DDTHH:MM"),
    duration: z.number().describe("Slot duration in minutes from get_availability (15 or 30)"),
    appointmentTypeId: z.number().describe("Appointment type: 1004=New Pediatric, 1005=Est Pediatric, 1006=New Adult, 1007=Est Adult, 1008=Post Op"),
  }),
  execute: async (params, { ctx }) => {
    const state = getState(ctx);
    const patientId = params.patientId ?? state.patientId;
    if (!patientId) return "No patient verified yet. Verify the patient first.";
    return callApi("/api/appointment/book", { ...params, patientId }, state.office);
  },
});

// --- Cached file reads (loaded once, never change at runtime) ---
let insuranceCache: string | undefined;
let knowledgeCache: string | undefined;

// --- check_insurance ---
export const check_insurance = llm.tool({
  description:
    "Look up whether the office accepts a specific insurance plan. Use when a caller asks about insurance acceptance or you need to verify their plan name before registration.",
  parameters: z.object({
    plan: z.string().describe("The insurance plan name the caller mentioned"),
  }),
  execute: async ({ plan }) => {
    insuranceCache ??= readFileSync(join(WORKSPACE, "INSURANCE.md"), "utf-8");
    return insuranceCache;
  },
});

// --- lookup_knowledge ---
export const lookup_knowledge = llm.tool({
  description:
    "Look up practice information: office hours, location, providers, services offered, what to bring, appointment expectations, urgency screening, or glasses warranty. Use when a caller asks a question about the practice.",
  parameters: z.object({
    question: z.string().describe("What the caller is asking about (e.g. 'office hours', 'do you see kids', 'what should I bring')"),
  }),
  execute: async ({ question }) => {
    knowledgeCache ??= readFileSync(join(WORKSPACE, "KNOWLEDGE_SPRINGHILL.md"), "utf-8");
    return knowledgeCache;
  },
});

// --- transfer_call ---
export const transfer_call = llm.tool({
  description:
    "Transfers the caller to a human at the office. Use only after confirming with the caller that they want to be transferred. The call ends for the agent after transfer.",
  parameters: z.object({}),
  execute: async (_, { ctx }) => {
    ctx.speechHandle.allowInterruptions = false;
    const state = getState(ctx);
    if (!state.sipRoomName || !state.sipParticipantIdentity) {
      return "Could not transfer — no active SIP session.";
    }
    if (!OFFICE_TRANSFER_NUMBER) {
      return "Could not transfer — no transfer number configured.";
    }

    const sipClient = new SipClient(
      process.env.LIVEKIT_URL!,
      process.env.LIVEKIT_API_KEY!,
      process.env.LIVEKIT_API_SECRET!,
    );

    try {
      await sipClient.transferSipParticipant(
        state.sipRoomName,
        state.sipParticipantIdentity,
        `tel:${OFFICE_TRANSFER_NUMBER}`,
        { playDialtone: false },
      );
      console.log(`[tools] Transferred ${state.sipParticipantIdentity} to ${OFFICE_TRANSFER_NUMBER}`);
      return "Transfer initiated successfully.";
    } catch (err) {
      console.error("[tools] Transfer failed:", err);
      return "Could not transfer the call. Please try again.";
    }
  },
});
