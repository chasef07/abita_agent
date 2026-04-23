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

export interface CallerLookupError {
  status: "lookup_error";
  message: string;
}

export type PhoneLookupResult =
  | CallerMatch
  | CallerMultipleMatches
  | CallerLookupError
  | null;

export type AvailabilityStatus = "not_checked" | "found" | "none" | "error";

export interface SelectedSlot {
  startDatetime: string;
  columnId: number;
  profileId: number;
  duration: number;
  appointmentTypeId: number;
}

export interface CallState {
  officeKey: OfficeKey;
  effectiveOfficeKey: OfficeKey;
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
  lookupMatchStatus:
    | "none"
    | "single_match"
    | "multiple_matches"
    | "lookup_error";
  originalLookupPatientId: string | null;
  callerConfirmedPatient: boolean;
  switchedPatientThisCall: boolean;
  checkedInsurancePlan: string | null;
  routing: string | null;
  allowedProviders: string[];
  routingAmbiguous: boolean;
  preauthRequired: boolean;
  reasonForVisit: string | null;
  lastAvailabilityQuery: {
    date: string;
    patientId: string | null;
    reasonForVisit: string | null;
    routing: string | null;
    preauthRequired: boolean;
    effectiveOfficeKey: OfficeKey;
    amdOfficePhone: string;
  } | null;
  lastAvailabilityRaw: unknown | null;
  lastAvailabilityStatus: AvailabilityStatus;
  selectedSlot: SelectedSlot | null;
  bookedSlotsThisCall: string[];
  appointments: CallerAppointment[];
  appointmentsSource: "none" | "phone_lookup" | "confirm_appt";
  transferred: boolean;
}

export function createInitialCallState(args: {
  officeKey: OfficeKey;
  officePhone: string;
  amdOfficePhone: string;
  sipRoomName: string;
  sipParticipantIdentity: string;
  callerPhone: string;
  phoneLookup?: PhoneLookupResult;
}): CallState {
  const verified =
    args.phoneLookup?.status === "verified" ? args.phoneLookup : null;
  const multiple = args.phoneLookup?.status === "multiple_matches";
  const lookupError = args.phoneLookup?.status === "lookup_error";

  return {
    officeKey: args.officeKey,
    effectiveOfficeKey: args.officeKey,
    officePhone: args.officePhone,
    amdOfficePhone: args.amdOfficePhone,
    sipRoomName: args.sipRoomName,
    sipParticipantIdentity: args.sipParticipantIdentity,
    callerPhone: args.callerPhone,
    patientId: verified?.patientId ?? null,
    patientName: verified?.name ?? null,
    dob: verified?.dob ?? null,
    insuranceCarrier: verified?.insuranceCarrier ?? null,
    insPlanId: verified?.insPlanId ?? null,
    respPartyId: verified?.respPartyId ?? null,
    lookupMatchStatus: verified
      ? "single_match"
      : multiple
        ? "multiple_matches"
        : lookupError
          ? "lookup_error"
          : "none",
    originalLookupPatientId: verified?.patientId ?? null,
    callerConfirmedPatient: false,
    switchedPatientThisCall: false,
    checkedInsurancePlan: verified?.insuranceCarrier ?? null,
    routing: verified?.routing ?? null,
    allowedProviders: verified?.allowedProviders ?? [],
    routingAmbiguous: verified?.routingAmbiguous ?? false,
    preauthRequired: false,
    reasonForVisit: null,
    lastAvailabilityQuery: null,
    lastAvailabilityRaw: null,
    lastAvailabilityStatus: "not_checked",
    selectedSlot: null,
    bookedSlotsThisCall: [],
    appointments: verified?.appointments ?? [],
    appointmentsSource: verified?.appointments?.length
      ? "phone_lookup"
      : "none",
    transferred: false,
  };
}

// Per-call state lives on session.userData so concurrent calls don't collide
function getState(ctx: voice.RunContext): CallState {
  return ctx.session.userData as CallState;
}

export function getSpringHillOfficePhone(): string {
  return SPRING_HILL_OFFICE_PHONE;
}

