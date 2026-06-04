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
  appointmentTypeId?: number;
  facility: string;
  confirmed: boolean;
}

export type StoredCallerAppointment = CallerAppointment;

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
      "For reschedules, use reschedule_appt after the caller confirms the old appointment and new slot. For cancellations, call cancel_appt only after the caller confirms the exact loaded appointment.",
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

interface RuntimeCallState {
  preCallLookup: PreCallLookupTelemetry;
  latestUserTranscript?: string | null;
  sipRoomName: string;
  sipParticipantIdentity: string;
  callId: string;
  callerPhone: string;
  trunkPhone: string;
  transferred: boolean;
}

interface OfficeSessionState {
  activeKey: OfficeKey;
  phoneOverrides: Partial<Record<OfficeKey, string>>;
}

interface PatientSessionState {
  status: PatientStatus;
  identityConfirmed: boolean;
  patientId?: string | null;
  name?: string | null;
  dob?: string | null;
  phone?: string | null;
  appointments: CallerAppointment[];
  appointmentsStatus?: AppointmentLoadStatus | null;
}

export interface InsuranceSnapshot {
  plan: string | null;
  canonicalPlan: string | null;
  coverageType: InsuranceCoverageType | null;
  currentCarrier: string | null;
}

export interface InsuranceEligibilityCheck extends InsuranceSnapshot {
  accepted: boolean;
}

interface InsuranceSessionState {
  onFile: InsuranceSnapshot | null;
  lastEligibilityCheck: InsuranceEligibilityCheck | null;
}

interface IdentitySessionState {
  preCall?: PreCallContextState;
  patient: PatientSessionState;
  patientBackend: PatientBackendRefs;
  latestBookedAppointmentId?: number;
}

interface RoutingSessionState {
  routing?: SchedulingRouting | null;
  allowedProviders: string[];
  routingAmbiguous: boolean;
  preauthRequired: boolean;
}

interface WorkflowSessionState {
  current?: RecordTurnContextArgs;
  routing: RoutingSessionState;
}

interface AvailabilitySessionState {
  slots: StoredAvailabilitySlot[];
  latestRouting?: string | null;
  bookingTokensBySlotId: Record<string, string>;
}

export interface CallState {
  office: OfficeSessionState;
  identity: IdentitySessionState;
  insurance: InsuranceSessionState;
  workflow: WorkflowSessionState;
  availability: AvailabilitySessionState;
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
  transferred: boolean;
}

