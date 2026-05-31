import type { OfficeKey } from "../customer/profile.js";
import type { InsuranceCoverageType } from "../insurance-rules.js";

export const CALLER_CANDIDATE_REF = "caller";

export type AppointmentLoadStatus = "found" | "none" | "error";

export interface CallerAppointment {
  id: number;
  date: string;
  time: string;
  provider: string;
  type: string;
  facility: string;
  confirmed: boolean;
}

export interface StoredCallerAppointment extends CallerAppointment {
  cancelToken?: string;
}

export interface CallerMatch {
  status: "verified";
  patientId: string;
  name: string;
  dob: string;
  phone: string;
  insuranceCarrier: string | null;
  insPlanId: string | null;
  respPartyId: string | null;
  routing: string | null;
  allowedProviders: string[];
  routingAmbiguous: boolean;
  preauthRequired: boolean;
  appointmentsStatus?: AppointmentLoadStatus | null;
  appointmentsMessage?: string | null;
  appointments: StoredCallerAppointment[] | null;
  lookupDurationMs?: number;
}

export interface CallerMatchHint {
  firstName: string;
}

export interface CallerMultipleMatches {
  status: "multiple_matches";
  message: string;
  matches: Array<CallerMatch | CallerMatchHint>;
  lookupDurationMs?: number;
}

interface CallerNoMatch {
  status: "no_match";
  phone: string;
  message?: string;
  lookupDurationMs?: number;
}

export interface CallerLookupFailed {
  status: "lookup_failed";
  phone: string;
  reason:
    | "middleware_error"
    | "network_error"
    | "invalid_response"
    | "unsupported_trunk";
  retryable: boolean;
  lookupDurationMs?: number;
}

export type PhoneLookupResult =
  | CallerMatch
  | CallerMultipleMatches
  | CallerNoMatch
  | CallerLookupFailed
  | null;

export interface PreCallLookupTelemetry {
  status: NonNullable<PhoneLookupResult>["status"] | "not_attempted";
  durationMs: number | null;
  candidateCount?: number;
  appointmentsStatus?: AppointmentLoadStatus | null;
  failureReason?: CallerLookupFailed["reason"];
  retryable?: boolean;
}

type PreCallIdentityStatus =
  | "not_attempted"
  | "single_match_pending_confirmation"
  | "single_match_confirmed"
  | "multiple_matches_pending_selection"
  | "multiple_match_confirmed"
  | "no_match"
  | "lookup_failed";

interface PreCallPatientCandidate {
  ref: string;
  firstName?: string;
  lastName?: string;
  dob?: string;
  patientId?: string;
  relationshipToCaller?: string;
  appointments: CallerAppointment[];
  appointmentsStatus?: AppointmentLoadStatus;
  appointmentCancelTokens?: Record<string, string>;
  insuranceCarrier?: string | null;
  insPlanId?: string | null;
  respPartyId?: string | null;
  routing?: string | null;
  allowedProviders?: string[];
  routingAmbiguous?: boolean;
  preauthRequired?: boolean;
}

export interface PreCallContextState {
  status: PreCallIdentityStatus;
  source: "phone_lookup";
  callerPhone: string;
  lookupDurationMs?: number;
  failureReason?: string;
  retryable?: boolean;
  candidates: PreCallPatientCandidate[];
  selectedCandidateRef?: string;
  appointmentLoadStatus?: AppointmentLoadStatus;
  appointmentMessage?: string;
  identityPromotion?: string;
}

type PatientStatus = "unknown" | "matched" | "verified" | "new" | "created";

type VisitType = "medical" | "routine_vision";

type SchedulingRouting =
  | "bach_only"
  | "bach_licht"
  | "all_three"
  | "optical_only";

type TurnIntent = "schedule" | "change_appointment" | "question" | "transfer";

export type AppointmentLane = "medical_md" | "routine_od" | "not_applicable";

export interface RecordTurnContextArgs {
  intent: TurnIntent;
  appointmentLane: AppointmentLane;
  isEmergency: boolean;
  confidence: number;
}

export type WorkflowContextName =
  | "none"
  | "scheduling"
  | "appointment_change"
  | "general_question"
  | "human_transfer"
  | "emergency";

export interface WorkflowContextGuide {
  name: WorkflowContextName;
  guidance: string[];
}

const WORKFLOW_CONTEXT_GUIDES: Record<
  WorkflowContextName,
  WorkflowContextGuide