export function getAmdOfficeForToolCall(
  state: Pick<CallState, "officeKey" | "amdOfficePhone"> &
    Partial<Pick<CallState, "effectiveOfficeKey">>,
): string {
  return (
    state.amdOfficePhone ||
    getOfficeConfig(state.effectiveOfficeKey ?? state.officeKey).amdOfficePhone
  );
}

function getEffectiveOfficeKey(
  state: Pick<CallState, "officeKey"> &
    Partial<Pick<CallState, "effectiveOfficeKey">>,
): OfficeKey {
  return state.effectiveOfficeKey ?? state.officeKey;
}

/** Apply patient data from an API response, resetting all patient fields so nothing stale lingers. */
function applyPatientResult(state: CallState, result: any): void {
  const previousPatientId = state.patientId;
  const nextPatientId = result.patientId ?? null;
  state.patientId = result.patientId ?? null;
  state.patientName = result.name ?? null;
  state.dob = result.dob ?? null;
  state.insuranceCarrier = result.insuranceCarrier ?? null;
  state.insPlanId = result.insPlanId ?? null;
  state.respPartyId = result.respPartyId ?? null;
  state.callerConfirmedPatient = true;
  state.switchedPatientThisCall =
    state.switchedPatientThisCall ||
    (!!previousPatientId &&
      !!nextPatientId &&
      previousPatientId !== nextPatientId);
  state.checkedInsurancePlan = result.insuranceCarrier ?? null;
  state.routing = result.routing ?? null;
  state.allowedProviders = result.allowedProviders ?? [];
  state.routingAmbiguous = result.routingAmbiguous ?? false;
  state.preauthRequired = result.preauthRequired ?? false;
  state.reasonForVisit = null;
  state.lastAvailabilityQuery = null;
  state.lastAvailabilityRaw = null;
  state.lastAvailabilityStatus = "not_checked";
  state.selectedSlot = null;
  state.appointments = extractAppointments(result);
  state.appointmentsSource =
    state.appointments.length > 0 ? "confirm_appt" : "none";
}

function extractAppointments(result: unknown): CallerAppointment[] {
  if (Array.isArray(result)) return result as CallerAppointment[];
  if (
    result &&
    typeof result === "object" &&
    Array.isArray((result as { appointments?: unknown[] }).appointments)
  ) {
    return (result as { appointments: CallerAppointment[] }).appointments;
  }
  return [];
}

function extractAvailabilitySlots(result: unknown): SelectedSlot[] | null {
  const rawSlots = Array.isArray(result)
    ? result
    : result &&
        typeof result === "object" &&
        Array.isArray((result as { slots?: unknown[] }).slots)
      ? (result as { slots: unknown[] }).slots
      : null;

  if (!rawSlots) return null;

  const slots = rawSlots
    .map((slot) => {
      if (!slot || typeof slot !== "object") return null;
      const record = slot as Record<string, unknown>;
      if (
        typeof record.startDatetime !== "string" ||
        typeof record.columnId !== "number" ||
        typeof record.profileId !== "number" ||
        typeof record.duration !== "number" ||
        typeof record.appointmentTypeId !== "number"
      ) {
        return null;
      }
      return {
        startDatetime: record.startDatetime,
        columnId: record.columnId,
        profileId: record.profileId,
        duration: record.duration,
        appointmentTypeId: record.appointmentTypeId,
      } satisfies SelectedSlot;
    })
    .filter((slot): slot is SelectedSlot => slot !== null);

  return slots;
}

function countAvailabilitySlots(result: unknown): number {
  return extractAvailabilitySlots(result)?.length ?? 0;
}

function buildAvailabilityToolResponse(date: string, result: unknown): unknown {
  const slots = extractAvailabilitySlots(result);
  if (slots === null) return result;

  if (slots.length === 0) {
    return {
      status: "none",
      date,
      message:
        "No availability was returned for this date. Do not check this same date again; offer a different date.",
      slots: [],
    };
  }

  return {
    status: "found",
    date,
    slotCount: slots.length,
    message:
      "Offer one slot at a time. Use the exact slot fields below if the caller accepts.",
    slots: slots.slice(0, 5),
  };
}

