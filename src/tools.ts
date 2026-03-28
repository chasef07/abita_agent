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
/** Map trunk phone → transfer number. Default = Spring Hill. */
const TRANSFER_NUMBERS: Record<string, string> = {
  "+13523202007": "+16182265883", // Crystal River (Eye Radiance)
};
const DEFAULT_TRANSFER_NUMBER = "+16182265883"; // Spring Hill

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

/** Apply patient data from an API response, resetting all patient fields so nothing stale lingers. */
function applyPatientResult(state: CallState, result: any): void {
  state.patientId = result.patientId ?? null;
  state.patientName = result.name ?? null;
  state.dob = result.dob ?? null;
  state.insuranceCarrier = result.insuranceCarrier ?? null;
  state.routing = result.routing ?? null;
  state.allowedProviders = result.allowedProviders ?? [];
  state.routingAmbiguous = result.routingAmbiguous ?? false;
  state.preauthRequired = result.preauthRequired ?? false;
  state.appointments = [];
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
  description: `Verifies a patient's identity. Requires lastName, firstName, dob (MM/DD/YYYY).

Do NOT call if phone lookup already verified the patient (single match + confirmed first name). Check CALLER CONTEXT first.

Before calling: confirm the first name and spell the last name back to the caller. Wait for them to confirm or correct before submitting.

Call with what you heard — the API is the source of truth for spelling.

After response:
- If verified: let them know, move on. Ask if HMO or PPO — if HMO, scheduling starts two weeks out due to preauth.
- If routingAmbiguous: ask what type of plan (regular, EPO, HMO, Medicare).
- If routing is "not_accepted": tell them straightforwardly.
- If not found: spell back what you actually heard, letter by letter. Retry with corrections. Try first name too if last name was right.
- If still not found after retry: lead into registration — "ok no worries, let me get you set up."`,
  parameters: z.object({
    lastName: z.string().describe("Patient's last name"),
    firstName: z.string().describe("Patient's first name"),
    dob: z.string().describe("Patient's date of birth in MM/DD/YYYY format"),
  }),
  execute: async ({ lastName, firstName, dob }, { ctx }) => {
    const result = await callApi("/api/verify-patient", { lastName, firstName, dob }, getState(ctx).office) as any;
    if (result?.patientId) {
      applyPatientResult(getState(ctx), result);
    }
    return result;
  },
});

// --- add_patient ---
export const add_patient = llm.tool({
  description: `Creates a new patient record. Use only when verify_patient returns no match.

Collect in clusters:
1. Insurance — run check_insurance first. If carrier has multiple plans (e.g., Humana), ask which specific plan. Stop if not accepted.
2. Name + DOB — already have from verify attempts. Confirm and skip.
3. Contact — "cell number and email?"
4. Address — "street address, city, state, zip?" Then: "apartment or suite?"
5. Sex — "male or female?"
6. Subscriber — "subscriber name and member ID from the card?" If "me" = use patient name.

Subscriber ID is required — do not imply registration is almost done until you have it. If they don't have their card, offer to hold.

Before submitting: read back name, DOB, email, insurance plan, and member ID. Wait for confirmation.

After response: if routing "not_accepted", tell them. If preauthRequired, scheduling starts two weeks out. Go straight to scheduling — don't check appointments for a new patient.

Preauth insurances: Humana Gold Plus, Humana Medicaid, United Healthcare HMO, Aetna HMO, Florida Blue Medicare HMO, Cigna HMO, Tricare Prime, Tricare Forever.`,
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
      applyPatientResult(getState(ctx), result);
    }
    return result;
  },
});

// --- get_availability ---
export const get_availability = llm.tool({
  description: `Gets schedule availability. Requires date (YYYY-MM-DD). Routing and preauth auto-applied from session state.

Determine appointment type (you decide, not the caller):
- New 18+ = 1006, new under 18 = 1004
- Existing: ask "follow-up or post-op?" Follow-up 18+ = 1007, under 18 = 1005, Post-op = 1008

Rules: no same-day (earliest = tomorrow). Under 18 = Dr. Bach only. Bach has limited schedule — set expectations. If routing is "not_accepted", do not call. "ASAP" or "whenever" = search tomorrow.

After response: check if date shifted vs requested — tell caller if different. Suggest one best-fit slot (date + time). Don't mention doctor unless asked or clinically relevant. If rejected, offer one alternative. Scan existing results before calling again.`,
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
  description: `Retrieves upcoming appointments (next 60 days) for a verified patient. Patient ID is read from session state automatically. Requires a verified patient — either from phone lookup or verify_patient.

If appointments (with IDs) are already shown in the caller context from the phone lookup AND you haven't switched patients, you already have this data — skip this tool. Only call if you switched patients, need fresh data, or appointments weren't in the caller context.

Read back the nearest appointment: date, time, doctor. If multiple, read one at a time. If none found, offer to schedule.`,
  parameters: z.object({}),
  execute: async (_, { ctx }) => {
    const state = getState(ctx);
    if (!state.patientId) return "ERROR: No patient verified yet. Run verify_patient first with the caller's firstName, lastName, and dob.";
    return callApi("/api/patient/appointments", { patientId: state.patientId }, state.office);
  },
});