> = {
  none: {
    name: "none",
    guidance: [],
  },
  scheduling: {
    name: "scheduling",
    guidance: [
      "Typical path: understand the visit reason and appointment lane, identify the patient, handle insurance when needed, ask date or time preference, check availability, then book only after the caller chooses a slot.",
      "Use the appointment lane from record_turn_context to decide medical ophthalmology versus routine vision context. If the lane is unclear, ask concise clarifying questions before calling record_turn_context.",
    ],
  },
  appointment_change: {
    name: "appointment_change",
    guidance: [
      "Typical path: verify or confirm the patient, identify the exact existing appointment, then handle confirmation, cancellation, or rescheduling.",
      "For reschedules, book the new appointment before cancelling the old one. For cancellations, call cancel_appt only after the caller confirms the exact loaded appointment.",
    ],
  },
  general_question: {
    name: "general_question",
    guidance: [
      "Answer the caller's question directly, using lookup_knowledge or check_insurance when needed.",
      "Do not verify the patient unless the answer or action requires private patient data.",
    ],
  },
  human_transfer: {
    name: "human_transfer",
    guidance: [
      "If the caller asks for staff or the request needs a human, use transfer_call.",
      "For front-desk work the agent can do, offer direct help before transferring unless the caller insists.",
    ],
  },
  emergency: {
    name: "emergency",
    guidance: [
      "Treat the request as urgent and do not continue normal scheduling.",
      "Follow emergency handling and transfer to staff when appropriate.",
    ],
  },
};

export interface PatientIdentitySnapshot {
  patientId?: string | null;
  name?: string | null;
  dob?: string | null;
}

export interface StoredAvailabilitySlot {
  slotId: string;
  spoken: string;
  provider: string;
  date: string;
  time: string;
  datetime: string;
  routing: string | null;
}

interface PatientBackendRefs {
  insPlanId?: string | null;
  respPartyId?: string | null;
}

interface PrivateAppointmentToolState {
  appointmentId: number;
  cancelToken?: string;
}

interface PrivateToolState {
  patientBackend: PatientBackendRefs;
  appointments: Record<string, PrivateAppointmentToolState>;
  availability: {
    bookingTokens: Record<string, string>;
  };
}

interface RuntimeCallState {
  preCallLookup: PreCallLookupTelemetry;
  latestUserTranscript?: string | null;
  officePhoneOverrides?: Partial<Record<OfficeKey, string>>;
  sipRoomName: string;
  sipParticipantIdentity: string;
  callId: string;
  callerPhone: string;
  trunkPhone: string;
  transferred: boolean;
}

interface TurnContextSessionState {
  last?: RecordTurnContextArgs;
}

interface PatientSessionState {
  status: PatientStatus;
  identityConfirmed: boolean;
  patientId?: string | null;
  name?: string | null;
  dob?: string | null;
  phone?: string | null;
  insurance?: {
    plan?: string | null;
    canonicalPlan?: string | null;
    coverageType?: InsuranceCoverageType | null;
    currentCarrier?: string | null;
  };
  appointments: CallerAppointment[];
  appointmentsStatus?: AppointmentLoadStatus | null;
}

interface SchedulingSessionState {
  visitType?: VisitType;
  coverageType?: InsuranceCoverageType | null;
  routing?: SchedulingRouting | null;
  allowedProviders: string[];
  routingAmbiguous: boolean;
  preauthRequired: boolean;
  availabilitySlots: StoredAvailabilitySlot[];
  latestAvailabilityRouting?: string | null;
}

export interface CallState {
  officeKey: OfficeKey;
  patient: PatientSessionState;
  preCall?: PreCallContextState;
  checkedInsurance: {
    plan?: string | null;
    canonicalPlan?: string | null;
    coverageType?: InsuranceCoverageType | null;
    currentCarrier?: string | null;
  };
  scheduling: SchedulingSessionState;
  turnContext: TurnContextSessionState;
  private: PrivateToolState;
  runtime: RuntimeCallState;
}

export interface InitialCallStateInput {
  preCall?: PreCallContextState | null;
  preCallLookup: PreCallLookupTelemetry;
  officeKey: OfficeKey;
  amdOfficePhone: string;
  sipRoomName: string;
  sipParticipantIdentity: string;
  callId: string;
  callerPhone: string;
  trunkPhone: string;
  patientId: string | null;
  patientName: string | null;
  dob: string | null;
  phone?: string | null;
  insuranceCarrier: string | null;
  insPlanId: string | null;
  respPartyId: string | null;
  checkedInsurancePlan: string | null;
  checkedInsuranceCoverageType: InsuranceCoverageType | null;
  routing: string | null;
  lastAvailabilityRouting: string | null;
  lastAvailabilitySlots: StoredAvailabilitySlot[];
  bookableAvailabilitySlots?: StoredAvailabilitySlot[];
  allowedProviders: string[];
  routingAmbiguous: boolean;
  preauthRequired: boolean;
  appointmentsStatus: AppointmentLoadStatus | null;
  appointments: CallerAppointment[];
  appointmentCancelTokens?: Record<string, string>;
  transferred: boolean;
}