function isSelectedSlotFromLastAvailability(
  result: unknown,
  slot: SelectedSlot,
): boolean | null {
  const slots = extractAvailabilitySlots(result);
  if (slots === null) return null;
  return slots.some(
    (candidate) =>
      candidate.startDatetime === slot.startDatetime &&
      candidate.columnId === slot.columnId &&
      candidate.profileId === slot.profileId &&
      candidate.duration === slot.duration &&
      candidate.appointmentTypeId === slot.appointmentTypeId,
  );
}

function slotFingerprint(args: {
  patientId: string;
  startDatetime: string;
  columnId: number;
  appointmentTypeId: number;
}): string {
  return [
    args.patientId,
    args.startDatetime,
    args.columnId,
    args.appointmentTypeId,
  ].join(":");
}

function isSameAvailabilityQuery(
  state: CallState,
  query: CallState["lastAvailabilityQuery"],
): boolean {
  if (!state.lastAvailabilityQuery || !query) return false;
  return (
    state.lastAvailabilityQuery.date === query.date &&
    state.lastAvailabilityQuery.patientId === query.patientId &&
    state.lastAvailabilityQuery.reasonForVisit === query.reasonForVisit &&
    state.lastAvailabilityQuery.routing === query.routing &&
    state.lastAvailabilityQuery.preauthRequired === query.preauthRequired &&
    state.lastAvailabilityQuery.effectiveOfficeKey ===
      query.effectiveOfficeKey &&
    state.lastAvailabilityQuery.amdOfficePhone === query.amdOfficePhone
  );
}

function apiUnavailableMessage(action: string): string {
  return `ERROR: ${action} is temporarily unavailable. Apologize briefly, avoid guessing, and either retry once or offer to transfer if the caller needs this handled now.`;
}

function todayIsoInEastern(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) {
    throw new Error("Could not determine current Eastern date");
  }
  return `${year}-${month}-${day}`;
}

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isPastAppointment(appointment: CallerAppointment): boolean {
  return isIsoDate(appointment.date) && appointment.date < todayIsoInEastern();
}

function normalizeNamePart(value: string): string {
  return value.toLowerCase().replace(/[^a-z]/g, "");
}

function currentPatientNameMatches(
  state: CallState,
  firstName: string,
  lastName: string,
): boolean {
  if (!state.patientName) return false;
  const normalizedPatientName = normalizeNamePart(state.patientName);
  return (
    normalizedPatientName.includes(normalizeNamePart(firstName)) &&
    normalizedPatientName.includes(normalizeNamePart(lastName))
  );
}

function getResultStatus(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const status = (result as { status?: unknown }).status;
  return typeof status === "string" ? status.toLowerCase() : null;
}

