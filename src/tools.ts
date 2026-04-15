// tools.ts — Tool definitions for the voice agent
// Each tool makes an HTTP call to the AdvancedMD middleware on Railway.

import { llm, voice } from "@livekit/agents";
import { SipClient } from "livekit-server-sdk";
import { readFileSync } from "fs";
import { join } from "path";
import { z } from "zod";
import {
  type OfficeKey,
  getOfficeConfig,
  getOfficeConfigByPhone,
  SPRING_HILL_OFFICE_PHONE,
} from "./offices.js";
import {
  buildInsuranceToolResponse,
  canonicalInsurancePlan,
  matchInsurancePlanForOffice,
} from "./insurance-rules.js";

const WORKSPACE = join(import.meta.dirname, "..", "workspace");

const BASE_URL =
  process.env.AMD_API_URL ??
  "https://advancedmd-token-management-production.up.railway.app";
const AUTH_TOKEN = process.env.AMD_API_TOKEN ?? "";
let _sipClient: SipClient | undefined;
function getSipClient(): SipClient {
  _sipClient ??= new SipClient(
    process.env.LIVEKIT_URL!,
    process.env.LIVEKIT_API_KEY!,
    process.env.LIVEKIT_API_SECRET!,
  );
  return _sipClient;
}

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
  insPlanId: string | null;
  respPartyId: string | null;
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
  officeKey: OfficeKey;
  officePhone: string;
  amdOfficePhone: string;
  sipRoomName: string;
  sipParticipantIdentity: string;
  callerPhone: string;
  // Populated by phone lookup, verify_patient, or add_patient
  patientId: string | null;
  patientName: string | null;
  dob: string | null;
  insuranceCarrier: string | null;
  insPlanId: string | null;
  respPartyId: string | null;
  checkedInsurancePlan: string | null;
  routing: string | null;
  allowedProviders: string[];
  routingAmbiguous: boolean;
  preauthRequired: boolean;
  appointments: CallerAppointment[];
  transferred: boolean;
}

// Per-call state lives on session.userData so concurrent calls don't collide
function getState(ctx: voice.RunContext): CallState {
  return ctx.session.userData as CallState;
}

export function getSpringHillOfficePhone(): string {
  return SPRING_HILL_OFFICE_PHONE;
}

export function getAmdOfficeForToolCall(
  state: Pick<CallState, "officeKey" | "amdOfficePhone">,
): string {
  return (
    state.amdOfficePhone || getOfficeConfig(state.officeKey).amdOfficePhone
  );
}

/** Apply patient data from an API response, resetting all patient fields so nothing stale lingers. */
function applyPatientResult(state: CallState, result: any): void {
  state.patientId = result.patientId ?? null;
  state.patientName = result.name ?? null;
  state.dob = result.dob ?? null;
  state.insuranceCarrier = result.insuranceCarrier ?? null;
  state.insPlanId = result.insPlanId ?? null;
  state.respPartyId = result.respPartyId ?? null;
  state.checkedInsurancePlan = result.insuranceCarrier ?? null;
  state.routing = result.routing ?? null;
  state.allowedProviders = result.allowedProviders ?? [];
  state.routingAmbiguous = result.routingAmbiguous ?? false;
  state.preauthRequired = result.preauthRequired ?? false;
  state.appointments = [];
}

/** Pre-call phone lookup — called from main.ts before session starts. */
export async function lookupByPhone(
  phone: string,
  trunkPhone: string,
): Promise<PhoneLookupResult> {
  try {
    const office = getOfficeConfigByPhone(trunkPhone);
    const data = (await callApi(
      "/api/patient-lookup",
      { phone },
      office.amdOfficePhone,
    )) as any;
    if (data.status === "verified") {
      return {
        status: "verified",
        patientId: data.patientId,
        name: data.name,
        dob: data.dob,
        phone: data.phone,
        insuranceCarrier: data.insuranceCarrier,
        insPlanId: data.insPlanId ?? null,
        respPartyId: data.respPartyId ?? null,
        routing: data.routing,
        allowedProviders: data.allowedProviders ?? [],
        routingAmbiguous: data.routingAmbiguous ?? false,
        appointments: data.appointments ?? null,
      };
    }
    if (data.status === "multiple_matches") {
      return {
        status: "multiple_matches",
        message: data.message,
        matches: data.matches,
      };
    }
    return null;
  } catch {
    return null;
  }
}