function createPrivateToolState(): PrivateToolState {
  return {
    patientBackend: {},
    appointments: {},
    availability: {
      bookingTokens: {},
    },
  };
}

function createTurnContextState(): TurnContextSessionState {
  return {};
}

export function createCanonicalCallState(
  input: InitialCallStateInput,
): CallState {
  const routing = normalizeSchedulingRouting(input.routing);
  const coverageType =
    input.checkedInsuranceCoverageType ??
    (routing === "optical_only" ? "routine_vision" : null);
  const checkedPlan = input.checkedInsurancePlan ?? input.insuranceCarrier;
  const patientStatus: PatientStatus = input.patientId ? "matched" : "unknown";
  const state: CallState = {
    officeKey: input.officeKey,
    patient: {
      status: patientStatus,
      identityConfirmed: false,
      patientId: input.patientId,
      name: input.patientName,
      dob: input.dob,
      phone: input.phone ?? input.callerPhone,
      insurance: checkedPlan
        ? {
            plan: checkedPlan,
            canonicalPlan: checkedPlan,
            coverageType,
            currentCarrier: input.insuranceCarrier ?? checkedPlan,
          }
        : undefined,
      appointments: input.appointments,
      appointmentsStatus: input.appointmentsStatus,
    },
    preCall: input.preCall ?? undefined,
    checkedInsurance: {
      plan: checkedPlan,
      canonicalPlan: checkedPlan,
      coverageType,
      currentCarrier: input.insuranceCarrier,
    },
    scheduling: {
      coverageType,
      routing,
      allowedProviders: input.allowedProviders,
      routingAmbiguous: input.routingAmbiguous,
      preauthRequired: input.preauthRequired,
      availabilitySlots: input.bookableAvailabilitySlots?.length
        ? input.bookableAvailabilitySlots
        : input.lastAvailabilitySlots,
      latestAvailabilityRouting: input.lastAvailabilityRouting,
    },
    turnContext: createTurnContextState(),
    private: createPrivateToolState(),
    runtime: {
      preCallLookup: input.preCallLookup,
      latestUserTranscript: null,
      officePhoneOverrides: {
        [input.officeKey]: input.amdOfficePhone,
      },
      sipRoomName: input.sipRoomName,
      sipParticipantIdentity: input.sipParticipantIdentity,
      callId: input.callId,
      callerPhone: input.callerPhone,
      trunkPhone: input.trunkPhone,
      transferred: input.transferred,
    },
  };

  setPatientBackendRefs(state, {
    insPlanId: input.insPlanId,
    respPartyId: input.respPartyId,
  });
  setAppointmentCancelTokens(state, input.appointmentCancelTokens);
  return state;
}

export function publicCallerAppointments(
  appointments: readonly StoredCallerAppointment[] | null | undefined,
): CallerAppointment[] {
  return (appointments ?? []).map(
    ({ id, date, time, provider, type, facility, confirmed }) => ({
      id,
      date,
      time,
      provider,
      type,
      facility,
      confirmed,
    }),
  );
}

export function appointmentCancelTokenMap(
  appointments: readonly StoredCallerAppointment[] | null | undefined,
): Record<string, string> {
  return Object.fromEntries(
    (appointments ?? [])
      .filter(
        (appointment) =>
          typeof appointment.id === "number" &&
          typeof appointment.cancelToken === "string" &&
          appointment.cancelToken.trim().length > 0,
      )
      .map((appointment) => [
        String(appointment.id),
        appointment.cancelToken as string,
      ]),
  );
}

export function activePatientId(state: CallState): string | null {
  if (!state.patient.identityConfirmed && state.patient.status !== "created") {
    return null;
  }
  return state.patient.patientId ?? null;
}

export function activePatientName(state: CallState): string | null {
  return state.patient.name?.trim() || null;
}

export function activePatientDob(state: CallState): string | null {
  return state.patient.dob?.trim() || null;
}

export function activeAppointments(state: CallState): CallerAppointment[] {
  return [...state.patient.appointments];
}

export function activeAppointmentsStatus(
  state: CallState,
): AppointmentLoadStatus | null {
  return state.patient.appointmentsStatus ?? null;
}