export function createCanonicalCallState(
  input: InitialCallStateInput,
): CallState {
  const routing = normalizeSchedulingRouting(input.routing);
  const coverageType =
    input.checkedInsuranceCoverageType ??
    (routing === "optical_only" ? "routine_vision" : null);
  const checkedPlan = input.checkedInsurancePlan ?? input.insuranceCarrier;
  const insuranceOnFile = checkedPlan
    ? insuranceSnapshot({
        plan: checkedPlan,
        canonicalPlan: checkedPlan,
        coverageType,
        currentCarrier: input.insuranceCarrier ?? checkedPlan,
      })
    : null;
  const patientStatus: PatientStatus = input.patientId ? "matched" : "unknown";
  const state: CallState = {
    office: {
      activeKey: input.officeKey,
      phoneOverrides: {
        [input.officeKey]: input.amdOfficePhone,
      },
    },
    identity: {
      preCall: input.preCall ?? undefined,
      patient: {
        status: patientStatus,
        identityConfirmed: false,
        patientId: input.patientId,
        name: input.patientName,
        dob: input.dob,
        phone: input.phone ?? input.callerPhone,
        appointments: input.appointments,
        appointmentsStatus: input.appointmentsStatus,
      },
      patientBackend: {},
    },
    insurance: {
      onFile: insuranceOnFile,
      lastEligibilityCheck: null,
    },
    workflow: {
      routing: {
        routing,
        allowedProviders: input.allowedProviders,
        routingAmbiguous: input.routingAmbiguous,
        preauthRequired: input.preauthRequired,
      },
    },
    availability: {
      slots: input.bookableAvailabilitySlots?.length
        ? input.bookableAvailabilitySlots
        : input.lastAvailabilitySlots,
      latestRouting: input.lastAvailabilityRouting,
      bookingTokensBySlotId: {},
    },
    runtime: {
      preCallLookup: input.preCallLookup,
      latestUserTranscript: null,
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
  return state;
}

export function publicCallerAppointments(
  appointments: readonly StoredCallerAppointment[] | null | undefined,
): CallerAppointment[] {
  return (appointments ?? []).map(
    ({
      id,
      date,
      time,
      provider,
      type,
      appointmentTypeId,
      facility,
      confirmed,
    }) => ({
      id,
      date,
      time,
      provider,
      type,
      ...(appointmentTypeId !== undefined ? { appointmentTypeId } : {}),
      facility,
      confirmed,
    }),
  );
}

export function activePatientId(state: CallState): string | null {
  if (
    !state.identity.patient.identityConfirmed &&
    state.identity.patient.status !== "created"
  ) {
    return null;
  }
  return state.identity.patient.patientId ?? null;
}

export function activePatientName(state: CallState): string | null {
  return state.identity.patient.name?.trim() || null;
}

export function activePatientDob(state: CallState): string | null {
  return state.identity.patient.dob?.trim() || null;
}

export function activeAppointments(state: CallState): CallerAppointment[] {
  return [...state.identity.patient.appointments];
}

export function activeAppointmentsStatus(
  state: CallState,
): AppointmentLoadStatus | null {
  return state.identity.patient.appointmentsStatus ?? null;
}

export function insuranceOnFile(state: CallState): InsuranceSnapshot | null {
  return state.insurance.onFile;
}

export function lastInsuranceEligibilityCheck(
  state: CallState,
): InsuranceEligibilityCheck | null {
  return state.insurance.lastEligibilityCheck;
}

export function setInsuranceOnFile(
  state: CallState,
  insurance: InsuranceSnapshot | null,
): void {
  state.insurance.onFile = insurance;
}

export function setLastInsuranceEligibilityCheck(
  state: CallState,
  check: InsuranceEligibilityCheck | null,
): void {
  state.insurance.lastEligibilityCheck = check;
}

export function applyTurnContextToState(
  state: CallState,
  turn: RecordTurnContextArgs,
): void {
  const previousVisitType = currentWorkflowVisitType(state);
  state.workflow.current = turn;
  const visitType = visitTypeFromAppointmentLane(turn);
  if (!visitType || previousVisitType === visitType) return;

  clearAvailabilitySelection(state);
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
    routing: state.workflow.routing.routing ?? null,
    allowedProviders: state.workflow.routing.allowedProviders,
    routingAmbiguous: state.workflow.routing.routingAmbiguous,
    preauthRequired: state.workflow.routing.preauthRequired,
  };
}

export function activeOfficeKey(state: CallState): OfficeKey {
  return state.office.activeKey;
}

export function setActiveOfficeKey(
  state: CallState,
  officeKey: OfficeKey,
): void {
  if (state.office.activeKey === officeKey) return;
  state.office.activeKey = officeKey;
  state.insurance.lastEligibilityCheck = null;
}

export function runtimeCallerPhone(state: CallState): string {
  return state.runtime.callerPhone;
}

export function patientBackendRefs(state: CallState): PatientBackendRefs {
  return state.identity.patientBackend;
}

export function setPatientBackendRefs(
  state: CallState,
  refs: PatientBackendRefs,
): void {
  state.identity.patientBackend = {
    ...state.identity.patientBackend,
    ...refs,
  };
}

export function removeBookedAppointmentReference(
  state: CallState,
  appointmentId: number,
): void {
  if (state.identity.latestBookedAppointmentId === appointmentId) {
    delete state.identity.latestBookedAppointmentId;
  }
}

export function setLatestBookedAppointment(
  state: CallState,
  appointmentId: number,
): void {
  state.identity.latestBookedAppointmentId = appointmentId;
}

export function latestBookedAppointmentId(state: CallState): number | null {
  return state.identity.latestBookedAppointmentId ?? null;
}

export function storeAvailabilityBookingToken(
  state: CallState,
  slotId: string,
  bookingToken?: string,
): void {
  if (bookingToken?.trim()) {
    state.availability.bookingTokensBySlotId[slotId] = bookingToken.trim();
  }
}

export function availabilityBookingToken(
  state: CallState,
  slotId: string,
): string | null {
  return state.availability.bookingTokensBySlotId[slotId]?.trim() || null;
}

export function clearAvailabilitySelection(state: CallState): void {
  state.availability.slots = [];
  state.availability.latestRouting = null;
  state.availability.bookingTokensBySlotId = {};
}

export function latestAvailabilityRouting(state: CallState): string | null {
  return (
    state.availability.latestRouting ?? state.workflow.routing.routing ?? null
  );
}

export function availabilitySlotsForState(
  state: CallState,
): StoredAvailabilitySlot[] {
  return state.availability.slots;
}

export function snapshotActivePatientIdentity(
  state: CallState,
): PatientIdentitySnapshot {
  return {
    patientId: state.identity.patient.patientId,
    name: state.identity.patient.name,
    dob: state.identity.patient.dob,
  };
}

export function hasActivePatientIdentityChanged(
  state: CallState,
  previous: PatientIdentitySnapshot,
): boolean {
  return (
    changedKnownIdentityValue(
      previous.patientId,
      state.identity.patient.patientId,
    ) ||
    changedKnownIdentityValue(previous.name, state.identity.patient.name) ||
    changedKnownIdentityValue(previous.dob, state.identity.patient.dob)
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

function visitTypeFromAppointmentLane(
  turn: RecordTurnContextArgs,
): VisitType | null {
  if (turn.intent !== "schedule") return null;
  if (turn.appointmentLane === "routine_od") return "routine_vision";
  if (turn.appointmentLane === "medical_md") return "medical";
  return null;
}

export function currentWorkflowVisitType(state: CallState): VisitType | null {
  const turn = state.workflow.current;
  return turn ? visitTypeFromAppointmentLane(turn) : null;
}

export function setRoutingContext(
  state: CallState,
  routing: {
    routing?: string | null;
    allowedProviders?: string[];
    routingAmbiguous?: boolean;
    preauthRequired?: boolean;
  },
): void {
  state.workflow.routing = {
    routing: normalizeSchedulingRouting(routing.routing),
    allowedProviders: routing.allowedProviders ?? [],
    routingAmbiguous: routing.routingAmbiguous ?? false,
    preauthRequired: routing.preauthRequired ?? false,
  };
}

export function insuranceSnapshot(input: {
  plan?: string | null;
  canonicalPlan?: string | null;
  coverageType?: InsuranceCoverageType | null;
  currentCarrier?: string | null;
}): InsuranceSnapshot {
  const plan = input.plan?.trim() || input.canonicalPlan?.trim() || null;
  const canonicalPlan = input.canonicalPlan?.trim() || plan;
  return {
    plan,
    canonicalPlan,
    coverageType: input.coverageType ?? null,
    currentCarrier: input.currentCarrier?.trim() || plan,
  };
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