async function callApi(
  path: string,
  body: Record<string, unknown>,
  office?: string,
): Promise<unknown> {
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
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API error ${res.status}: ${text}`);
  }
  return res.json();
}

// --- verify_patient ---
export const verify_patient = llm.tool({
  description: `Verifies a patient's identity.

For MULTIPLE MATCHES (caller context says multiple patients on this number): just pass firstName and phone — the middleware matches by phone + first name. Do NOT ask for last name or DOB upfront.

For all other cases: pass firstName, lastName, and dob (MM/DD/YYYY).

Do NOT call if phone lookup already verified the patient (single match + confirmed first name). Check CALLER CONTEXT first.

After response:
- If verified: let them know and move on.
- If routingAmbiguous: ask what type of plan (regular, EPO, HMO, Medicare). If HMO, scheduling starts two weeks out due to preauth.
- If routing is "not_accepted": tell them straightforwardly.
- If not found and you only sent firstName + phone: ask for last name and DOB and retry with full details.
- If not found with full details: ask them to spell their name and retry with corrections.
- If still not found after retry: lead into registration — "ok no worries, let me get you set up."`,
  parameters: z.object({
    firstName: z.string().describe("Patient's first name"),
    lastName: z
      .string()
      .optional()
      .describe(
        "Patient's last name (optional for multiple-match phone lookup)",
      ),
    dob: z
      .string()
      .optional()
      .describe(
        "Patient's date of birth in MM/DD/YYYY format (optional for multiple-match phone lookup)",
      ),
    usePhone: z
      .boolean()
      .optional()
      .describe(
        "Set true for multiple-match flow to verify by first name + caller phone number",
      ),
  }),
  execute: async ({ firstName, lastName, dob, usePhone }, { ctx }) => {
    const body: Record<string, unknown> = { firstName };
    if (lastName) body.lastName = lastName;
    if (dob) body.dob = dob;
    if (usePhone) body.phone = getState(ctx).callerPhone;
    const result = (await callApi(
      "/api/verify-patient",
      body,
      getAmdOfficeForToolCall(getState(ctx)),
    )) as any;
    if (result?.patientId) {
      applyPatientResult(getState(ctx), result);
    }
    return result;
  },
});

// --- add_patient ---
export const add_patient = llm.tool({
  description: `Creates a new patient record. Use only when verify_patient returns no match. Every field must come from what the caller explicitly said — never fabricate or guess values.

Follow the registration order in the runbook. Key rules for this tool:
- Run check_insurance first. Use the canonicalPlan from the latest check_insurance result for the insurance value sent to middleware. If the tool accepted a family alias like "Blue Cross" or "Oscar", do not rewrite it yourself.
- Ask "is the number you're calling from a good one on file?" If yes, omit phone and this tool will use the inbound caller number already stored in session state. If no, collect the best 10-digit phone number and pass it explicitly.
- If subscriber is "me" or "mine" = use patient name.
- Member ID is required — do not imply registration is almost done until you have it. If they don't have their card, offer to hold.
- Before submitting: read back name (spell last name letter by letter), DOB, insurance plan, and member ID. Wait for confirmation.

After response: if routing "not_accepted", tell them. If preauthRequired, scheduling starts two weeks out. Go straight to scheduling — don't check appointments for a new patient.

Preauth insurances: Humana Gold Plus, Humana Medicaid, United Healthcare HMO, Aetna HMO, Florida Blue Medicare HMO, Cigna HMO, Tricare Prime, Tricare Forever.`,
  parameters: z.object({
    firstName: z.string().describe("Patient's first name"),
    lastName: z.string().describe("Patient's last name"),
    dob: z.string().describe("Date of birth in MM/DD/YYYY format"),
    phone: z
      .string()
      .optional()
      .describe(
        "Cell phone number, 10 digits only. Omit if the caller confirms the number they're calling from is the best number on file",
      ),
    email: z.string().describe("Email address"),
    street: z.string().describe("Street address"),
    aptSuite: z
      .string()
      .default("")
      .describe("Apartment or suite number, empty string if none"),
    city: z.string().describe("City"),
    state: z.string().describe("State, 2-letter abbreviation"),
    zip: z.string().describe("Zip code"),
    sex: z.enum(["male", "female"]).describe("Patient's sex"),
    insurance: z.string().describe("Insurance carrier name"),
    subscriberName: z
      .string()
      .describe("Name of the person on the insurance policy"),
    subscriberNum: z.string().describe("Insurance subscriber/member ID number"),
  }),
  execute: async (params, { ctx }) => {
    const state = getState(ctx);
    const insurance = state.checkedInsurancePlan ?? params.insurance;
    const phone = params.phone ?? state.callerPhone;
    if (!phone) {
      return "ERROR: No phone number is available. Ask whether the number they're calling from is good; if not, collect the best phone number.";
    }
    const result = (await callApi(
      "/api/add-patient",
      { ...params, insurance, phone },
      getAmdOfficeForToolCall(state),
    )) as any;
    if (result?.patientId) {
      applyPatientResult(state, result);
    }
    return result;
  },
});

// --- update_insurance ---
export const update_insurance = llm.tool({
  description: `Updates a verified patient's insurance. Requires verify_patient first. Confirm plan name and member ID with caller before submitting.

Run check_insurance first and use the canonicalPlan from the latest result for the insurance value sent to middleware.

After response: session state updates automatically. If preauthRequired, scheduling starts two weeks out.`,
  parameters: z.object({
    insurance: z.string().describe("New insurance plan name"),
    subscriberName: z.string().describe("Name on the insurance card"),
    subscriberNum: z.string().describe("Member/subscriber ID from the card"),
  }),
  execute: async ({ insurance, subscriberName, subscriberNum }, { ctx }) => {
    const state = getState(ctx);
    if (!state.patientId) return "ERROR: No patient verified yet.";
    const insuranceForMiddleware = state.checkedInsurancePlan ?? insurance;
    const result = (await callApi(
      "/api/patient/update-insurance",
      {
        patientId: state.patientId,
        insPlanId: state.insPlanId ?? "",
        respPartyId: state.respPartyId ?? "",
        oldInsurance: state.insuranceCarrier ?? "",
        insurance: insuranceForMiddleware,
        subscriberName,
        subscriberNum,
      },
      getAmdOfficeForToolCall(state),
    )) as any;
    if (result?.status === "updated") {
      state.insuranceCarrier = result.newInsurance ?? state.insuranceCarrier;
      state.insPlanId = result.insPlanId ?? null;
      state.respPartyId = result.respPartyId ?? null;
      state.routing = result.routing ?? state.routing;
      state.allowedProviders =
        result.allowedProviders ?? state.allowedProviders;
      state.routingAmbiguous = result.routingAmbiguous ?? false;
      state.preauthRequired = result.preauthRequired ?? false;
    }
    return result;
  },
});

// --- get_availability ---
export const get_availability = llm.tool({
  description: `Gets schedule availability. Requires date (YYYY-MM-DD). Routing and preauth auto-applied from session state.

Appointment type codes — you determine new/existing (from verify_patient) and adult/pediatric (from DOB). Ask the caller the reason for their visit before calling this tool so you pick the right code:
- New 18+ = 1006, new under 18 = 1004
- Existing 18+ = 1007, existing under 18 = 1005
- Post-op (1008) = only if the caller says they're coming in for a post-op or follow-up after recent surgery.

Rules: no same-day appointments — earliest is tomorrow. If the caller asks for today, just let them know the earliest you can schedule is tomorrow and offer that. Don't make up a policy — just move to the next available day. Under 18 = Dr. Bach only. Bach has limited schedule — set expectations. If routing is "not_accepted", do not call. "ASAP" or "whenever" = search tomorrow.

After response: check if date shifted vs requested — tell caller if different. Suggest one best-fit slot (date + time). Mention the doctor only if asked or clinically relevant. If rejected, offer one alternative. Scan existing results before calling again. If no slots are returned, tell the caller that date has no openings and offer the nearest available date.`,
  parameters: z.object({
    date: z.string().describe("Start date to search, formatted YYYY-MM-DD"),
  }),
  execute: async ({ date }, { ctx }) => {
    const state = getState(ctx);
    const body: Record<string, unknown> = { date };
    if (state.routing) body.routing = state.routing;
    if (state.preauthRequired) body.preauthRequired = true;
    return callApi(
      "/api/scheduler/availability",
      body,
      getAmdOfficeForToolCall(state),
    );
  },
});

// --- confirm_appt ---
export const confirm_appt = llm.tool({
  description: `Retrieves upcoming appointments (next 60 days) for a verified patient. Patient ID is read from session state automatically. Requires a verified patient — either from phone lookup or verify_patient.

If appointments (with IDs) are already shown in the caller context from the phone lookup AND you haven't switched patients, you already have this data — skip this tool. Only call if you switched patients, need fresh data, or appointments weren't in the caller context.

Read back the nearest appointment: date, time, doctor, and location. If multiple, read one at a time. If none found, offer to schedule.`,
  parameters: z.object({}),
  execute: async (_, { ctx }) => {
    const state = getState(ctx);
    if (!state.patientId)
      return "ERROR: No patient verified yet. Run verify_patient first with the caller's firstName, lastName, and dob.";
    return callApi(
      "/api/patient/appointments",
      { patientId: state.patientId },
      getAmdOfficeForToolCall(state),
    );
  },
});

// --- cancel_appt ---
export const cancel_appt = llm.tool({
  description: `Cancels an appointment. You MUST call this tool to cancel — an appointment is not cancelled until this tool executes successfully. Never tell the caller an appointment is cancelled without calling this tool first.

Requires appointmentId — use the ID from the caller context (phone lookup) or from a confirm_appt response. Read back the details and confirm the caller wants it cancelled before calling. If they want to reschedule, book the new appointment first, then cancel.`,
  parameters: z.object({
    appointmentId: z
      .number()
      .describe("Appointment ID from the confirm_appt response"),
  }),
  execute: async ({ appointmentId }, { ctx }) => {
    return callApi(
      "/api/appointment/cancel",
      { appointmentId },
      getAmdOfficeForToolCall(getState(ctx)),
    );
  },
});

// --- book_appt ---
export const book_appt = llm.tool({
  description: `Books an appointment. Pass columnId, profileId, startDatetime, duration, and appointmentTypeId from get_availability. Patient ID is read from session state automatically.

The slot offer is the confirmation — if the caller said yes, book it. If fails, retry once. If still fails, offer different time or transfer.`,
  parameters: z.object({
    columnId: z
      .number()
      .describe("columnId of the selected provider from get_availability"),
    profileId: z
      .number()
      .describe("profileId of the selected provider from get_availability"),
    startDatetime: z
      .string()
      .describe("Slot datetime from get_availability, format YYYY-MM-DDTHH:MM"),
    duration: z
      .number()
      .describe("Slot duration in minutes from get_availability (15 or 30)"),
    appointmentTypeId: z
      .number()
      .describe(
        "Appointment type: 1004=New Pediatric, 1005=Est Pediatric, 1006=New Adult, 1007=Est Adult, 1008=Post Op",
      ),
  }),
  execute: async (params, { ctx }) => {
    const state = getState(ctx);
    if (!state.patientId)
      return "No patient verified yet. Verify the patient first.";
    return callApi(
      "/api/appointment/book",
      { ...params, patientId: state.patientId },
      getAmdOfficeForToolCall(state),
    );
  },
});

// --- route_to_spring_hill ---
export const route_to_spring_hill = llm.tool({
  description: `Switches AMD tool calls to the Spring Hill office without transferring the caller.

Use this when the caller reached Crystal River but the visit must be handled through Spring Hill scheduling — especially pediatrics or cataract evaluation, workup, or surgery scheduling. Call this before verify_patient, add_patient, update_insurance, get_availability, confirm_appt, cancel_appt, or book_appt for that visit. Keep the caller on the line and continue helping them normally.`,
  parameters: z.object({}),
  execute: async (_, { ctx }) => {
    const state = getState(ctx);
    const springHillOffice = getSpringHillOfficePhone();
    state.amdOfficePhone = springHillOffice;
    return `AMD routing switched to Spring Hill (${springHillOffice}). Continue the call without transferring.`;
  },
});

// --- Cached file reads (loaded once per file, never change at runtime) ---
const workspaceFileCache: Record<string, string> = {};

function readWorkspaceFile(file: string): string {
  workspaceFileCache[file] ??= readFileSync(join(WORKSPACE, file), "utf-8");
  return workspaceFileCache[file];
}

export function resolveKnowledgeFileForOffice(officeKey: OfficeKey): string {
  return getOfficeConfig(officeKey).knowledgeFile;
}

// --- check_insurance ---
export const check_insurance = llm.tool({
  description: `Looks up whether the office accepts a specific insurance plan or family alias.

Use when a caller asks if a plan is accepted or during new-patient registration.
If the caller gives a plan or family name that matches the insurance map, run this tool with that exact phrase.
Do NOT force HMO, PPO, or Medicare as a default follow-up. Only ask for that kind of clarification if this tool returns clarificationNeeded.

The tool returns a small summary for the model:
- status
- canProceed
- canonicalPlan
- clarificationNeeded
- callerMessage

Use canonicalPlan for add_patient or update_insurance when canProceed=true.`,
  parameters: z.object({
    plan: z.string().describe("The insurance plan name the caller mentioned"),
  }),
  execute: async ({ plan }, { ctx }) => {
    const state = getState(ctx);
    const result = matchInsurancePlanForOffice(state.officeKey, plan);
    state.checkedInsurancePlan = canonicalInsurancePlan(result);
    return buildInsuranceToolResponse(result);
  },
});

// --- lookup_knowledge ---
export const lookup_knowledge = llm.tool({
  description: `Looks up practice info: hours, location, providers, services, what to bring, appointment expectations, urgency screening, glasses warranty.

Answer naturally from the returned info — just the part that answers their question.`,
  parameters: z.object({
    question: z
      .string()
      .describe(
        "What the caller is asking about (e.g. 'office hours', 'do you see kids', 'what should I bring')",
      ),
  }),
  execute: async (_args, { ctx }) => {
    const file = resolveKnowledgeFileForOffice(getState(ctx).officeKey);
    return readWorkspaceFile(file);
  },
});

// --- transfer_call ---
export const transfer_call = llm.tool({
  description:
    "Transfers the caller to the office. Say your transfer message (see RUNBOOK) and wait for it to finish BEFORE calling this tool. Call once — after it executes the SIP session disconnects and your turn is over.",
  parameters: z.object({}),
  execute: async (_, { ctx }) => {
    const state = getState(ctx);
    // Guard: prevent duplicate transfers (LLM sometimes calls this twice)
    if (state.transferred) {
      return "Already transferred. No action needed.";
    }
    if (ctx.speechHandle) ctx.speechHandle.allowInterruptions = false;
    // Wait for the transfer announcement to finish playing before initiating
    await ctx.waitForPlayout();
    if (!state.sipRoomName || !state.sipParticipantIdentity) {
      return "Could not transfer — no active SIP session.";
    }
    try {
      state.transferred = true;
      const transferNumber = getOfficeConfig(state.officeKey).transferNumber;
      await getSipClient().transferSipParticipant(
        state.sipRoomName,
        state.sipParticipantIdentity,
        `tel:${transferNumber}`,
        { playDialtone: false },
      );
      const result = "Transfer initiated successfully.";
      console.log(
        `[tools] Transferred ${state.sipParticipantIdentity} to ${transferNumber}`,
      );
      // Framework handles shutdown via close_on_disconnect when the
      // SIP participant leaves after the transfer completes.
      return result;
    } catch (err) {
      const result = "Could not transfer the call. Please try again.";
      console.error("[tools] Transfer failed:", err);
      return result;
    }
  },
});