export function activeInsuranceContext(state: CallState): {
  plan: string | null;
  canonicalPlan: string | null;
  coverageType: InsuranceCoverageType | null;
  currentCarrier: string | null;
} {
  const insurance = state.patient.insurance ?? state.checkedInsurance;
  const plan = insurance.plan ?? insurance.canonicalPlan ?? null;
  return {
    plan,
    canonicalPlan: insurance.canonicalPlan ?? plan,
    coverageType:
      insurance.coverageType ?? state.scheduling.coverageType ?? null,
    currentCarrier: insurance.currentCarrier ?? null,
  };
}

export function applyTurnContextToState(
  state: CallState,
  turn: RecordTurnContextArgs,
): void {
  state.turnContext.last = turn;
}

export function workflowContextNameForTurn(
  turn: RecordTurnContextArgs,
): Exclude<WorkflowContextName, "none"> {
  if (turn.isEmergency) return "emergency";
  if (turn.intent === "schedule") return "scheduling";
  if (turn.intent === "change_appointment") return "appointment_change";
  if (turn.intent === "question") return "general_question";
  return "human_transfer";
}

export function workflowContextGuideFor(
  name: WorkflowContextName,
): WorkflowContextGuide {
  return WORKFLOW_CONTEXT_GUIDES[name];
}

export function activeRoutingContext(state: CallState): {
  routing: SchedulingRouting | null;
  allowedProviders: string[];
  routingAmbiguous: boolean;
  preauthRequired: boolean;
} {
  return {
    routing: state.scheduling.routing ?? null,
    allowedProviders: state.scheduling.allowedProviders,
    routingAmbiguous: state.scheduling.routingAmbiguous,
    preauthRequired: state.scheduling.preauthRequired,
  };
}

export function activeOfficeKey(state: CallState): OfficeKey {
  return state.officeKey;
}

export function runtimeCallerPhone(state: CallState): string {
  return state.runtime.callerPhone;
}

export function patientBackendRefs(state: CallState): PatientBackendRefs {
  return state.private.patientBackend;
}

export function setPatientBackendRefs(
  state: CallState,
  refs: PatientBackendRefs,
): void {
  state.private.patientBackend = {
    ...state.private.patientBackend,
    ...refs,
  };
}

export function setAppointmentCancelTokens(
  state: CallState,
  tokens: Record<string, string> | undefined,
): void {
  state.private.appointments = {};

  for (const [appointmentId, cancelToken] of Object.entries(tokens ?? {})) {
    const numericId = Number(appointmentId);
    if (!Number.isFinite(numericId)) continue;
    state.private.appointments[appointmentId] = {
      ...(state.private.appointments[appointmentId] ?? {
        appointmentId: numericId,
      }),
      appointmentId: numericId,
      cancelToken,
    };
  }
}

export function appointmentCancelToken(
  state: CallState,
  appointmentId: number,
): string | null {
  const token =
    state.private.appointments[String(appointmentId)]?.cancelToken?.trim();
  return token || null;
}

export function removePrivateAppointment(
  state: CallState,
  appointmentId: number,
): void {
  delete state.private.appointments[String(appointmentId)];
}

export function storeAvailabilitySlotPrivateData(
  state: CallState,
  slotId: string,
  bookingToken?: string,
): void {
  if (bookingToken?.trim()) {
    state.private.availability.bookingTokens[slotId] = bookingToken.trim();
  }
}

export function availabilityBookingToken(
  state: CallState,
  slotId: string,
): string | null {
  return state.private.availability.bookingTokens[slotId]?.trim() || null;
}

export function clearAvailabilitySelection(state: CallState): void {
  state.scheduling.availabilitySlots = [];
  state.scheduling.latestAvailabilityRouting = null;
  state.private.availability.bookingTokens = {};
}

export function latestAvailabilityRouting(state: CallState): string | null {
  return (
    state.scheduling.latestAvailabilityRouting ??
    state.scheduling.routing ??
    null
  );
}

export function availabilitySlotsForState(
  state: CallState,
): StoredAvailabilitySlot[] {
  return state.scheduling.availabilitySlots;
}

export function snapshotActivePatientIdentity(
  state: CallState,
): PatientIdentitySnapshot {
  return {
    patientId: state.patient.patientId,
    name: state.patient.name,
    dob: state.patient.dob,
  };
}

export function hasActivePatientIdentityChanged(
  state: CallState,
  previous: PatientIdentitySnapshot,
): boolean {
  return (
    changedKnownIdentityValue(previous.patientId, state.patient.patientId) ||
    changedKnownIdentityValue(previous.name, state.patient.name) ||
    changedKnownIdentityValue(previous.dob, state.patient.dob)
  );
}

export function normalizeSchedulingRouting(
  value: string | null | undefined,
): SchedulingRouting | null {
  return value === "bach_only" ||
    value === "bach_licht" ||
    value === "all_three" ||
    value === "optical_only"
    ? value
    : null;
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