function isSuccessfulApiResult(
  result: unknown,
  acceptedStatuses: string[],
): boolean {
  const status = getResultStatus(result);
  if (!status) return true;
  if (["error", "failed", "failure", "rejected"].includes(status)) {
    return false;
  }
  return ["ok", "success", ...acceptedStatuses].includes(status);
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
    return {
      status: "lookup_error",
      message:
        "Phone lookup is temporarily unavailable. Verify the caller normally; do not treat this as a confirmed no-match.",
    };
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
    try {
      const result = (await callApi(
        "/api/verify-patient",
        body,
        getAmdOfficeForToolCall(getState(ctx)),
      )) as any;
      if (result?.patientId) {
        applyPatientResult(getState(ctx), result);
      }
      return result;
    } catch {
      return apiUnavailableMessage("Patient verification");
    }
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
    if (
      state.patientId &&
      currentPatientNameMatches(state, params.firstName, params.lastName)
    ) {
      return "ERROR: A patient is already verified for this call. Do not create a duplicate patient record; continue with the verified patient or run verify_patient if the caller is scheduling for someone else.";
    }
    if (!state.checkedInsurancePlan) {
      return "ERROR: Run check_insurance first and use the canonical accepted plan before creating a patient.";
    }
    const insurance = state.checkedInsurancePlan ?? params.insurance;
    const phone = params.phone ?? state.callerPhone;
    if (!phone) {
      return "ERROR: No phone number is available. Ask whether the number they're calling from is good; if not, collect the best phone number.";
    }
    try {
      const result = (await callApi(
        "/api/add-patient",
        { ...params, insurance, phone },
        getAmdOfficeForToolCall(state),
      )) as any;
      if (result?.patientId) {
        applyPatientResult(state, result);
      }
      return result;
    } catch {
      return apiUnavailableMessage("Patient registration");
    }
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
    try {
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
        state.checkedInsurancePlan =
          result.newInsurance ?? insuranceForMiddleware;
        state.insPlanId = result.insPlanId ?? null;
        state.respPartyId = result.respPartyId ?? null;
        state.routing = result.routing ?? state.routing;
        state.allowedProviders =
          result.allowedProviders ?? state.allowedProviders;
        state.routingAmbiguous = result.routingAmbiguous ?? false;
        state.preauthRequired = result.preauthRequired ?? false;
        state.lastAvailabilityQuery = null;
        state.lastAvailabilityRaw = null;
        state.lastAvailabilityStatus = "not_checked";
        state.selectedSlot = null;
      }
      return result;
    } catch {
      return apiUnavailableMessage("Insurance update");
    }
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
    reasonForVisit: z
      .string()
      .optional()
      .describe(
        "The caller's reason for the visit, e.g. follow-up, cataract evaluation, eye irritation, or post-op",
      ),
  }),
  execute: async ({ date, reasonForVisit }, { ctx }) => {
    const state = getState(ctx);
    if (!state.patientId) {
      return "ERROR: No patient verified yet. Verify the patient before checking availability.";
    }
    if (!isIsoDate(date)) {
      return "ERROR: Date must be formatted YYYY-MM-DD.";
    }
    if (date <= todayIsoInEastern()) {
      return "ERROR: Same-day or past appointments cannot be scheduled. Offer the earliest available date starting tomorrow.";
    }
    const visitReason = reasonForVisit?.trim() || state.reasonForVisit;
    if (!visitReason) {
      return "ERROR: Ask the caller the reason for the visit before checking availability.";
    }
    const effectiveOfficeKey = getEffectiveOfficeKey(state);
    const amdOfficePhone = getAmdOfficeForToolCall(state);
    const query: CallState["lastAvailabilityQuery"] = {
      date,
      patientId: state.patientId,
      reasonForVisit: visitReason,
      routing: state.routing,
      preauthRequired: state.preauthRequired,
      effectiveOfficeKey,
      amdOfficePhone,
    };
    if (isSameAvailabilityQuery(state, query)) {
      return `ERROR: Availability for ${date} was already checked for this patient, reason, routing, and office. Use the loaded result instead of calling this tool again, or ask for a different date.`;
    }
    const body: Record<string, unknown> = { date };
    if (state.routing) body.routing = state.routing;
    if (state.preauthRequired) body.preauthRequired = true;
    try {
      const result = await callApi(
        "/api/scheduler/availability",
        body,
        amdOfficePhone,
      );
      state.reasonForVisit = visitReason;
      state.lastAvailabilityQuery = query;
      state.lastAvailabilityRaw = result;
      state.lastAvailabilityStatus =
        extractAvailabilitySlots(result) === null ||
        countAvailabilitySlots(result) > 0
          ? "found"
          : "none";
      state.selectedSlot = null;
      return buildAvailabilityToolResponse(date, result);
    } catch {
      state.lastAvailabilityQuery = query;
      state.lastAvailabilityRaw = null;
      state.lastAvailabilityStatus = "error";
      state.selectedSlot = null;
      return apiUnavailableMessage("Availability lookup");
    }
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
    try {
      const result = await callApi(
        "/api/patient/appointments",
        { patientId: state.patientId },
        getAmdOfficeForToolCall(state),
      );
      state.appointments = extractAppointments(result);
      state.appointmentsSource = "confirm_appt";
      return result;
    } catch {
      return apiUnavailableMessage("Appointment lookup");
    }
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
    const state = getState(ctx);
    if (!state.patientId) {
      return "ERROR: No patient verified yet. Verify the patient before cancelling an appointment.";
    }
    const loadedAppointment = state.appointments.find(
      (appointment) => appointment.id === appointmentId,
    );
    if (!loadedAppointment) {
      return "ERROR: That appointment ID is not loaded for this call. Use an appointment ID from caller context or run confirm_appt first.";
    }
    if (isPastAppointment(loadedAppointment)) {
      return "ERROR: That appointment is in the past and cannot be cancelled. Only cancel an upcoming appointment.";
    }
    try {
      const result = await callApi(
        "/api/appointment/cancel",
        { appointmentId },
        getAmdOfficeForToolCall(state),
      );
      if (!isSuccessfulApiResult(result, ["cancelled", "canceled"])) {
        return result;
      }
      state.appointments = state.appointments.filter(
        (appointment) => appointment.id !== appointmentId,
      );
      return result;
    } catch {
      return apiUnavailableMessage("Appointment cancellation");
    }
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
      return "ERROR: No patient verified yet. Verify the patient first.";
    if (!state.lastAvailabilityRaw) {
      return "ERROR: No availability results are loaded. Run get_availability and offer a returned slot before booking.";
    }
    const selectedSlot: SelectedSlot = {
      startDatetime: params.startDatetime,
      columnId: params.columnId,
      profileId: params.profileId,
      duration: params.duration,
      appointmentTypeId: params.appointmentTypeId,
    };
    const selectedFromLastAvailability = isSelectedSlotFromLastAvailability(
      state.lastAvailabilityRaw,
      selectedSlot,
    );
    if (selectedFromLastAvailability === false) {
      return "ERROR: That slot was not in the latest availability results. Offer one of the loaded slots or check another date.";
    }
    const fingerprint = slotFingerprint({
      patientId: state.patientId,
      startDatetime: params.startDatetime,
      columnId: params.columnId,
      appointmentTypeId: params.appointmentTypeId,
    });
    if (state.bookedSlotsThisCall.includes(fingerprint)) {
      return "ERROR: This exact slot was already booked during this call. Do not call book_appt again for it.";
    }
    try {
      const result = await callApi(
        "/api/appointment/book",
        { ...params, patientId: state.patientId },
        getAmdOfficeForToolCall(state),
      );
      if (!isSuccessfulApiResult(result, ["booked"])) {
        return result;
      }
      state.selectedSlot = selectedSlot;
      state.bookedSlotsThisCall.push(fingerprint);
      return result;
    } catch {
      return apiUnavailableMessage("Appointment booking");
    }
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
    state.effectiveOfficeKey = "spring-hill";
    state.amdOfficePhone = springHillOffice;
    state.lastAvailabilityQuery = null;
    state.lastAvailabilityRaw = null;
    state.lastAvailabilityStatus = "not_checked";
    state.selectedSlot = null;
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
    const result = matchInsurancePlanForOffice(
      getEffectiveOfficeKey(state),
      plan,
    );
    state.checkedInsurancePlan = canonicalInsurancePlan(result);
    return buildInsuranceToolResponse(result);
  },
});

// --- lookup_knowledge ---
export const lookup_knowledge = llm.tool({
  description: `Returns practice facts: address, hours, location, providers, services, what to bring, phone, fax, and appointment expectations.

You MUST call this tool before answering any of those questions, including mid-flow.

Answer naturally from the returned info — just the part that answers their question.`,
  parameters: z.object({
    question: z
      .string()
      .describe(
        "What the caller is asking about (e.g. 'office hours', 'do you see kids', 'what should I bring')",
      ),
  }),
  execute: async (_args, { ctx }) => {
    const file = resolveKnowledgeFileForOffice(
      getEffectiveOfficeKey(getState(ctx)),
    );
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
      const transferNumber = getOfficeConfig(
        getEffectiveOfficeKey(state),
      ).transferNumber;
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