// --- cancel_appt ---
export const cancel_appt = llm.tool({
  description: `Cancels an appointment. Requires appointmentId — use the ID from the caller context (phone lookup) or from a confirm_appt response.

Read back the details and confirm the caller wants it cancelled before proceeding. If they want to reschedule, book the new appointment first, then cancel.`,
  parameters: z.object({
    appointmentId: z.number().describe("Appointment ID from the confirm_appt response"),
  }),
  execute: async ({ appointmentId }, { ctx }) => {
    return callApi("/api/appointment/cancel", { appointmentId }, getState(ctx).office);
  },
});

// --- book_appt ---
export const book_appt = llm.tool({
  description: `Books an appointment. Pass columnId, profileId, startDatetime, duration, and appointmentTypeId from get_availability. Patient ID is read from session state automatically.

The slot offer is the confirmation — if the caller said yes, book it. If fails, retry once. If still fails, offer different time or transfer.`,
  parameters: z.object({
    columnId: z.number().describe("columnId of the selected provider from get_availability"),
    profileId: z.number().describe("profileId of the selected provider from get_availability"),
    startDatetime: z.string().describe("Slot datetime from get_availability, format YYYY-MM-DDTHH:MM"),
    duration: z.number().describe("Slot duration in minutes from get_availability (15 or 30)"),
    appointmentTypeId: z.number().describe("Appointment type: 1004=New Pediatric, 1005=Est Pediatric, 1006=New Adult, 1007=Est Adult, 1008=Post Op"),
  }),
  execute: async (params, { ctx }) => {
    const state = getState(ctx);
    if (!state.patientId) return "No patient verified yet. Verify the patient first.";
    return callApi("/api/appointment/book", { ...params, patientId: state.patientId }, state.office);
  },
});

// --- Cached file reads (loaded once per file, never change at runtime) ---
let insuranceCache: string | undefined;
const knowledgeCache: Record<string, string> = {};

/** Map trunk phone → knowledge file. Default = Spring Hill. */
const KNOWLEDGE_FILES: Record<string, string> = {
  "+13523202007": "KNOWLEDGE_EYERADIANCE.md",
};
const DEFAULT_KNOWLEDGE = "KNOWLEDGE_SPRINGHILL.md";

// --- check_insurance ---
export const check_insurance = llm.tool({
  description: `Looks up whether the office accepts a specific insurance plan. Returns the full accepted plans list with carrier-specific notes.

Look for the caller's plan. If found, confirm it's accepted. If there's a clarifying note (e.g., "ask which: North Broward or University of Miami?"), follow it. If not on the list: "unfortunately we don't accept that plan." Don't push scheduling — just answer their question and let them lead.`,
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
  description: `Looks up practice info: hours, location, providers, services, what to bring, appointment expectations, urgency screening, glasses warranty.

Answer naturally from the returned info. Don't read back the entire document — just what answers their question.`,
  parameters: z.object({
    question: z.string().describe("What the caller is asking about (e.g. 'office hours', 'do you see kids', 'what should I bring')"),
  }),
  execute: async ({ question }, { ctx }) => {
    const office = getState(ctx).office;
    const file = KNOWLEDGE_FILES[office] ?? DEFAULT_KNOWLEDGE;
    knowledgeCache[file] ??= readFileSync(join(WORKSPACE, file), "utf-8");
    return knowledgeCache[file];
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
    const transferNumber = TRANSFER_NUMBERS[state.office] ?? DEFAULT_TRANSFER_NUMBER;
    if (!transferNumber) {
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
        `tel:${transferNumber}`,
        { playDialtone: false },
      );
      console.log(`[tools] Transferred ${state.sipParticipantIdentity} to ${transferNumber}`);
      return "Transfer initiated successfully.";
    } catch (err) {
      console.error("[tools] Transfer failed:", err);
      return "Could not transfer the call. Please try again.";
    }
  },
});
