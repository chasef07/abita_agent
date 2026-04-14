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
import { matchInsurancePlanForOffice } from "./insurance-rules.js";

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
  description: `Verify a patient identity.

Use when you need a patient record for scheduling or appointment actions.
For multiple-match phone flow, pass firstName and usePhone=true.
Otherwise pass firstName, lastName, and dob (MM/DD/YYYY).
Returns verification status, patient identity, and routing data.`,
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
  description: `Create a new patient record.

Use only after verify_patient returns no match.
All fields must come from the caller; do not guess or fabricate values.
Phone must be 10 digits.
Returns the created patient record and routing data.`,
  parameters: z.object({
    firstName: z.string().describe("Patient's first name"),
    lastName: z.string().describe("Patient's last name"),
    dob: z.string().describe("Date of birth in MM/DD/YYYY format"),
    phone: z.string().describe("Cell phone number, 10 digits only"),
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
    const result = (await callApi(
      "/api/add-patient",
      params,
      getAmdOfficeForToolCall(getState(ctx)),
    )) as any;
    if (result?.patientId) {
      applyPatientResult(getState(ctx), result);
    }
    return result;
  },
});

// --- update_insurance ---
export const update_insurance = llm.tool({
  description: `Update insurance for a verified patient.

Requires a verified patient in session state.
Pass the exact plan name, subscriber name, and member ID from the insurance card.
Updates session routing and insurance state from the result.`,
  parameters: z.object({
    insurance: z.string().describe("New insurance plan name"),
    subscriberName: z.string().describe("Name on the insurance card"),
    subscriberNum: z.string().describe("Member/subscriber ID from the card"),
  }),
  execute: async ({ insurance, subscriberName, subscriberNum }, { ctx }) => {
    const state = getState(ctx);
    if (!state.patientId) return "ERROR: No patient verified yet.";
    const result = (await callApi(
      "/api/patient/update-insurance",
      {
        patientId: state.patientId,
        insPlanId: state.insPlanId ?? "",
        respPartyId: state.respPartyId ?? "",
        oldInsurance: state.insuranceCarrier ?? "",
        insurance,
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
  description: `Get appointment availability starting from a date (YYYY-MM-DD).

Uses routing and preauth state from session state automatically.
Use after you know the visit reason and appointment type.
Returns available appointment slots.`,
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
  description: `Get upcoming appointments for the verified patient.

Requires a verified patient in session state.
Use when you need fresh appointment data or it is not already available in caller context.
Returns upcoming appointments.`,
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
  description: `Cancel an appointment by appointmentId.

Use only after the caller confirms they want that appointment cancelled.
The appointment is not cancelled until this tool succeeds.`,
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
  description: `Book an appointment slot for the verified patient.

Pass columnId, profileId, startDatetime, duration, and appointmentTypeId from get_availability.
Patient ID is read from session state automatically.
Returns booking status and appointment details.`,
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
  description: `Route AMD tool calls to the Spring Hill office without transferring the caller.

Use on Crystal River calls when the visit must be scheduled through Spring Hill.
Updates AMD office routing for the rest of the call.`,
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
  description: `Look up accepted insurance plans for the current office.

Use when a caller asks if a plan is accepted or before registering a new patient.
Returns status, canProceed, needsExactPlanName, and a short caller-facing summary.
If canProceed=true and needsExactPlanName=true, you can continue registration now and collect the exact plan name from the card later before add_patient or update_insurance.`,
  parameters: z.object({
    plan: z.string().describe("The insurance plan name the caller mentioned"),
  }),
  execute: async ({ plan }, { ctx }) => {
    return matchInsurancePlanForOffice(getState(ctx).officeKey, plan);
  },
});

// --- lookup_knowledge ---
export const lookup_knowledge = llm.tool({
  description: `Look up office information for the current office.

Use for questions about hours, location, providers, services, what to bring, and related practice facts.
Returns the office knowledge reference.`,
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
    "Transfer the caller to the office. Use when the call must be handed to a human. Say the transfer message before calling this tool. After this tool succeeds, the call is effectively over.",
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
