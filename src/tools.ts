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
  getOfficeHandoffTarget,
  SPRING_HILL_OFFICE_PHONE,
} from "./offices.js";
import {
  buildInsuranceToolResponse,
  canonicalInsurancePlan,
  normalizeCoverageType,
  matchInsurancePlanForOffice,
  type InsuranceToolResponse,
  type InsuranceCoverageType,
} from "./insurance-rules.js";
import {
  evaluateFlowToolPolicy,
  advanceFlowForTurn,
  compileTurnStatePacket,
  createPendingBookingAction,
  createPendingSideEffectAction,
  completeCurrentTaskAndResume,
  consumePendingSideEffectAction,
  hashToolArgs,
  invalidateAvailabilitySearches,
  invalidatePendingActionsForStateChange,
  nextPatientFlowStep,
  nextStepForSideEffectAction,
  normalizeSchedulingRouting,
  recordAvailabilityCachedSlots,
  recordAvailabilitySearch,
  recordBookingAttempt,
  recordBookingResult,
  ensureActivePatientContext,
  hasActivePatientIdentityChanged,
  recordPatientVerificationAttempt,
  recordVerifiedPatient,
  snapshotActivePatientIdentity,
  sideEffectActionTypeForTool,
  startPatientTask,
  updateActivePatientInsurance,
  type AvailabilityInvalidationReason,
  type CallFlowState,
  type CallerAppointment,
  type GuardObservation,
  type GuardedToolName,
  type SideEffectToolName,
  type ToolOutcome,
  turnUnderstandingSchema,
} from "./flow/index.js";

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

export const appointmentTypeIdSchema = z
  .union([
    z.literal(1006),
    z.literal(1004),
    z.literal(1007),
    z.literal(1005),
    z.literal(1008),
    z.literal(1010),
    z.literal(3364),
    z.literal(4244),
    z.literal(4245),
    z.literal(6167),
    z.literal(6169),
    z.literal(6168),
  ])
  .describe(
    "Allowed AMD appointment type ID. Spring Hill medical: 1006 new adult, 1004 new pediatric, 1007 established adult follow-up, 1005 established pediatric follow-up, 1008 post-op. Routine vision: 1010 new adult, 3364 established adult, 4244 new pediatric, 4245 established pediatric. Crystal River: 6167 new, 6169 established, 6168 post-op. Availability does not return appointmentTypeId.",
  );

const addPatientParameters = z.object({
  firstName: z.string().describe("Patient's first name"),
  lastName: z.string().describe("Patient's last name"),
  dob: z.string().describe("Date of birth in MM/DD/YYYY format"),
  phone: z
    .string()
    .optional()
    .describe(
      "Cell phone number, 10 digits only. Omit if the caller confirms the number they're calling from is the best number on file",
    ),
  email: z.string().optional().describe("Email address, if the caller has one"),
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
});

const updateInsuranceParameters = z.object({
  insurance: z.string().describe("New insurance plan name"),
  subscriberName: z.string().describe("Name on the insurance card"),
  subscriberNum: z.string().describe("Member/subscriber ID from the card"),
});

// --- Session-scoped call state ---

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

export interface StoredAvailabilitySlot {
  slotId: string;
  spoken: string;
  provider: string;
  date: string;
  time: string;
  datetime: string;
  bookingToken?: string;
  columnId?: number;
  profileId?: number;
  duration?: number;
  routing: string | null;
}

