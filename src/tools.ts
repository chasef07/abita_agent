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

export type WorkingSummaryMode =
  | "router"
  | "identify"
  | "register"
  | "schedule"
  | "reschedule"
  | "confirm"
  | "cancel";

export interface CallState {
  officeKey: OfficeKey;
  effectiveOfficeKey: OfficeKey;
  officePhone: string;
  amdOfficePhone: string;
  sipRoomName: string;
  sipParticipantIdentity: string;
  callerPhone: string;
  identity: {
    lookupMatchStatus: "none" | "single_match" | "multiple_matches";
    patientId: string | null;
    patientName: string | null;
    dob: string | null;
    insuranceCarrier: string | null;
    insPlanId: string | null;
    respPartyId: string | null;
    originalLookupPatientId: string | null;
    callerConfirmedPatient: boolean;
    activePatientMatchesLookup: boolean;
    activePatientSource:
      | "phone_lookup"
      | "verify_patient"
      | "add_patient"
      | null;
    switchedPatientThisCall: boolean;
  };
  workflow: {
    intent:
      | "unknown"
      | "faq"
      | "schedule"
      | "confirm"
      | "cancel"
      | "reschedule"
      | "transfer";
    activeFlow:
      | "none"
      | "identify"
      | "existing_appointment"
      | "register"
      | "visit_reason"
      | "availability"
      | "booking"
      | "cancel";
    appointmentIntent: "schedule" | "confirm" | "cancel" | "reschedule" | null;
    verificationStatus:
      | "not_started"
      | "single_match"
      | "multiple_matches"
      | "verified"
      | "no_match";
    verificationAttempts: number;
    registrationAllowed: boolean;
    registrationComplete: boolean;
  };
  scheduling: {
    reasonForVisit: string | null;
    lastAvailabilityQuery: {
      date: string;
      patientId: string | null;
      reasonForVisit: string | null;
      routing: string | null;
    } | null;
    lastAvailabilitySummary: string | null;
    lastAvailabilityRaw: unknown | null;
    selectedSlot: {
      startDatetime: string;
      columnId: number;
      profileId: number;
      duration: number;
      appointmentTypeId: number;
    } | null;
    bookedSlotsThisCall: string[];
    targetAppointmentId: number | null;
    appointments: CallerAppointment[];
    appointmentsLoadedAt: string | null;
    appointmentsSource: "none" | "phone_lookup" | "confirm_appt";
  };
  insurance: {
    checkedInsurancePlan: string | null;
    routing: string | null;
    allowedProviders: string[];
    routingAmbiguous: boolean;
    preauthRequired: boolean;
  };
  conversation: {
    transferred: boolean;
  };
}