export interface CallState {
  flow: CallFlowState;
  flowHarnessEnabled?: boolean;
  flowGuardObservations: GuardObservation[];
  latestUserTranscript?: string | null;
  turnUnderstandingAppliedForTranscript?: string | null;
  lastTurnUnderstanding?: {
    goal: string;
    appointmentAction?: string | null;
    confidence: number;
    activeIntent: CallFlowState["activeIntent"];
    activePatientRef?: string;
  };
  officeKey: OfficeKey;
  amdOfficePhone: string;
  sipRoomName: string;
  sipParticipantIdentity: string;
  callId: string;
  callerPhone: string;
  trunkPhone: string;
  // Populated by phone lookup, verify_patient, or add_patient
  patientId: string | null;
  patientName: string | null;
  dob: string | null;
  insuranceCarrier: string | null;
  insPlanId: string | null;
  respPartyId: string | null;
  checkedInsurancePlan: string | null;
  checkedInsuranceCoverageType: InsuranceCoverageType | null;
  routing: string | null;
  lastAvailabilityRouting: string | null;
  lastAvailabilitySlots: StoredAvailabilitySlot[];
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

function evaluatePolicyForState(
  state: CallState,
  toolName: GuardedToolName,
  args?: unknown,
  options: {
    booking?: Parameters<typeof evaluateFlowToolPolicy>[0]["booking"];
  } = {},
): ToolOutcome | null {
  if (!isFlowHarnessEnabled(state)) return null;
  const turnGate = evaluateTurnUnderstandingGate(state, toolName);
  if (turnGate) return turnGate;
  syncSessionPatientFromActiveFlow(state);
  const decision = evaluateFlowToolPolicy({
    flow: state.flow,
    toolName,
    args,
    stateFacts: {
      checkedInsurancePlan: state.checkedInsurancePlan,
      checkedInsuranceCoverageType: state.checkedInsuranceCoverageType,
      patientId: state.patientId,
      lastAvailabilityRouting: state.lastAvailabilityRouting,
      officeKey: state.officeKey,
    },
    booking: options.booking,
  });
  const { observation } = decision;
  state.flowGuardObservations.push(observation);
  state.flow.lastGuardedToolCall = {
    name: toolName,
    argsHash: observation.argsHash,
    guardAllowed: decision.allowed,
  };
  if (!observation.allowed || !decision.allowed) {
    console.log(
      `[flow-policy] ${decision.allowed ? "report_only" : "blocked"} ${JSON.stringify(
        {
          toolName: observation.toolName,
          argsHash: observation.argsHash,
          reason: observation.reason,
          activeFlow: observation.activeFlow,
          activeIntent: observation.activeIntent,
          step: observation.step,
          patientStatus: observation.patientStatus,
          visitType: observation.visitType,
          officeKey: observation.officeKey,
        },
      )}`,
    );
  }
  if (!decision.outcome) return null;
  return withToolFacts(decision.outcome, state);
}

function evaluateTurnUnderstandingGate(
  state: CallState,
  toolName: string,
): ToolOutcome | null {
  if (!isFlowHarnessEnabled(state)) return null;
  if (!requiresTurnUnderstandingBeforeTool(state)) return null;
  return toolOutcome(
    "not_allowed",
    state.flow.step,
    "Update the call state first by calling record_turn_understanding, then continue.",
    {
      reason: "turn_understanding_required",
      toolName,
    },
    true,
  );
}

function isFlowHarnessEnabled(state: Pick<CallState, "flowHarnessEnabled">) {
  return state.flowHarnessEnabled === true;
}

function requiresTurnUnderstandingBeforeTool(state: CallState): boolean {
  const transcript = state.latestUserTranscript?.trim();
  if (!transcript) return false;
  return state.turnUnderstandingAppliedForTranscript !== transcript;
}

function withToolFacts(outcome: ToolOutcome, state: CallState): ToolOutcome {
  const reason = outcome.facts?.reason;
  if (
    reason === "availability_duplicate_search_signature" ||
    reason === "availability_search_budget_exhausted"
  ) {
    return {
      ...outcome,
      facts: {
        ...outcome.facts,
        cachedSlots: publicAvailabilitySlots(state.lastAvailabilitySlots),
      },
    };
  }
  return outcome;
}

function pendingSideEffectLookup(
  state: CallState,
  toolName: SideEffectToolName,
  args: unknown,
) {
  const actionType = sideEffectActionTypeForTool(toolName);
  const appointmentId =
    args && typeof args === "object" && !Array.isArray(args)
      ? (args as { appointmentId?: unknown }).appointmentId
      : undefined;
  return {
    type: actionType,
    argsHash: hashToolArgs(args ?? {}),
    patientRef: state.flow.activePatientRef,
    ...(typeof appointmentId === "number" ? { appointmentId } : {}),
  };
}

function consumeSideEffectActionForState(
  state: CallState,
  toolName: SideEffectToolName,
  args: unknown,
): void {
  consumePendingSideEffectAction(
    state.flow,
    pendingSideEffectLookup(state, toolName, args),
  );
}

function apiResultLooksSuccessful(result: unknown): boolean {
  if (!isRecord(result)) return true;
  const status =
    typeof result.status === "string" ? result.status.toLowerCase() : "";
  const outcome =
    typeof result.outcome === "string" ? result.outcome.toLowerCase() : "";
  return status !== "error" && outcome !== "error";
}

function hasSuccessfulBookingForActivePatient(state: CallState): boolean {
  const activePatientRef = state.flow.activePatientRef ?? "caller";
  return state.flow.pendingActions.some(
    (action) =>
      action.type === "book_appt" &&
      action.patientRef === activePatientRef &&
      action.consumed,
  );
}

function cancellationFailureReason(result: unknown): string {
  if (!isRecord(result)) return "cancel_failed";
  const status =
    typeof result.status === "string" ? result.status.toLowerCase() : "";
  const outcome =
    typeof result.outcome === "string" ? result.outcome.toLowerCase() : "";
  const message =
    typeof result.message === "string" ? result.message.toLowerCase() : "";
  const text = `${status} ${outcome} ${message}`;
  if (text.includes("already") && text.includes("cancel")) {
    return "appointment_already_cancelled";
  }
  if (
    text.includes("not found") ||
    text.includes("not_found") ||
    text.includes("missing appointment")
  ) {
    return "appointment_not_found";
  }
  if (status === "error") return "middleware_error";
  return "cancel_failed";
}

function toolOutcome(
  outcome: ToolOutcome["outcome"],
  nextStep: ToolOutcome["nextStep"],
  speak: string,
  facts: Record<string, unknown> = {},
  retryable = false,
): ToolOutcome {
  return {
    outcome,
    nextStep,
    speak,
    facts,
    retryable,
  };
}

export function buildCallCenterHandoffHeaders(
  state: Pick<CallState, "callId" | "callerPhone" | "officeKey" | "trunkPhone">,
  handoffTarget: string,
  handoffOfficeKey: OfficeKey = state.officeKey,
): Record<string, string> {
  return {
    "X-Acuity-Caller-Phone": state.callerPhone,
    "X-Acuity-Handoff": "call-center",
    "X-Acuity-Handoff-Target": handoffTarget,
    "X-Acuity-LiveKit-Call-Id": state.callId,
    "X-Acuity-Office-Key": handoffOfficeKey,
    "X-Acuity-Trunk-Phone": state.trunkPhone,
  };
}

export function makeCurrentSpeechUninterruptible(
  ctx: Pick<voice.RunContext, "speechHandle">,
): boolean {
  try {
    ctx.speechHandle.allowInterruptions = false;
    return true;
  } catch (err) {
    console.warn("[tools] Could not make current speech uninterruptible:", err);
    return false;
  }
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

function getHandoffOfficeKey(
  state: Pick<CallState, "officeKey" | "trunkPhone">,
): OfficeKey {
  if (!state.trunkPhone) return state.officeKey;
  try {
    return getOfficeConfigByPhone(state.trunkPhone).key;
  } catch (err) {
    console.warn(
      `[tools] Could not resolve handoff office from original trunk ${state.trunkPhone}; falling back to active office ${state.officeKey}`,
      err,
    );
    return state.officeKey;
  }
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

export function getBaseUrlForOfficePhone(officePhone: string): string {
  return normalizeBaseUrl(
    getOfficeConfigByPhone(officePhone).middlewareBaseUrl ?? BASE_URL,
  );
}

/** Apply patient data from an API response, resetting all patient fields so nothing stale lingers. */
function applyPatientResult(state: CallState, result: any): void {
  const appointments = result.appointments ?? [];
  const patientChange = recordVerifiedPatient(state.flow, {
    patientId: result.patientId ?? null,
    patientName: result.name ?? null,
    dob: result.dob ?? null,
    phone: result.phone ?? null,
    appointments,
  });
  const invalidatePatientState = shouldInvalidatePatientScopedState(
    state,
    result,
    patientChange.switchedPatient,
  );

  state.patientId = result.patientId ?? null;
  state.patientName = result.name ?? null;
  state.dob = result.dob ?? null;
  state.insuranceCarrier = result.insuranceCarrier ?? null;
  state.insPlanId = result.insPlanId ?? null;
  state.respPartyId = result.respPartyId ?? null;
  state.checkedInsurancePlan = result.insuranceCarrier ?? null;
  state.checkedInsuranceCoverageType =
    result.routing === "optical_only" ? "routine_vision" : null;
  state.routing = result.routing ?? null;
  if (invalidatePatientState) {
    clearAvailabilitySelection(state, "patient_changed");
  }
  state.allowedProviders = result.allowedProviders ?? [];
  state.routingAmbiguous = result.routingAmbiguous ?? false;
  state.preauthRequired = result.preauthRequired ?? false;
  state.appointments = appointments;
  state.flow.officeKey = state.officeKey;
  state.flow.routing = normalizeSchedulingRouting(state.routing);
  state.flow.coverageType = state.checkedInsuranceCoverageType ?? undefined;
  state.flow.visitType =
    state.checkedInsuranceCoverageType === "routine_vision"
      ? "routine_vision"
      : state.flow.visitType;
  if (state.insuranceCarrier || state.checkedInsurancePlan) {
    updateActivePatientInsurance(state.flow, {
      plan: state.insuranceCarrier ?? state.checkedInsurancePlan,
      coverageType: state.checkedInsuranceCoverageType,
      canonicalPlan: state.checkedInsurancePlan ?? state.insuranceCarrier,
    });
  }
}

function shouldInvalidatePatientScopedState(
  state: CallState,
  result: any,
  switchedPatient: boolean,
): boolean {
  return (
    switchedPatient ||
    changedKnownIdentityValue(state.patientId, result.patientId ?? null) ||
    changedKnownIdentityValue(state.patientName, result.name ?? null) ||
    changedKnownIdentityValue(state.dob, result.dob ?? null)
  );
}

function changedKnownIdentityValue(
  previous: string | null | undefined,
  next: string | null | undefined,
): boolean {
  const normalizedPrevious = normalizeIdentityValue(previous);
  const normalizedNext = normalizeIdentityValue(next);
  return Boolean(
    normalizedPrevious &&
    normalizedNext &&
    normalizedPrevious !== normalizedNext,
  );
}

function normalizeIdentityValue(value: string | null | undefined): string {
  return value?.trim().toLowerCase().replace(/\s+/g, " ") ?? "";
}

function formatPatientName(
  firstName: string | undefined,
  lastName: string | undefined,
): string | null {
  const fullName = [firstName, lastName]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(" ");
  return fullName || null;
}

function clearSessionPatientRecord(
  state: CallState,
  next: { patientName?: string | null; dob?: string | null } = {},
): void {
  state.patientId = null;
  state.patientName = next.patientName ?? null;
  state.dob = next.dob ?? null;
  state.insuranceCarrier = null;
  state.insPlanId = null;
  state.respPartyId = null;
  state.checkedInsurancePlan = null;
  state.checkedInsuranceCoverageType = null;
  state.routing = null;
  state.allowedProviders = [];
  state.routingAmbiguous = false;
  state.preauthRequired = false;
  state.appointments = [];
  state.flow.coverageType = undefined;
  state.flow.routing = undefined;
}

function syncSessionPatientFromActiveFlow(state: CallState): void {
  const patient = ensureActivePatientContext(state.flow);
  state.patientId = patient.patientId ?? null;
  state.patientName = formatPatientName(
    patient.firstName?.value,
    patient.lastName?.value,
  );
  state.dob = patient.dob?.value ?? null;
  state.appointments = [...patient.appointments];
  state.flow.patientStatus = patient.status;

  if (patient.insurance) {
    state.insuranceCarrier =
      patient.insurance.canonicalPlan ??
      patient.insurance.plan?.value ??
      state.insuranceCarrier;
    state.checkedInsurancePlan =
      patient.insurance.canonicalPlan ??
      patient.insurance.plan?.value ??
      state.checkedInsurancePlan;
    state.checkedInsuranceCoverageType =
      patient.insurance.coverageType ?? state.checkedInsuranceCoverageType;
  }
}

function routingForAvailability(
  state: CallState,
  routingOverride?: string | null,
): string | null {
  if (state.checkedInsuranceCoverageType === "routine_vision") {
    return "optical_only";
  }
  if (routingOverride) return routingOverride;
  return state.routing;
}

function clearAvailabilitySlots(state: CallState): void {
  state.lastAvailabilitySlots = [];
}

function clearAvailabilitySelection(
  state: CallState,
  invalidationReason?: AvailabilityInvalidationReason,
): void {
  clearAvailabilitySlots(state);
  state.lastAvailabilityRouting = null;
  if (invalidationReason) {
    invalidateAvailabilitySearches(state.flow, invalidationReason);
    invalidatePendingActionsForStateChange(state.flow, invalidationReason);
  }
}

function removeAvailabilitySlot(
  state: CallState,
  slotId: string,
): StoredAvailabilitySlot[] {
  const normalized = normalizeSlotId(slotId);
  state.lastAvailabilitySlots = state.lastAvailabilitySlots.filter(
    (slot) => normalizeSlotId(slot.slotId) !== normalized,
  );
  if (state.lastAvailabilitySlots.length === 0) {
    state.lastAvailabilityRouting = null;
  }
  return state.lastAvailabilitySlots;
}

function slotIdForIndex(index: number): string {
  if (index >= 0 && index < 26) {
    return String.fromCharCode("A".charCodeAt(0) + index);
  }
  return `slot_${index + 1}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractAppointments(result: unknown): CallerAppointment[] | null {
  if (Array.isArray(result)) return result as CallerAppointment[];
  if (isRecord(result) && Array.isArray(result.appointments)) {
    return result.appointments as CallerAppointment[];
  }
  return null;
}

function activeAppointmentById(
  state: CallState,
  appointmentId: number,
): CallerAppointment | undefined {
  const activePatient = ensureActivePatientContext(state.flow);
  return (
    activePatient.appointments.find(
      (appointment) => appointment.id === appointmentId,
    ) ??
    state.appointments.find((appointment) => appointment.id === appointmentId)
  );
}

function removeAppointmentById(state: CallState, appointmentId: number): void {
  state.appointments = state.appointments.filter(
    (appointment) => appointment.id !== appointmentId,
  );
  ensureActivePatientContext(state.flow).appointments =
    ensureActivePatientContext(state.flow).appointments.filter(
      (appointment) => appointment.id !== appointmentId,
    );
}

function updateCurrentTaskStep(
  state: CallState,
  nextStep: ToolOutcome["nextStep"],
): void {
  state.flow.step = nextStep;
  if (state.flow.currentTask) {
    state.flow.currentTask.step = nextStep;
  }
}

function publicProviderName(provider: string): string {
  return provider
    .replace("Dr. Austin Bach (Overflow)", "Dr. Bach")
    .replace("Dr. Austin Bach", "Dr. Bach")
    .replace("Dr. J. Licht", "Dr. Licht")
    .replace("Dr. D. Noel", "Dr. Noel");
}

function slotDateFromDatetime(datetime: string): string {
  return datetime.split("T")[0] ?? datetime;
}

function normalizeSlotId(slotId: string): string {
  return slotId.trim().toUpperCase();
}

function storeAvailabilitySlots(
  state: CallState,
  rawResponse: unknown,
  routing: string | null,
): unknown {
  if (!isRecord(rawResponse) || !Array.isArray(rawResponse.slots)) {
    clearAvailabilitySlots(state);
    return rawResponse;
  }

  const storedSlots: StoredAvailabilitySlot[] = [];
  const modelSlots = rawResponse.slots.map((slot, index) => {
    if (!isRecord(slot)) return slot;
    const provider =
      typeof slot.provider === "string"
        ? publicProviderName(slot.provider)
        : "";
    const datetime = typeof slot.datetime === "string" ? slot.datetime : "";
    const time = typeof slot.time === "string" ? slot.time : "";
    const date = slotDateFromDatetime(datetime);
    const slotId = slotIdForIndex(index);
    const spoken = [date, time, provider ? `with ${provider}` : ""]
      .filter(Boolean)
      .join(" ");

    const storedSlot: StoredAvailabilitySlot = {
      slotId,
      spoken,
      provider,
      date,
      time,
      datetime,
      routing,
    };
    if (typeof slot.bookingToken === "string") {
      storedSlot.bookingToken = slot.bookingToken;
    }
    if (typeof slot.columnId === "number") storedSlot.columnId = slot.columnId;
    if (typeof slot.profileId === "number")
      storedSlot.profileId = slot.profileId;
    if (typeof slot.duration === "number") storedSlot.duration = slot.duration;
    storedSlots.push(storedSlot);

    return {
      slotId,
      spoken,
      provider,
      date,
      time,
    };
  });

  state.lastAvailabilitySlots = storedSlots;
  return {
    ...rawResponse,
    slots: modelSlots,
  };
}

function normalizeAvailabilityOutcome(
  state: CallState,
  modelResult: unknown,
): unknown {
  if (!isRecord(modelResult)) return modelResult;
  const slots = Array.isArray(modelResult.slots) ? modelResult.slots : [];
  if (slots.length > 0) {
    updateCurrentTaskStep(state, "confirm_booking");
    return {
      ...modelResult,
      outcome: "success",
      nextStep: "confirm_booking",
      speak:
        "Availability found. Offer one best-fit slot and confirm before booking.",
      facts: {
        slots,
      },
      retryable: false,
    } satisfies ToolOutcome & Record<string, unknown>;
  }

  updateCurrentTaskStep(state, "get_availability");
  return {
    ...modelResult,
    outcome: "needs_clarification",
    nextStep: "get_availability",
    speak:
      "No availability was found for that search. Ask for a different date or broaden the search.",
    facts: {
      reason: "no_slots",
    },
    retryable: true,
  } satisfies ToolOutcome & Record<string, unknown>;
}

function normalizeInsuranceOutcome(
  state: CallState,
  response: InsuranceToolResponse,
): InsuranceToolResponse & ToolOutcome {
  const routeRequired =
    Boolean(response.routeTool) || state.flow.step === "route_office";
  const routeTool =
    response.routeTool ?? (routeRequired ? "route_to_spring_hill" : undefined);
  const outcome: ToolOutcome["outcome"] = routeRequired
    ? "route_required"
    : response.status === "accepted" && response.canProceed
      ? "success"
      : response.status === "needs_clarification"
        ? "needs_clarification"
        : "not_allowed";

  return {
    ...response,
    ...(routeTool ? { routeTool } : {}),
    outcome,
    nextStep: routeRequired ? "route_office" : state.flow.step,
    speak: response.callerMessage,
    facts: {
      status: response.status,
      canProceed: response.canProceed,
      canonicalPlan: response.canonicalPlan,
      clarificationNeeded: response.clarificationNeeded,
      acceptedAtAlternateOffice: response.acceptedAtAlternateOffice,
      alternateCanonicalPlan: response.alternateCanonicalPlan,
      routeTool,
    },
    retryable: outcome !== "success",
  };
}

function selectedAvailabilitySlot(
  state: CallState,
  slotId: string,
): StoredAvailabilitySlot | null {
  const normalized = normalizeSlotId(slotId);
  return (
    state.lastAvailabilitySlots.find(
      (slot) => normalizeSlotId(slot.slotId) === normalized,
    ) ?? null
  );
}

function publicAvailabilitySlots(slots: StoredAvailabilitySlot[]) {
  return slots.map(({ slotId, spoken, provider, date, time }) => ({
    slotId,
    spoken,
    provider,
    date,
    time,
  }));
}

async function submitLegacyBooking(
  state: CallState,
  selectedSlot: StoredAvailabilitySlot,
  appointmentTypeId: number,
): Promise<unknown> {
  const routing =
    selectedSlot.routing ??
    state.lastAvailabilityRouting ??
    routingForAvailability(state);
  const usedBookingToken = Boolean(selectedSlot.bookingToken);
  let slotPayload: Record<string, unknown>;
  if (selectedSlot.bookingToken) {
    slotPayload = { bookingToken: selectedSlot.bookingToken };
  } else if (
    selectedSlot.columnId &&
    selectedSlot.profileId &&
    selectedSlot.datetime &&
    selectedSlot.duration
  ) {
    slotPayload = {
      columnId: selectedSlot.columnId,
      profileId: selectedSlot.profileId,
      startDatetime: selectedSlot.datetime,
      duration: selectedSlot.duration,
    };
  } else {
    clearAvailabilitySlots(state);
    return "ERROR: The selected slot is missing booking details. Call get_availability again and choose one of the returned slots.";
  }
  const body = {
    ...slotPayload,
    appointmentTypeId,
    patientId: state.patientId,
    ...(state.patientName ? { patientName: state.patientName } : {}),
    ...(state.dob ? { dob: state.dob } : {}),
    ...(routing ? { routing } : {}),
  };
  const result = await callApi(
    "/api/appointment/book",
    body,
    getAmdOfficeForToolCall(state),
  );
  if (isRecord(result)) {
    const message =
      typeof result.message === "string" ? result.message.toLowerCase() : "";
    const invalidatesSelection =
      result.status === "booked" ||
      result.outcome === "slot_unavailable" ||
      result.outcome === "invalid_booking_token" ||
      (usedBookingToken && result.status === "error") ||
      message.includes("slot is no longer available");
    if (invalidatesSelection) {
      clearAvailabilitySelection(state);
    }
  }
  return result;
}

function ensureRoutineVisionOffice(state: CallState): void {
  if (state.checkedInsuranceCoverageType !== "routine_vision") return;
  if (!getOfficeConfig(state.officeKey).features.routeRoutineVisionToSpringHill)
    return;
  clearAvailabilitySelection(state, "office_changed");
  state.officeKey = "spring-hill";
  state.amdOfficePhone = getSpringHillOfficePhone();
  state.flow.officeKey = "spring-hill";
  state.flow.activeFlow = "scheduling";
  state.flow.visitType = "routine_vision";
  state.flow.coverageType = "routine_vision";
  state.flow.routing = "optical_only";
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
  office: string,
): Promise<unknown> {
  const payload = { ...body, office };
  const res = await fetch(`${getBaseUrlForOfficePhone(office)}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: AUTH_TOKEN,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API error ${res.status}: ${text}`);
  }
  return res.json();
}

// --- record_turn_understanding ---
export const record_turn_understanding = llm.tool({
  description: `Internal memory update. Call this exactly once at the start of every user turn before answering the caller or calling any other tool.

Use it to provide the structured semantic state update for the caller's latest turn. This is not a side-effect tool and should never be mentioned to the caller.

If the caller only says a backchannel like "yes", "okay", or "mm-hmm", still call this tool with goal "unclear", interruption "backchannel", and the right confidence/evidence.`,
  parameters: turnUnderstandingSchema,
  execute: async (understanding, { ctx }) => {
    const state = getState(ctx);
    if (!isFlowHarnessEnabled(state)) {
      return {
        status: "disabled",
        instruction:
          "Flow harness is disabled for this trunk. Continue with the normal tool flow.",
      };
    }
    const transcript = state.latestUserTranscript?.trim() ?? "";

    if (
      transcript &&
      state.turnUnderstandingAppliedForTranscript === transcript
    ) {
      return {
        status: "already_recorded",
        turnState: compileTurnStatePacket(state.flow),
        instruction:
          "Continue from this turn_state. Do not call record_turn_understanding again for this same user turn.",
      };
    }

    const turn = advanceFlowForTurn({
      flow: state.flow,
      transcript,
      understanding,
    });
    state.turnUnderstandingAppliedForTranscript = transcript || null;
    state.lastTurnUnderstanding = {
      goal: turn.update.understanding.goal,
      appointmentAction: turn.update.understanding.appointmentAction,
      confidence: turn.update.understanding.confidence,
      activeIntent: state.flow.activeIntent,
      activePatientRef: state.flow.activePatientRef,
    };

    return {
      status: "recorded",
      goal: turn.update.understanding.goal,
      appointmentAction: turn.update.understanding.appointmentAction,
      activeIntent: state.flow.activeIntent,
      activeFlow: state.flow.activeFlow,
      step: state.flow.step,
      activePatientRef: state.flow.activePatientRef,
      turnState: turn.turnState,
      controllerDecision: turn.decision,
      resolvedMetaDecision: turn.resolvedMetaDecision,
      instruction: turn.instruction,
    };
  },
});

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
    nameSource: z
      .enum(["caller_spoken", "caller_spelled"])
      .optional()
      .describe(
        "Set caller_spelled when the caller spelled or corrected the name; spelled values override earlier transcript guesses",
      ),
    relationshipToCaller: z
      .enum(["self", "child", "parent", "spouse", "other_family", "other"])
      .optional()
      .describe(
        "Who the patient is relative to the caller. Use child when a parent is calling for their child; use self when the caller is the patient.",
      ),
  }),
  execute: async (
    { firstName, lastName, dob, usePhone, nameSource, relationshipToCaller },
    { ctx },
  ) => {
    const state = getState(ctx);
    const policyResponse = evaluatePolicyForState(state, "verify_patient", {
      firstName,
      lastName,
      dob,
      usePhone,
      nameSource,
      relationshipToCaller,
    });
    if (policyResponse) return policyResponse;
    const previousIdentity = snapshotActivePatientIdentity(state.flow);
    recordPatientVerificationAttempt(state.flow, {
      firstName,
      lastName,
      dob,
      phone: usePhone ? state.callerPhone : undefined,
      usePhone,
      relationshipToCaller,
      source: nameSource ?? "caller_spoken",
    });
    const identityChanged = hasActivePatientIdentityChanged(
      state.flow,
      previousIdentity,
    );
    if (identityChanged) {
      clearAvailabilitySelection(state, "patient_changed");
      clearSessionPatientRecord(state, {
        patientName: formatPatientName(firstName, lastName),
        dob: dob ?? null,
      });
    }
    const body: Record<string, unknown> = { firstName };
    if (lastName) body.lastName = lastName;
    if (dob) body.dob = dob;
    if (usePhone) body.phone = state.callerPhone;
    ensureRoutineVisionOffice(state);
    const result = (await callApi(
      "/api/verify-patient",
      body,
      getAmdOfficeForToolCall(state),
    )) as any;
    if (result?.patientId) {
      applyPatientResult(state, result);
      return toolOutcome(
        "success",
        state.flow.step,
        "Patient verified.",
        {
          patientStatus: state.flow.patientStatus,
          routing: state.routing,
          routingAmbiguous: state.routingAmbiguous,
          preauthRequired: state.preauthRequired,
        },
        false,
      );
    }
    return toolOutcome(
      "not_found",
      "collect_registration",
      "No matching patient was found. Retry with corrected identity details or move into registration if the caller is new.",
      {
        reason: "patient_not_found",
        result,
      },
      true,
    );
  },
});

// --- add_patient ---
export const add_patient = llm.tool({
  description: `Creates a new patient record. Use only when verify_patient returns no match. Every submitted field must come from what the caller explicitly said — never fabricate or guess values.

Follow the registration order in the runbook. Key rules for this tool:
- Run check_insurance first. Use the canonicalPlan from the latest check_insurance result for the insurance value sent to middleware. If the tool accepted a family alias like "Blue Cross" or "Oscar", do not rewrite it yourself.
- For a new routine-vision patient, check_insurance must use coverageType "routine_vision" first. This tool will attach that coverage type and canonical vision plan to the new patient payload.
- Ask "is the number you're calling from a good one on file?" If yes, omit phone and this tool will use the inbound caller number already stored in session state. If no, collect the best 10-digit phone number and pass it explicitly.
- Email is optional. Ask once; if the caller says they do not have one, omit email and continue registration. Do not transfer just because email is missing.
- If subscriber is "me" or "mine" = use patient name.
- Member ID is required — do not imply registration is almost done until you have it. If they don't have their card, offer to hold.
- Before submitting: read back name (spell last name letter by letter), DOB, insurance plan, and member ID. Wait for confirmation.

After response: if routing "not_accepted", tell them. If preauthRequired, scheduling starts two weeks out. Go straight to scheduling — don't check appointments for a new patient.

Preauth insurances: United Healthcare HMO, Aetna HMO, Florida Blue Medicare HMO, Cigna HMO, Tricare Prime, Tricare Forever.`,
  parameters: addPatientParameters,
  execute: async (params, { ctx }) => {
    const state = getState(ctx);
    const policyResponse = evaluatePolicyForState(state, "add_patient", params);
    if (policyResponse) return policyResponse;
    const insurance = state.checkedInsurancePlan ?? params.insurance;
    const phone = params.phone ?? state.callerPhone;
    if (!phone) {
      return toolOutcome(
        "needs_clarification",
        "collect_registration",
        "Ask whether the number they're calling from is good; if not, collect the best phone number.",
        { reason: "registration_requires_phone" },
        true,
      );
    }
    if (!makeCurrentSpeechUninterruptible(ctx)) {
      return toolOutcome(
        "not_allowed",
        "collect_registration",
        "Registration was interrupted before it could be submitted. Please confirm the patient details again.",
        { reason: "speech_interrupted" },
        true,
      );
    }
    ensureRoutineVisionOffice(state);
    const payload: Record<string, unknown> = { ...params, insurance, phone };
    if (state.checkedInsuranceCoverageType === "routine_vision") {
      payload.coverageType = "routine_vision";
    }
    if (typeof params.email === "string" && params.email.trim()) {
      payload.email = params.email.trim();
    } else {
      delete payload.email;
    }
    const result = (await callApi(
      "/api/add-patient",
      payload,
      getAmdOfficeForToolCall(state),
    )) as any;
    if (result?.patientId) {
      consumeSideEffectActionForState(state, "add_patient", params);
      applyPatientResult(state, result);
      return toolOutcome(
        "success",
        "get_availability",
        "Patient registration submitted successfully.",
        {
          patientStatus: state.flow.patientStatus,
          routing: state.routing,
          preauthRequired: state.preauthRequired,
        },
        false,
      );
    }
    return toolOutcome(
      "error",
      "collect_registration",
      "Registration did not complete. Confirm the registration details and try again or transfer.",
      {
        reason: "registration_failed",
        result,
      },
      true,
    );
  },
});

// --- update_insurance ---
export const update_insurance = llm.tool({
  description: `Updates a verified patient's insurance. Requires verify_patient first. Confirm plan name and member ID with caller before submitting.

Run check_insurance first with medical coverage and use the canonicalPlan from the latest result for the insurance value sent to middleware. Do not use update_insurance just to schedule a routine vision appointment for an existing patient; collect/check the vision insurance and schedule on the routine-vision lane instead.

After response: session state updates automatically. If preauthRequired, scheduling starts two weeks out.`,
  parameters: updateInsuranceParameters,
  execute: async ({ insurance, subscriberName, subscriberNum }, { ctx }) => {
    const state = getState(ctx);
    const policyResponse = evaluatePolicyForState(state, "update_insurance", {
      insurance,
      subscriberName,
      subscriberNum,
    });
    if (policyResponse) return policyResponse;
    if (!state.patientId) {
      return toolOutcome(
        "not_allowed",
        "verify_patient",
        "Verify the patient before updating insurance.",
        { reason: "update_insurance_requires_verified_patient" },
        true,
      );
    }
    if (!makeCurrentSpeechUninterruptible(ctx)) {
      return toolOutcome(
        "not_allowed",
        "check_insurance",
        "Insurance update was interrupted before it could be submitted. Please confirm the insurance details again.",
        { reason: "speech_interrupted" },
        true,
      );
    }
    const insuranceForMiddleware =
      state.checkedInsuranceCoverageType === "medical"
        ? (state.checkedInsurancePlan ?? insurance)
        : insurance;
    const payload: Record<string, unknown> = {
      patientId: state.patientId,
      ...(state.dob ? { dob: state.dob } : {}),
      insPlanId: state.insPlanId ?? "",
      respPartyId: state.respPartyId ?? "",
      oldInsurance: state.insuranceCarrier ?? "",
      insurance: insuranceForMiddleware,
      subscriberName,
      subscriberNum,
    };
    const result = (await callApi(
      "/api/patient/update-insurance",
      payload,
      getAmdOfficeForToolCall(state),
    )) as any;
    if (result?.status === "updated") {
      consumeSideEffectActionForState(state, "update_insurance", {
        insurance,
        subscriberName,
        subscriberNum,
      });
      state.insuranceCarrier = result.newInsurance ?? state.insuranceCarrier;
      state.insPlanId = result.insPlanId ?? null;
      state.respPartyId = result.respPartyId ?? null;
      state.routing = result.routing ?? state.routing;
      state.allowedProviders =
        result.allowedProviders ?? state.allowedProviders;
      state.routingAmbiguous = result.routingAmbiguous ?? false;
      state.preauthRequired = result.preauthRequired ?? false;
      updateActivePatientInsurance(state.flow, {
        plan: state.insuranceCarrier,
        coverageType: state.checkedInsuranceCoverageType,
        canonicalPlan: state.checkedInsurancePlan ?? state.insuranceCarrier,
      });
      clearAvailabilitySelection(state, "insurance_changed");
      return toolOutcome(
        "success",
        nextPatientFlowStep(state.flow.patientStatus),
        "Insurance updated successfully.",
        {
          routing: state.routing,
          preauthRequired: state.preauthRequired,
        },
        false,
      );
    }
    return toolOutcome(
      "error",
      "check_insurance",
      "Insurance update did not complete. Confirm the insurance details and try again or transfer.",
      {
        reason: "insurance_update_failed",
        result,
      },
      true,
    );
  },
});

// --- get_availability ---
export const get_availability = llm.tool({
  description: `Gets schedule availability. Requires date (YYYY-MM-DD). Routing and preauth auto-applied from session state.

Ask the caller the reason for their visit before calling this tool so the scheduling lane is right. The API returns slot timing and provider details needed for booking. It does not return appointmentTypeId.

Rules: no same-day appointments — earliest is tomorrow. If the caller asks for today, just let them know the earliest you can schedule is tomorrow and offer that. Don't make up a policy — just move to the next available day. Under 18 medical visits = Dr. Bach only. Bach has limited schedule — set expectations. If routing is "not_accepted", do not call. "ASAP" or "whenever" = search tomorrow.

After response: check if date shifted vs requested — tell caller if different. Suggest one best-fit slot (date + time). Mention the doctor only if asked or clinically relevant. If rejected, offer one alternative. Scan existing results before calling again. If no slots are returned, tell the caller that date has no openings and offer the nearest available date.`,
  parameters: z.object({
    date: z.string().describe("Start date to search, formatted YYYY-MM-DD"),
    routing: z
      .enum(["bach_only", "bach_licht", "all_three", "optical_only"])
      .optional()
      .describe(
        "Use optical_only only for routine eye exam or glasses/contact lens prescription visits using accepted vision insurance.",
      ),
  }),
  execute: async ({ date, routing }, { ctx }) => {
    const state = getState(ctx);
    const policyResponse = evaluatePolicyForState(state, "get_availability", {
      date,
      routing,
    });
    if (policyResponse) return policyResponse;
    ensureRoutineVisionOffice(state);
    state.flow.step = "get_availability";
    const body: Record<string, unknown> = { date };
    const effectiveRouting = routingForAvailability(state, routing);
    if (state.dob) body.dob = state.dob;
    if (effectiveRouting) body.routing = effectiveRouting;
    if (state.preauthRequired) body.preauthRequired = true;
    const result = await callApi(
      "/api/scheduler/availability",
      body,
      getAmdOfficeForToolCall(state),
    );
    state.lastAvailabilityRouting = effectiveRouting;
    if (!isFlowHarnessEnabled(state)) {
      return storeAvailabilitySlots(state, result, effectiveRouting);
    }
    recordAvailabilitySearch(state.flow, {
      patientRef: state.flow.activePatientRef,
      officeKey: state.officeKey,
      visitType: state.flow.visitType,
      coverageType: state.flow.coverageType,
      routing: effectiveRouting,
      date,
    });
    const modelResult = storeAvailabilitySlots(state, result, effectiveRouting);
    recordAvailabilityCachedSlots(
      state.flow,
      state.lastAvailabilitySlots.map((slot) => ({
        slotId: slot.slotId,
        datetime: slot.datetime,
        columnId: slot.columnId,
        profileId: slot.profileId,
        duration: slot.duration,
      })),
    );
    return normalizeAvailabilityOutcome(state, modelResult);
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
    const turnGate = evaluateTurnUnderstandingGate(state, "confirm_appt");
    if (turnGate) return turnGate;
    syncSessionPatientFromActiveFlow(state);
    if (!state.patientId) {
      return toolOutcome(
        "not_allowed",
        "verify_patient",
        "Verify the patient before looking up appointments.",
        { reason: "appointment_lookup_requires_verified_patient" },
        true,
      );
    }
    const result = await callApi(
      "/api/patient/appointments",
      { patientId: state.patientId },
      getAmdOfficeForToolCall(state),
    );
    const appointments = extractAppointments(result);
    if (appointments) {
      state.appointments = appointments;
      ensureActivePatientContext(state.flow).appointments = appointments;
      startPatientTask(state.flow, {
        kind: "appointment_management",
        step: appointments.length > 0 ? "confirm_cancel" : "answer",
      });
      return toolOutcome(
        appointments.length > 0 ? "success" : "not_found",
        appointments.length > 0 ? "confirm_cancel" : "answer",
        appointments.length > 0
          ? "Appointments loaded. Read back the relevant appointment before taking action."
          : "No upcoming appointments were found.",
        { appointments },
        false,
      );
    }
    return toolOutcome(
      "error",
      "answer",
      "Could not load appointments. Try again or transfer.",
      {
        reason: "appointment_lookup_failed",
        result,
      },
      true,
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
    const state = getState(ctx);
    const policyResponse = evaluatePolicyForState(state, "cancel_appt", {
      appointmentId,
    });
    if (policyResponse) return policyResponse;
    if (!makeCurrentSpeechUninterruptible(ctx)) {
      return toolOutcome(
        "not_allowed",
        "confirm_cancel",
        "Cancellation was interrupted before it could be submitted. Please confirm the cancellation again.",
        { reason: "speech_interrupted" },
        true,
      );
    }
    const result = await callApi(
      "/api/appointment/cancel",
      { appointmentId },
      getAmdOfficeForToolCall(state),
    );
    const cancelResultReason = cancellationFailureReason(result);
    if (
      apiResultLooksSuccessful(result) ||
      cancelResultReason === "appointment_already_cancelled"
    ) {
      consumeSideEffectActionForState(state, "cancel_appt", { appointmentId });
      removeAppointmentById(state, appointmentId);
      state.flow.pendingConfirmation = undefined;
      const resumedTask =
        state.flow.currentTask?.kind === "appointment_management"
          ? completeCurrentTaskAndResume(state.flow)
          : undefined;
      if (!resumedTask) {
        updateCurrentTaskStep(state, "answer");
        state.flow.step = "answer";
      }
      return toolOutcome(
        "success",
        resumedTask?.step ?? "answer",
        cancelResultReason === "appointment_already_cancelled"
          ? "That appointment was already cancelled. No further cancellation is needed."
          : "Cancellation submitted successfully.",
        {
          appointmentId,
          resumedTaskId: resumedTask?.id,
          ...(cancelResultReason === "appointment_already_cancelled"
            ? { reason: cancelResultReason }
            : {}),
        },
        false,
      );
    }
    const reason = cancelResultReason;
    return toolOutcome(
      reason === "appointment_not_found" ? "not_found" : "error",
      "confirm_cancel",
      reason === "appointment_not_found"
        ? "That appointment was not found. Load the patient's appointments again before cancelling."
        : "Cancellation did not complete. Confirm the appointment and try again or transfer.",
      {
        reason,
        appointmentId,
        result,
      },
      true,
    );
  },
});

// --- add_patient_note ---
export const add_patient_note = llm.tool({
  description: `Adds a short operational note to the verified patient's AdvancedMD chart. Requires a verified patient from phone lookup, verify_patient, or add_patient.

For scheduling workflows, collect the appointment reason and referring doctor during the call, but call this tool only after book_appt succeeds.

Only save these two fields: appointment reason and referring doctor. If there is no referring doctor, set referringDoctor to "none". Do not include diagnoses, clinical judgments, raw transcripts, appointment times, insurance, patient demographics, or anything else.`,
  parameters: z.object({
    appointmentReason: z
      .string()
      .min(1)
      .max(500)
      .describe("The caller's stated appointment reason"),
    referringDoctor: z
      .string()
      .min(1)
      .max(200)
      .describe(
        'The referring doctor name, or "none" if the caller was not referred',
      ),
  }),
  execute: async ({ appointmentReason, referringDoctor }, { ctx }) => {
    const state = getState(ctx);
    const turnGate = evaluateTurnUnderstandingGate(state, "add_patient_note");
    if (turnGate) return turnGate;
    syncSessionPatientFromActiveFlow(state);
    if (!state.patientId) {
      return toolOutcome(
        "not_allowed",
        "verify_patient",
        "Verify the patient before adding a note.",
        { reason: "note_requires_verified_patient" },
        true,
      );
    }
    if (!hasSuccessfulBookingForActivePatient(state)) {
      return toolOutcome(
        "not_allowed",
        "book",
        "Save the appointment note only after a successful booking.",
        { reason: "note_requires_successful_booking" },
        true,
      );
    }
    const reason = appointmentReason.trim();
    const referrer = referringDoctor.trim();
    if (!reason || !referrer) {
      return toolOutcome(
        "needs_clarification",
        "collect_visit_reason",
        "Collect both the appointment reason and referring doctor before saving the note.",
        { reason: "note_requires_reason_and_referrer" },
        true,
      );
    }
    if (!makeCurrentSpeechUninterruptible(ctx)) {
      return toolOutcome(
        "not_allowed",
        "collect_visit_reason",
        "The note was interrupted before it could be saved. Please confirm the note again.",
        { reason: "speech_interrupted" },
        true,
      );
    }
    const note = `Appointment reason: ${reason}\nReferring doctor: ${referrer}`;
    const result = await callApi(
      "/api/patient/notes",
      { patientId: state.patientId, note },
      getAmdOfficeForToolCall(state),
    );
    if (apiResultLooksSuccessful(result)) {
      return toolOutcome(
        "success",
        "answer",
        "Patient note saved.",
        { result },
        false,
      );
    }
    return toolOutcome(
      "error",
      "collect_visit_reason",
      "The note did not save. Confirm the note details and try again or transfer.",
      { reason: "note_save_failed", result },
      true,
    );
  },
});

// --- confirm_side_effect_action ---
export const confirm_side_effect_action = llm.tool({
  description: `Records the caller's explicit confirmation before a side-effect tool runs. Use this after reading back the exact details for cancellation, registration, insurance update, Spring Hill routing, or human transfer. This tool only records confirmation; it does not submit the side effect.`,
  parameters: z.object({
    action: z
      .enum([
        "cancel_appt",
        "add_patient",
        "update_insurance",
        "route_to_spring_hill",
        "transfer_call",
      ])
      .describe("The side-effect tool the caller explicitly confirmed"),
    spokenSummary: z
      .string()
      .describe("Concise summary of the details read back to the caller"),
    appointmentId: z
      .number()
      .optional()
      .describe("Required when action is cancel_appt"),
    addPatient: addPatientParameters
      .optional()
      .describe("Required when action is add_patient"),
    updateInsurance: updateInsuranceParameters
      .optional()
      .describe("Required when action is update_insurance"),
  }),
  execute: async (params, { ctx, toolCallId }) => {
    const state = getState(ctx);
    const turnGate = evaluateTurnUnderstandingGate(
      state,
      "confirm_side_effect_action",
    );
    if (turnGate) return turnGate;
    syncSessionPatientFromActiveFlow(state);
    const actionType = sideEffectActionTypeForTool(params.action);
    let sideEffectArgs: unknown = {};
    let appointmentId: number | undefined;
    let requiredFieldsComplete: boolean | undefined;

    if (params.action === "cancel_appt") {
      if (typeof params.appointmentId !== "number") {
        return {
          outcome: "not_allowed",
          nextStep: "confirm_cancel",
          speak:
            "Choose the exact appointment ID, read it back, and confirm before cancelling.",
          facts: { reason: "side_effect_requires_pending_action" },
          retryable: true,
        } satisfies ToolOutcome;
      }
      if (!activeAppointmentById(state, params.appointmentId)) {
        return toolOutcome(
          "not_allowed",
          "confirm_cancel",
          "Load the patient's appointments and choose the exact appointment before confirming cancellation.",
          { reason: "cancel_requires_loaded_appointment" },
          true,
        );
      }
      appointmentId = params.appointmentId;
      sideEffectArgs = { appointmentId };
      state.flow.pendingConfirmation = {
        type: "cancel",
        payload: { appointmentId },
      };
    } else if (params.action === "add_patient") {
      if (!params.addPatient) {
        return {
          outcome: "not_allowed",
          nextStep: "collect_registration",
          speak:
            "Include the registration fields that were read back before confirming registration.",
          facts: { reason: "side_effect_requires_pending_action" },
          retryable: true,
        } satisfies ToolOutcome;
      }
      sideEffectArgs = params.addPatient;
      requiredFieldsComplete = true;
    } else if (params.action === "update_insurance") {
      if (!params.updateInsurance) {
        return {
          outcome: "not_allowed",
          nextStep: "check_insurance",
          speak:
            "Include the insurance update fields that were read back before confirming the update.",
          facts: { reason: "side_effect_requires_pending_action" },
          retryable: true,
        } satisfies ToolOutcome;
      }
      sideEffectArgs = params.updateInsurance;
    }

    const action = createPendingSideEffectAction(state.flow, {
      type: actionType,
      argsHash: hashToolArgs(sideEffectArgs),
      spokenSummary: params.spokenSummary,
      patientRef: state.flow.activePatientRef,
      appointmentId,
      requiredFieldsComplete,
      confirmed: true,
      createdTurnId: toolCallId,
      confirmationTurnId: toolCallId,
    });

    return {
      outcome: "success",
      nextStep: nextStepForSideEffectAction(actionType),
      speak: "Confirmation recorded. Submit the confirmed action now.",
      facts: {
        pendingActionId: action.id,
        action: params.action,
      },
      retryable: false,
    } satisfies ToolOutcome;
  },
});

// --- confirm_booking_action ---
export const confirm_booking_action = llm.tool({
  description: `Records the caller's explicit confirmation for one offered appointment slot. Call this immediately after the caller says yes to a specific slot, before calling book_appt. This only creates the pending booking action; it does not book the appointment.`,
  parameters: z.object({
    slotId: z
      .string()
      .describe("slotId of the exact slot the caller confirmed"),
    appointmentTypeId: appointmentTypeIdSchema,
  }),
  execute: async (params, { ctx, toolCallId }) => {
    const state = getState(ctx);
    const turnGate = evaluateTurnUnderstandingGate(
      state,
      "confirm_booking_action",
    );
    if (turnGate) return turnGate;
    syncSessionPatientFromActiveFlow(state);
    if (!state.patientId) {
      return {
        outcome: "not_allowed",
        nextStep: "verify_patient",
        speak: "Verify or create the patient before confirming a booking.",
        facts: { reason: "booking_requires_verified_or_created_patient" },
        retryable: true,
      } satisfies ToolOutcome;
    }

    const selectedSlot = selectedAvailabilitySlot(state, params.slotId);
    if (!selectedSlot) {
      return {
        outcome: "not_allowed",
        nextStep: "get_availability",
        speak:
          "That slot is not available from the latest availability search. Search availability again before confirming.",
        facts: { reason: "booking_requires_recent_availability" },
        retryable: true,
      } satisfies ToolOutcome;
    }

    const routing =
      selectedSlot.routing ??
      state.lastAvailabilityRouting ??
      routingForAvailability(state);
    const action = createPendingBookingAction(state.flow, {
      patientRef: state.flow.activePatientRef,
      slotHash: selectedSlot.slotId,
      appointmentTypeId: params.appointmentTypeId,
      officeKey: state.officeKey,
      routing,
      spokenSummary: selectedSlot.spoken,
      confirmed: true,
      createdTurnId: toolCallId,
      confirmationTurnId: toolCallId,
    });
    state.flow.step = "book";

    return {
      outcome: "success",
      nextStep: "book",
      speak: "Booking confirmation recorded. Submit the booking now.",
      facts: {
        pendingActionId: action.id,
        slotId: selectedSlot.slotId,
        spokenSummary: selectedSlot.spoken,
      },
      retryable: false,
    } satisfies ToolOutcome;
  },
});

// --- book_appt ---
export const book_appt = llm.tool({
  description: `Books an appointment using slotId from the latest get_availability response. Patient ID is read from session state automatically.

Select appointmentTypeId only from the allowed enum based on office, patient status, age, routing lane, and visit type. Availability does not return appointmentTypeId, so do not claim it came from the slot.

Only book after the caller says yes to the exact offered slot. If booking fails because the slot is unavailable, call get_availability again before trying another slot.`,
  parameters: z.object({
    slotId: z
      .string()
      .describe("slotId of the caller-confirmed slot from get_availability"),
    appointmentTypeId: appointmentTypeIdSchema,
  }),
  execute: async (params, { ctx }) => {
    const state = getState(ctx);
    if (!state.patientId) {
      const policyResponse = evaluatePolicyForState(state, "book_appt", params);
      return (
        policyResponse ??
        toolOutcome(
          "not_allowed",
          "verify_patient",
          "Verify or create the patient before booking.",
          { reason: "booking_requires_verified_or_created_patient" },
          true,
        )
      );
    }
    ensureRoutineVisionOffice(state);
    const selectedSlot = selectedAvailabilitySlot(state, params.slotId);
    if (!selectedSlot) {
      const policyResponse = evaluatePolicyForState(
        state,
        "book_appt",
        params,
        {
          booking: {
            patientRef: state.flow.activePatientRef,
            slotHash: normalizeSlotId(params.slotId),
            appointmentTypeId: params.appointmentTypeId,
            officeKey: state.officeKey,
            routing:
              state.lastAvailabilityRouting ?? routingForAvailability(state),
          },
        },
      );
      if (policyResponse) return policyResponse;
      return toolOutcome(
        "not_allowed",
        "get_availability",
        "That slot is not available from the latest availability search. Search availability again before booking.",
        {
          reason: "booking_requires_recent_availability",
          slotId: params.slotId,
        },
        true,
      );
    }
    const routing =
      selectedSlot.routing ??
      state.lastAvailabilityRouting ??
      routingForAvailability(state);
    const bookingPolicyFacts = {
      patientRef: state.flow.activePatientRef,
      slotHash: selectedSlot.slotId,
      appointmentTypeId: params.appointmentTypeId,
      officeKey: state.officeKey,
      routing,
    };
    const policyResponse = evaluatePolicyForState(state, "book_appt", params, {
      booking: bookingPolicyFacts,
    });
    if (policyResponse) return policyResponse;
    if (!makeCurrentSpeechUninterruptible(ctx)) {
      return toolOutcome(
        "not_allowed",
        "confirm_booking",
        "Booking was interrupted before it could be submitted. Please confirm the appointment slot again.",
        { reason: "speech_interrupted" },
        true,
      );
    }
    if (!isFlowHarnessEnabled(state)) {
      return submitLegacyBooking(state, selectedSlot, params.appointmentTypeId);
    }
    const bookingAttempt = recordBookingAttempt(state.flow, {
      ...bookingPolicyFacts,
      spokenSummary: selectedSlot.spoken,
    });
    if (!bookingAttempt.action) {
      return {
        outcome: "not_allowed",
        nextStep: "confirm_booking",
        speak:
          "Confirm the exact slot and create a pending booking action before booking.",
        facts: { reason: "booking_requires_pending_action" },
        retryable: true,
      } satisfies ToolOutcome;
    }
    const usedBookingToken = Boolean(selectedSlot.bookingToken);
    let slotPayload: Record<string, unknown>;
    if (selectedSlot.bookingToken) {
      slotPayload = { bookingToken: selectedSlot.bookingToken };
    } else if (
      selectedSlot.columnId &&
      selectedSlot.profileId &&
      selectedSlot.datetime &&
      selectedSlot.duration
    ) {
      slotPayload = {
        columnId: selectedSlot.columnId,
        profileId: selectedSlot.profileId,
        startDatetime: selectedSlot.datetime,
        duration: selectedSlot.duration,
      };
    } else {
      clearAvailabilitySlots(state);
      return toolOutcome(
        "error",
        "get_availability",
        "The selected slot is missing booking details. Search availability again and choose one of the returned slots.",
        { reason: "slot_missing_booking_details", slotId: selectedSlot.slotId },
        true,
      );
    }
    const body = {
      ...slotPayload,
      appointmentTypeId: params.appointmentTypeId,
      patientId: state.patientId,
      ...(state.patientName ? { patientName: state.patientName } : {}),
      ...(state.dob ? { dob: state.dob } : {}),
      ...(routing ? { routing } : {}),
    };
    const result = await callApi(
      "/api/appointment/book",
      body,
      getAmdOfficeForToolCall(state),
    );
    const bookingResult = recordBookingResult(
      state.flow,
      bookingAttempt.action.id,
      result,
    );
    if (bookingResult.consumed) {
      clearAvailabilitySelection(state);
      updateCurrentTaskStep(state, "answer");
      return toolOutcome(
        "success",
        "answer",
        "Appointment booked successfully.",
        {
          slotId: selectedSlot.slotId,
          appointmentTypeId: params.appointmentTypeId,
          appointmentId: isRecord(result) ? result.appointmentId : undefined,
        },
        false,
      );
    }
    if (bookingResult.errorClass === "slot_unavailable") {
      const remainingSlots = removeAvailabilitySlot(state, selectedSlot.slotId);
      updateCurrentTaskStep(
        state,
        remainingSlots.length > 0 ? "confirm_booking" : "get_availability",
      );
      return toolOutcome(
        "error",
        remainingSlots.length > 0 ? "confirm_booking" : "get_availability",
        remainingSlots.length > 0
          ? "That slot is no longer available. Offer one of the remaining cached slots or search again."
          : "That slot is no longer available. Search availability again before booking.",
        {
          reason: "slot_unavailable",
          slotId: selectedSlot.slotId,
          cachedSlots: publicAvailabilitySlots(remainingSlots),
        },
        true,
      );
    }
    if (bookingResult.errorClass === "invalid_appointment_type") {
      clearAvailabilitySelection(state, "appointment_type_invalid");
      updateCurrentTaskStep(state, "get_availability");
      return toolOutcome(
        "error",
        "get_availability",
        "That appointment type does not match the selected lane. Recompute the lane and search availability again.",
        {
          reason: "invalid_appointment_type",
          slotId: selectedSlot.slotId,
          appointmentTypeId: params.appointmentTypeId,
        },
        true,
      );
    }
    if (
      bookingResult.errorClass === "middleware_error" ||
      (usedBookingToken && isRecord(result) && result.status === "error")
    ) {
      updateCurrentTaskStep(state, "confirm_booking");
      return toolOutcome(
        "error",
        "confirm_booking",
        "Booking did not complete. Confirm the slot again or search availability if the slot is stale.",
        {
          reason: bookingResult.errorClass ?? "booking_failed",
          slotId: selectedSlot.slotId,
        },
        true,
      );
    }
    return result;
  },
});

// --- route_to_spring_hill ---
export const route_to_spring_hill = llm.tool({
  description: `Switches the active call workflow to the Spring Hill office without transferring the caller.

Use this when the caller reached Crystal River but the visit must be handled through Spring Hill scheduling — especially pediatrics, cataract evaluation/workup/surgery scheduling, routine-vision scheduling, or insurance accepted at Spring Hill but not Crystal River. Call this before verify_patient, add_patient, update_insurance, get_availability, confirm_appt, cancel_appt, or book_appt for that visit. Keep the caller on the line and continue helping them normally.`,
  parameters: z.object({}),
  execute: async (_, { ctx }) => {
    const state = getState(ctx);
    const policyResponse = evaluatePolicyForState(
      state,
      "route_to_spring_hill",
    );
    if (policyResponse) return policyResponse;
    const springHillOffice = getSpringHillOfficePhone();
    consumeSideEffectActionForState(state, "route_to_spring_hill", {});
    clearAvailabilitySelection(state, "office_changed");
    state.officeKey = "spring-hill";
    state.amdOfficePhone = springHillOffice;
    state.flow.officeKey = "spring-hill";
    state.flow.activeFlow = "scheduling";
    state.flow.step = nextPatientFlowStep(state.flow.patientStatus);
    if (state.checkedInsuranceCoverageType === "routine_vision") {
      state.flow.visitType = "routine_vision";
      state.flow.coverageType = "routine_vision";
      state.flow.routing = "optical_only";
    }
    updateCurrentTaskStep(state, state.flow.step);
    return toolOutcome(
      "success",
      state.flow.step,
      `AMD routing switched to Spring Hill (${springHillOffice}). Continue the call without transferring.`,
      {
        officeKey: "spring-hill",
        amdOfficePhone: springHillOffice,
      },
      false,
    );
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

Use after the visit type is known when a caller asks if a plan is accepted or during new-patient registration.
Do NOT call this tool for a bare insurance question until you know whether the caller means routine vision or medical/surgical eye care. Ask whether they mean routine eye exam/glasses/contacts or medical/surgical eye care.
The medical and routine_vision lookups can return different answers for the same plan name. Use coverageType "routine_vision" only for routine eye exam, glasses prescription, or contact lens prescription using vision insurance. Use "medical" for medical/surgical eye visits.
If the caller gives a plan or family name that matches the insurance map, run this tool with that exact phrase.
Do NOT force HMO, PPO, or Medicare as a default follow-up. Only ask for that kind of clarification if this tool returns clarificationNeeded.

The tool returns a small summary for the model:
- status
- canProceed
- canonicalPlan
- clarificationNeeded
- callerMessage

If Crystal River does not accept a plan but Spring Hill does, tell the caller Spring Hill accepts it and ask if they want to schedule there. If yes, call route_to_spring_hill before verify_patient, add_patient, update_insurance, get_availability, confirm_appt, cancel_appt, or book_appt.

Use canonicalPlan for add_patient or update_insurance when canProceed=true.`,
  parameters: z.object({
    plan: z.string().describe("The insurance plan name the caller mentioned"),
    coverageType: z
      .enum(["medical", "routine_vision"])
      .optional()
      .describe(
        "medical for ophthalmology coverage; routine_vision for routine eye exam/glasses/contact lens prescription coverage.",
      ),
  }),
  execute: async ({ plan, coverageType }, { ctx }) => {
    const state = getState(ctx);
    const policyResponse = evaluatePolicyForState(state, "check_insurance", {
      plan,
      coverageType,
    });
    if (policyResponse) return policyResponse;
    const normalizedCoverageType = normalizeCoverageType(coverageType);
    const result = matchInsurancePlanForOffice(
      state.officeKey,
      plan,
      normalizedCoverageType,
    );
    state.checkedInsurancePlan = canonicalInsurancePlan(result);
    state.checkedInsuranceCoverageType = state.checkedInsurancePlan
      ? normalizedCoverageType
      : null;
    state.flow.officeKey = state.officeKey;
    state.flow.activeFlow = "insurance";
    state.flow.step =
      result.status === "accepted"
        ? nextPatientFlowStep(state.flow.patientStatus)
        : "check_insurance";
    state.flow.coverageType = state.checkedInsuranceCoverageType ?? undefined;
    if (state.checkedInsurancePlan) {
      updateActivePatientInsurance(state.flow, {
        plan,
        coverageType: state.checkedInsuranceCoverageType,
        canonicalPlan: state.checkedInsurancePlan,
        source: "caller_spoken",
      });
    }
    if (normalizedCoverageType === "routine_vision") {
      state.flow.visitType = "routine_vision";
      state.flow.routing = "optical_only";
      if (state.officeKey === "crystal-river" && result.status === "accepted") {
        state.flow.activeFlow = "routing";
        state.flow.step = "route_office";
      }
    }
    const response = buildInsuranceToolResponse(result);
    if (
      state.officeKey === "crystal-river" &&
      result.status === "not_accepted"
    ) {
      const springHillResult = matchInsurancePlanForOffice("spring-hill", plan);
      const springHillPlan = canonicalInsurancePlan(springHillResult);
      if (springHillResult.status === "accepted" && springHillPlan) {
        return normalizeInsuranceOutcome(state, {
          ...response,
          acceptedAtAlternateOffice: "Spring Hill",
          alternateCanonicalPlan: springHillPlan,
          routeTool: "route_to_spring_hill",
          callerMessage: `${response.callerMessage} Spring Hill accepts ${springHillPlan}. Ask if they'd like to schedule there, then route to Spring Hill if they agree.`,
        });
      }
    }
    return normalizeInsuranceOutcome(state, response);
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
    const state = getState(ctx);
    const turnGate = evaluateTurnUnderstandingGate(state, "lookup_knowledge");
    if (turnGate) return turnGate;
    const file = resolveKnowledgeFileForOffice(state.officeKey);
    const result = readWorkspaceFile(file);
    if (state.flow.currentTask?.kind === "faq") {
      completeCurrentTaskAndResume(state.flow);
    }
    return result;
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
      return toolOutcome(
        "success",
        "answer",
        "Already transferred. No action needed.",
        { reason: "transfer_already_started" },
        false,
      );
    }
    const policyResponse = evaluatePolicyForState(state, "transfer_call");
    if (policyResponse) return policyResponse;
    if (!makeCurrentSpeechUninterruptible(ctx)) {
      return toolOutcome(
        "not_allowed",
        "handoff",
        "Transfer was interrupted before it could start. Please confirm the transfer again.",
        { reason: "speech_interrupted" },
        true,
      );
    }
    // Wait for the transfer announcement to finish playing before initiating
    await ctx.waitForPlayout();
    if (!state.sipRoomName || !state.sipParticipantIdentity) {
      return toolOutcome(
        "error",
        "handoff",
        "Could not transfer - no active SIP session.",
        { reason: "missing_sip_session" },
        true,
      );
    }
    try {
      const handoffOfficeKey = getHandoffOfficeKey(state);
      const handoffTarget = getOfficeHandoffTarget(handoffOfficeKey);
      await getSipClient().transferSipParticipant(
        state.sipRoomName,
        state.sipParticipantIdentity,
        handoffTarget,
        {
          headers: buildCallCenterHandoffHeaders(
            state,
            handoffTarget,
            handoffOfficeKey,
          ),
          playDialtone: true,
          ringingTimeout: 20,
        },
      );
      consumeSideEffectActionForState(state, "transfer_call", {});
      state.transferred = true;
      console.log(
        `[tools] Transferred ${state.sipParticipantIdentity} to ${handoffTarget}`,
      );
      // Framework handles shutdown via close_on_disconnect when the
      // SIP participant leaves after the transfer completes.
      return toolOutcome(
        "success",
        "handoff",
        "Transfer initiated successfully.",
        {
          handoffOfficeKey,
        },
        false,
      );
    } catch (err) {
      console.error("[tools] Transfer failed:", err);
      return toolOutcome(
        "error",
        "handoff",
        "Could not transfer the call. Please try again.",
        { reason: "transfer_failed" },
        true,
      );
    }
  },
});