// Per-call state lives on session.userData so concurrent calls don't collide
function getState(ctx: voice.RunContext): CallState {
  return ctx.session.userData as CallState;
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

  return {
    officeKey: args.officeKey,
    effectiveOfficeKey: args.officeKey,
    officePhone: args.officePhone,
    amdOfficePhone: args.amdOfficePhone,
    sipRoomName: args.sipRoomName,
    sipParticipantIdentity: args.sipParticipantIdentity,
    callerPhone: args.callerPhone,
    identity: {
      lookupMatchStatus: verified
        ? "single_match"
        : multiple
          ? "multiple_matches"
          : "none",
      patientId: verified?.patientId ?? null,
      patientName: verified?.name ?? null,
      dob: verified?.dob ?? null,
      insuranceCarrier: verified?.insuranceCarrier ?? null,
      insPlanId: verified?.insPlanId ?? null,
      respPartyId: verified?.respPartyId ?? null,
      originalLookupPatientId: verified?.patientId ?? null,
      callerConfirmedPatient: false,
      activePatientMatchesLookup: !!verified,
      activePatientSource: verified ? "phone_lookup" : null,
      switchedPatientThisCall: false,
    },
    workflow: {
      intent: "unknown",
      activeFlow: "none",
      appointmentIntent: null,
      verificationStatus: verified
        ? "single_match"
        : multiple
          ? "multiple_matches"
          : "not_started",
      verificationAttempts: 0,
      registrationAllowed: false,
      registrationComplete: false,
    },
    scheduling: {
      reasonForVisit: null,
      lastAvailabilityQuery: null,
      lastAvailabilitySummary: null,
      lastAvailabilityRaw: null,
      selectedSlot: null,
      bookedSlotsThisCall: [],
      targetAppointmentId: null,
      appointments: verified?.appointments ?? [],
      appointmentsLoadedAt: verified?.appointments?.length
        ? new Date().toISOString()
        : null,
      appointmentsSource: verified?.appointments?.length
        ? "phone_lookup"
        : "none",
    },
    insurance: {
      checkedInsurancePlan: verified?.insuranceCarrier ?? null,
      routing: verified?.routing ?? null,
      allowedProviders: verified?.allowedProviders ?? [],
      routingAmbiguous: verified?.routingAmbiguous ?? false,
      preauthRequired: false,
    },
    conversation: {
      transferred: false,
    },
  };
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

export function getEffectiveOfficeKey(
  state: Pick<CallState, "officeKey"> &
    Partial<Pick<CallState, "effectiveOfficeKey">>,
): OfficeKey {
  return state.effectiveOfficeKey ?? state.officeKey;
}

export function shouldExposeRouteToSpringHill(
  state: Pick<CallState, "officeKey" | "effectiveOfficeKey" | "workflow">,
): boolean {
  return (
    getOfficeConfig(state.officeKey).features.routeToSpringHill &&
    state.effectiveOfficeKey !== "spring-hill" &&
    (state.workflow.intent === "unknown" ||
      state.workflow.intent === "schedule" ||
      state.workflow.intent === "reschedule")
  );
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

function buildAvailabilitySummary(date: string, result: unknown): string {
  const slots = Array.isArray(result)
    ? result
    : result &&
        typeof result === "object" &&
        Array.isArray((result as { slots?: unknown[] }).slots)
      ? (result as { slots: unknown[] }).slots
      : [];
  if (slots.length === 0) {
    return `No openings returned for ${date}.`;
  }
  return `Found ${slots.length} opening${slots.length === 1 ? "" : "s"} for ${date}.`;
}

type SelectedSlot = NonNullable<CallState["scheduling"]["selectedSlot"]>;

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

export function slotFingerprint(args: {
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
  query: CallState["scheduling"]["lastAvailabilityQuery"],
): boolean {
  if (!state.scheduling.lastAvailabilityQuery || !query) return false;
  return (
    state.scheduling.lastAvailabilityQuery.date === query.date &&
    state.scheduling.lastAvailabilityQuery.patientId === query.patientId &&
    state.scheduling.lastAvailabilityQuery.reasonForVisit ===
      query.reasonForVisit &&
    state.scheduling.lastAvailabilityQuery.routing === query.routing
  );
}

function looksLikePlaceholderRegistration(params: {
  email: string;
  street: string;
}): boolean {
  const email = params.email.trim().toLowerCase();
  const street = params.street.trim().toLowerCase();
  return email.endsWith("@example.com") || street.startsWith("123 main");
}

function parseAppointmentStart(appt: CallerAppointment): Date | null {
  const parsed = new Date(`${appt.date} ${appt.time}`);
  if (isNaN(parsed.getTime())) return null;
  return parsed;
}

function hasOverlappingAppointment(
  appointments: CallerAppointment[],
  startDatetime: string,
  durationMin: number,
): boolean {
  const start = new Date(startDatetime);
  if (isNaN(start.getTime())) return false;
  const end = new Date(start.getTime() + durationMin * 60_000);
  return appointments.some((appt) => {
    const apptStart = parseAppointmentStart(appt);
    if (!apptStart) return false;
    const apptEnd = new Date(apptStart.getTime() + durationMin * 60_000);
    return start < apptEnd && apptStart < end;
  });
}

export function buildWorkingStateSummary(
  state: CallState,
  mode: WorkingSummaryMode,
): string {
  const lines: string[] = [];
  const inboundOffice = getOfficeConfig(state.officeKey);
  const effectiveOffice = getOfficeConfig(getEffectiveOfficeKey(state));
  lines.push(`Current call state:`);
  lines.push(`- mode: ${mode}`);
  lines.push(`- office: ${effectiveOffice.displayName}`);
  if (effectiveOffice.key !== inboundOffice.key) {
    lines.push(`- inbound office: ${inboundOffice.displayName}`);
  }
  if (state.identity.patientName) {
    lines.push(`- patient: ${state.identity.patientName}`);
  } else {
    lines.push(`- patient: not yet identified`);
  }
  lines.push(`- lookup match: ${state.identity.lookupMatchStatus}`);
  lines.push(
    `- caller confirmed patient: ${state.identity.callerConfirmedPatient ? "yes" : "no"}`,
  );
  lines.push(
    `- active patient matches lookup: ${state.identity.activePatientMatchesLookup ? "yes" : "no"}`,
  );
  lines.push(`- intent: ${state.workflow.intent}`);
  lines.push(`- active flow: ${state.workflow.activeFlow}`);
  lines.push(`- verification status: ${state.workflow.verificationStatus}`);
  if (state.scheduling.reasonForVisit) {
    lines.push(`- visit reason: ${state.scheduling.reasonForVisit}`);
  }
  if (state.scheduling.lastAvailabilitySummary) {
    lines.push(
      `- last availability: ${state.scheduling.lastAvailabilitySummary}`,
    );
  }
  if (state.scheduling.appointmentsSource !== "none") {
    lines.push(`- appointments source: ${state.scheduling.appointmentsSource}`);
  }
  if (state.scheduling.appointmentsLoadedAt) {
    lines.push(
      `- appointments loaded at: ${state.scheduling.appointmentsLoadedAt}`,
    );
  }
  if (mode === "confirm" || mode === "cancel") {
    lines.push(
      `- target appointment selected: ${state.scheduling.targetAppointmentId ? "yes" : "no"}`,
    );
  }
  if (state.workflow.registrationAllowed) {
    lines.push(`- registration is currently allowed`);
  }
  return lines.join("\n");
}

export function buildTurnStateSummary(state: CallState): string | null {
  if (state.workflow.activeFlow === "none") {
    return null;
  }

  const lines: string[] = [];
  lines.push(`Current workflow state:`);
  lines.push(`- intent: ${state.workflow.intent}`);
  lines.push(`- active step: ${state.workflow.activeFlow}`);
  if (state.effectiveOfficeKey !== state.officeKey) {
    lines.push(
      `- routed office: ${getOfficeConfig(state.effectiveOfficeKey).displayName}`,
    );
  }
  lines.push(
    `- patient: ${state.identity.patientName ?? "not yet identified"}`,
  );

  if (state.workflow.registrationAllowed) {
    lines.push(`- registration is allowed`);
  }
  if (state.scheduling.reasonForVisit) {
    lines.push(`- visit reason: ${state.scheduling.reasonForVisit}`);
  }
  if (
    (state.workflow.activeFlow === "availability" ||
      state.workflow.activeFlow === "booking") &&
    state.scheduling.lastAvailabilitySummary
  ) {
    lines.push(
      `- last availability: ${state.scheduling.lastAvailabilitySummary}`,
    );
  }
  if (
    state.workflow.activeFlow === "booking" &&
    state.scheduling.selectedSlot
  ) {
    lines.push(
      `- selected slot: ${state.scheduling.selectedSlot.startDatetime}`,
    );
  }
  if (
    (state.workflow.intent === "confirm" ||
      state.workflow.intent === "cancel" ||
      state.workflow.intent === "reschedule") &&
    state.scheduling.targetAppointmentId
  ) {
    lines.push(`- target appointment selected: yes`);
  }

  const nextFocusByFlow: Record<CallState["workflow"]["activeFlow"], string> = {
    none: "",
    identify: "identify the correct patient before continuing",
    existing_appointment:
      "select the correct existing appointment before continuing",
    register: "complete registration before scheduling continues",
    visit_reason: "capture the visit reason before availability",
    availability: "search one date at a time or record the chosen slot",
    booking: "confirm and book the selected slot already in state",
    cancel: "confirm and cancel the selected appointment",
  };

  const nextFocus = nextFocusByFlow[state.workflow.activeFlow];
  if (nextFocus) {
    lines.push(`- next focus: ${nextFocus}`);
  }

  return lines.join("\n");
}

/** Apply patient data from an API response, resetting all patient fields so nothing stale lingers. */
function applyPatientResult(
  state: CallState,
  result: any,
  source: "verify_patient" | "add_patient",
): void {
  const previousPatientId = state.identity.patientId;
  const nextPatientId = result.patientId ?? null;
  const originalLookupPatientId = state.identity.originalLookupPatientId;
  state.identity.patientId = nextPatientId;
  state.identity.patientName = result.name ?? null;
  state.identity.dob = result.dob ?? null;
  state.identity.insuranceCarrier = result.insuranceCarrier ?? null;
  state.identity.insPlanId = result.insPlanId ?? null;
  state.identity.respPartyId = result.respPartyId ?? null;
  state.identity.callerConfirmedPatient = true;
  state.identity.activePatientMatchesLookup =
    !!originalLookupPatientId && originalLookupPatientId === nextPatientId;
  state.identity.activePatientSource = source;
  if (
    previousPatientId &&
    nextPatientId &&
    previousPatientId !== nextPatientId
  ) {
    state.identity.switchedPatientThisCall = true;
  }

  state.insurance.checkedInsurancePlan = result.insuranceCarrier ?? null;
  state.insurance.routing = result.routing ?? null;
  state.insurance.allowedProviders = result.allowedProviders ?? [];
  state.insurance.routingAmbiguous = result.routingAmbiguous ?? false;
  state.insurance.preauthRequired = result.preauthRequired ?? false;

  state.scheduling.reasonForVisit = null;
  state.scheduling.lastAvailabilityQuery = null;
  state.scheduling.lastAvailabilitySummary = null;
  state.scheduling.lastAvailabilityRaw = null;
  state.scheduling.selectedSlot = null;
  state.scheduling.targetAppointmentId = null;
  state.scheduling.appointments = extractAppointments(result);
  state.scheduling.appointmentsLoadedAt = state.scheduling.appointments.length
    ? new Date().toISOString()
    : null;
  state.scheduling.appointmentsSource = "none";
}

/** Clear the active patient context before switching into true new-patient registration. */
export function clearActivePatientContext(state: CallState): void {
  const hadResolvedPatient =
    !!state.identity.patientId ||
    !!state.identity.patientName ||
    state.identity.activePatientSource !== null;

  state.identity.patientId = null;
  state.identity.patientName = null;
  state.identity.dob = null;
  state.identity.insuranceCarrier = null;
  state.identity.insPlanId = null;
  state.identity.respPartyId = null;
  state.identity.callerConfirmedPatient = false;
  state.identity.activePatientMatchesLookup = false;
  state.identity.activePatientSource = null;
  state.identity.switchedPatientThisCall =
    state.identity.switchedPatientThisCall || hadResolvedPatient;

  state.scheduling.reasonForVisit = null;
  state.scheduling.lastAvailabilityQuery = null;
  state.scheduling.lastAvailabilitySummary = null;
  state.scheduling.lastAvailabilityRaw = null;
  state.scheduling.selectedSlot = null;
  state.scheduling.targetAppointmentId = null;
  state.scheduling.appointments = [];
  state.scheduling.appointmentsLoadedAt = null;
  state.scheduling.appointmentsSource = "none";

  state.insurance.checkedInsurancePlan = null;
  state.insurance.routing = null;
  state.insurance.allowedProviders = [];
  state.insurance.routingAmbiguous = false;
  state.insurance.preauthRequired = false;
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
    const state = getState(ctx);
    const body: Record<string, unknown> = { firstName };
    if (lastName) body.lastName = lastName;
    if (dob) body.dob = dob;
    if (usePhone) body.phone = state.callerPhone;
    const result = (await callApi(
      "/api/verify-patient",
      body,
      getAmdOfficeForToolCall(state),
    )) as any;
    if (result?.patientId) {
      applyPatientResult(state, result, "verify_patient");
      state.workflow.verificationStatus = "verified";
      state.workflow.verificationAttempts = 0;
      state.workflow.registrationAllowed = false;
      state.workflow.registrationComplete = false;
    } else {
      state.workflow.verificationAttempts += 1;
      state.workflow.verificationStatus = usePhone
        ? "multiple_matches"
        : "no_match";
      const reachedRegistrationFallback =
        !usePhone && state.workflow.verificationAttempts >= 2;
      state.workflow.registrationAllowed =
        state.workflow.registrationAllowed || reachedRegistrationFallback;
      state.workflow.registrationComplete = false;
    }
    return result;
  },
});

// --- add_patient ---
export const add_patient = llm.tool({
  description: `Creates a new patient record. Use this when the caller is clearly a true new patient, or after identity verification failed and registration is now allowed. Every field must come from what the caller explicitly said — never fabricate or guess values.

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
    if (state.identity.patientId && !state.identity.switchedPatientThisCall) {
      return "ERROR: A patient is already identified in this call. Do not register another patient unless the caller clearly switched to a different person.";
    }
    if (!state.workflow.registrationAllowed) {
      return "ERROR: New-patient registration is not allowed yet. Verify the patient first, or confirm they are a true new patient.";
    }
    if (!state.insurance.checkedInsurancePlan) {
      return "ERROR: Insurance has not been confirmed. Run check_insurance before calling add_patient.";
    }
    if (looksLikePlaceholderRegistration(params)) {
      return "ERROR: Registration data looks like placeholder information. Collect the real values from the caller first.";
    }
    const insurance = state.insurance.checkedInsurancePlan ?? params.insurance;
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
      applyPatientResult(state, result, "add_patient");
      state.workflow.registrationAllowed = false;
      state.workflow.registrationComplete = true;
      state.workflow.verificationStatus = "verified";
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
    if (!state.identity.patientId) return "ERROR: No patient verified yet.";
    const insuranceForMiddleware =
      state.insurance.checkedInsurancePlan ?? insurance;
    const result = (await callApi(
      "/api/patient/update-insurance",
      {
        patientId: state.identity.patientId,
        insPlanId: state.identity.insPlanId ?? "",
        respPartyId: state.identity.respPartyId ?? "",
        oldInsurance: state.identity.insuranceCarrier ?? "",
        insurance: insuranceForMiddleware,
        subscriberName,
        subscriberNum,
      },
      getAmdOfficeForToolCall(state),
    )) as any;
    if (result?.status === "updated") {
      state.identity.insuranceCarrier =
        result.newInsurance ?? state.identity.insuranceCarrier;
      state.identity.insPlanId = result.insPlanId ?? null;
      state.identity.respPartyId = result.respPartyId ?? null;
      state.insurance.routing = result.routing ?? state.insurance.routing;
      state.insurance.allowedProviders =
        result.allowedProviders ?? state.insurance.allowedProviders;
      state.insurance.routingAmbiguous = result.routingAmbiguous ?? false;
      state.insurance.preauthRequired = result.preauthRequired ?? false;
    }
    return result;
  },
});

// --- get_availability ---
export const get_availability = llm.tool({
  description: `Gets schedule availability. Requires date (YYYY-MM-DD). Routing and preauth auto-applied from session state.

Ask the caller the reason for their visit before calling this tool. The workflow uses that reason to determine the correct scheduling path before availability is checked.

Rules: no same-day appointments — earliest is tomorrow. If the caller asks for today, just let them know the earliest you can schedule is tomorrow and offer that. Don't make up a policy — just move to the next available day. Under 18 = Dr. Bach only. Bach has limited schedule — set expectations. If routing is "not_accepted", do not call. "ASAP" or "whenever" = search tomorrow.

After response: check if date shifted vs requested — tell caller if different. Suggest one best-fit slot (date + time). Mention the doctor only if asked or clinically relevant. If rejected, offer one alternative. Scan existing results before calling again. If no slots are returned, tell the caller that date has no openings and offer the nearest available date.`,
  parameters: z.object({
    date: z.string().describe("Start date to search, formatted YYYY-MM-DD"),
  }),
  execute: async ({ date }, { ctx }) => {
    const state = getState(ctx);
    if (!state.identity.patientId) {
      return "ERROR: No patient identified yet. Verify or register the patient before checking availability.";
    }
    if (!state.scheduling.reasonForVisit) {
      return "ERROR: The reason for the visit is required before checking availability. Ask the caller why they need to be seen first.";
    }
    const query = {
      date,
      patientId: state.identity.patientId,
      reasonForVisit: state.scheduling.reasonForVisit,
      routing: state.insurance.routing,
    };
    if (isSameAvailabilityQuery(state, query)) {
      return `ERROR: Availability for ${date} was already checked. Reuse that result or ask for a different day.`;
    }
    const body: Record<string, unknown> = { date };
    if (state.insurance.routing) body.routing = state.insurance.routing;
    if (state.insurance.preauthRequired) body.preauthRequired = true;
    const result = await callApi(
      "/api/scheduler/availability",
      body,
      getAmdOfficeForToolCall(state),
    );
    state.scheduling.lastAvailabilityQuery = query;
    state.scheduling.lastAvailabilityRaw = result;
    state.scheduling.lastAvailabilitySummary = buildAvailabilitySummary(
      date,
      result,
    );
    return result;
  },
});

// --- confirm_appt ---
export const confirm_appt = llm.tool({
  description: `Retrieves upcoming appointments (next 60 days) for a verified patient. Patient ID is read from session state automatically. Requires a verified patient — either from phone lookup or verify_patient.

Use this tool when the workflow needs current appointment data in session state, especially after switching patients or when the task explicitly refreshes appointments from phone lookup data.

Read back the nearest appointment: date, time, doctor, and location. If multiple, read one at a time. If none found, offer to schedule.`,
  parameters: z.object({}),
  execute: async (_, { ctx }) => {
    const state = getState(ctx);
    if (!state.identity.patientId)
      return "ERROR: No patient verified yet. Run verify_patient first with the caller's firstName, lastName, and dob.";
    const result = await callApi(
      "/api/patient/appointments",
      { patientId: state.identity.patientId },
      getAmdOfficeForToolCall(state),
    );
    state.scheduling.appointments = extractAppointments(result);
    state.scheduling.appointmentsLoadedAt = state.scheduling.appointments.length
      ? new Date().toISOString()
      : null;
    state.scheduling.appointmentsSource = "confirm_appt";
    return result;
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
    const knownAppointment =
      state.scheduling.targetAppointmentId === appointmentId ||
      state.scheduling.appointments.some((appt) => appt.id === appointmentId);
    if (!knownAppointment) {
      return "ERROR: That appointment is not currently loaded in session state. Confirm the appointment first before cancelling it.";
    }
    const result = await callApi(
      "/api/appointment/cancel",
      { appointmentId },
      getAmdOfficeForToolCall(state),
    );
    state.scheduling.appointments = state.scheduling.appointments.filter(
      (appt) => appt.id !== appointmentId,
    );
    if (state.scheduling.targetAppointmentId === appointmentId) {
      state.scheduling.targetAppointmentId = null;
    }
    return result;
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
    if (!state.identity.patientId)
      return "No patient verified yet. Verify the patient first.";
    const fingerprint = slotFingerprint({
      patientId: state.identity.patientId,
      startDatetime: params.startDatetime,
      columnId: params.columnId,
      appointmentTypeId: params.appointmentTypeId,
    });
    if (state.scheduling.bookedSlotsThisCall.includes(fingerprint)) {
      return "ERROR: That slot was already booked in this call.";
    }
    if (state.scheduling.lastAvailabilityRaw) {
      const slotValidity = isSelectedSlotFromLastAvailability(
        state.scheduling.lastAvailabilityRaw,
        {
          startDatetime: params.startDatetime,
          columnId: params.columnId,
          profileId: params.profileId,
          duration: params.duration,
          appointmentTypeId: params.appointmentTypeId,
        },
      );
      if (slotValidity === false) {
        return "ERROR: That slot is not in the most recent availability results. Search availability again or choose a returned slot.";
      }
    }
    if (
      hasOverlappingAppointment(
        state.scheduling.appointments,
        params.startDatetime,
        params.duration,
      ) &&
      state.workflow.appointmentIntent !== "reschedule"
    ) {
      return "ERROR: This patient already has an appointment at that time. Confirm whether they want to reschedule before booking another.";
    }
    const result = await callApi(
      "/api/appointment/book",
      { ...params, patientId: state.identity.patientId },
      getAmdOfficeForToolCall(state),
    );
    state.scheduling.bookedSlotsThisCall.push(fingerprint);
    state.scheduling.selectedSlot = {
      startDatetime: params.startDatetime,
      columnId: params.columnId,
      profileId: params.profileId,
      duration: params.duration,
      appointmentTypeId: params.appointmentTypeId,
    };
    return result;
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
    state.insurance.checkedInsurancePlan = canonicalInsurancePlan(result);
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
    if (state.conversation.transferred) {
      return "Already transferred. No action needed.";
    }
    if (ctx.speechHandle) ctx.speechHandle.allowInterruptions = false;
    // Wait for the transfer announcement to finish playing before initiating
    await ctx.waitForPlayout();
    if (!state.sipRoomName || !state.sipParticipantIdentity) {
      return "Could not transfer — no active SIP session.";
    }
    try {
      state.conversation.transferred = true;
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
