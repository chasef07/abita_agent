import type { OfficeKey } from "../customers/abita/profile.js";
import type { InsuranceCoverageType } from "../insurance-rules.js";
import type { RuntimeVoiceLanguageState } from "../tts-config.js";
import type { LightweightPatientCandidate } from "../identity/candidate.js";
import { createSchedulingState } from "../scheduling/state.js";
import type { TransferState } from "./call-lifecycle.js";
import type {
  OfficeKnowledgeLanguage,
  OfficeKnowledgeTopic,
} from "../office-knowledge.js";

export const CALLER_CANDIDATE_REF = "caller";

export type AppointmentLoadStatus = "found" | "none" | "error";
export type PreCallHydrationOutcome =
  | "verified"
  | "not_found"
  | "multiple_matches"
  | "lookup_failed"
  | "incomplete";

export interface StartupOverlapTelemetry {
  overlapped: true;
  lookupCompletedBeforeRuntimeSetup: boolean;
  runtimeSetupDurationMs: number;
}

export interface CallerAppointment {
  id: number;
  appointmentRef?: string;
  cancellationToken?: string;
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

export type CallerCandidate = LightweightPatientCandidate;

export interface CallerMultipleMatches {
  status: "multiple_matches";
  message: string;
  matches: Array<CallerMatch | CallerCandidate>;
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
  hydrationOutcome?: PreCallHydrationOutcome;
  retryable?: boolean;
  startupOverlap?: StartupOverlapTelemetry;
}

type PreCallIdentityStatus =
  | "not_attempted"
  | "single_match_pending_confirmation"
  | "single_match_confirmed"
  | "multiple_matches_pending_selection"
  | "multiple_match_confirmed"
  | "no_match"
  | "lookup_failed";

interface PreCallCandidateReference {
  ref: string;
  relationshipToCaller?: string;
}

export interface PreCallLightweightPatientCandidate extends LightweightPatientCandidate {
  ref: string;
  appointments: [];
}

export interface PreCallVerifiedPatientCandidate extends PreCallCandidateReference {
  status: "verified";
  firstName?: string;
  lastName?: string;
  dob?: string;
  patientId: string;
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

export type PreCallPatientCandidate =
  PreCallLightweightPatientCandidate | PreCallVerifiedPatientCandidate;

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

type SchedulingRouting =
  "bach_only" | "bach_licht" | "all_three" | "optical_only";

type TurnIntent = "schedule" | "change_appointment";

export type AppointmentLane = "medical_md" | "routine_od" | "not_applicable";
export type SchedulingAppointmentLane = Exclude<
  AppointmentLane,
  "not_applicable"
>;

export interface WorkflowTurnContext {
  intent: TurnIntent;
  appointmentLane: AppointmentLane;
}

export interface CompletedRescheduleState {
  status: "rescheduled" | "needs_human_cancellation";
  appointmentDescription: string;
}

export interface CompletedBookingState {
  appointmentId: number;
  appointmentDescription: string;
}

export interface CompletedCancellationState {
  patientId: string;
  appointment: CallerAppointment;
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

export type AppointmentActionStatus = "success" | "partial" | "error";

export type AppointmentActionName = "booked" | "rescheduled" | "cancelled";

export type OwnedMiddlewareFailureReason =
  | "invalid_cancellation_token"
  | "middleware_error"
  | "network_error"
  | "invalid_response"
  | "unsupported_office"
  | "cancelled";

export type OwnedMiddlewareOperation =
  | "resolvePatient"
  | "getAvailability"
  | "createPatient"
  | "bookAppointment"
  | "cancelAppointment"
  | "updateInsurance";

export interface OwnedMiddlewareFailureAnalytics {
  operation: OwnedMiddlewareOperation;
  reason: OwnedMiddlewareFailureReason;
  detail?: "missing_appointment_id";
  createdAt?: string;
}

export interface AppointmentAnalytics {
  patientName?: string;
  appointmentDate?: string;
  appointmentTime?: string;
  startDatetime?: string;
  providerName?: string;
  locationName?: string;
  appointmentTypeName?: string;
  careLane?: string;
}

export interface AppointmentActionAnalytics {
  action: AppointmentActionName;
  status: AppointmentActionStatus;
  toolName?: string;
  createdAt?: string;
  message?: string;
  appointment?: AppointmentAnalytics;
  cancelledAppointment?: AppointmentAnalytics;
}

export type AvailabilityInvalidationReason =
  | "booking_authorization_invalidated"
  | "booking_succeeded"
  | "booking_token_expired"
  | "cancellation_succeeded"
  | "office_changed"
  | "patient_context_changed"
  | "request_cancelled"
  | "reschedule_succeeded"
  | "routing_context_changed"
  | "scheduling_context_changed";

export type AvailabilityReadAnalytics =
  | {
      operation: "completed_cache_hit" | "in_flight_join" | "middleware_call";
      durationMs: number;
      createdAt?: string;
    }
  | {
      operation: "invalidation";
      reason: AvailabilityInvalidationReason;
      createdAt?: string;
    };

export type StaffTaskCategory =
  | "billing"
  | "appointments"
  | "documentation"
  | "optical"
  | "medication"
  | "referrals"
  | "other";

export type StaffTaskUrgency = "high_priority" | "normal" | "non_urgent";

export interface StaffTaskReceipt {
  category: StaffTaskCategory;
  createdAt: string;
  idempotencyKey: string;
  message: string;
  status: "created" | "duplicate";
  summary: string;
  taskId: string;
  urgency: StaffTaskUrgency;
}

export interface PatientBackendRefs {
  insPlanId?: string | null;
  respPartyId?: string | null;
}

export interface PendingPatientRegistrationIdentity {
  firstName?: string;
  lastName?: string;
  dob?: string;
}

export type PatientIdentityOutcome =
  | "verified"
  | "switched"
  | "new"
  | "not_found"
  | "multiple_matches"
  | "lookup_failed"
  | "needs_identity";

export type PatientIdentityTransitionOutcome =
  "pending" | "confirmed" | Exclude<PatientIdentityOutcome, "verified">;

export interface PatientIdentityTransitionAnalytics {
  outcome: PatientIdentityTransitionOutcome;
  source: "pre_call_phone_lookup" | "caller_transcript" | "resolve_patient";
}

export interface OfficeKnowledgeRetrievalAnalytics {
  createdAt: string;
  elapsedMs: number;
  language: OfficeKnowledgeLanguage;
  officeKey: OfficeKey;
  outcome: "matched" | "unavailable" | "skipped" | "failure";
  sectionCount: number;
  topic: OfficeKnowledgeTopic | null;
}

interface RuntimeCallState {
  endedReason?: "duration_limit";
  preCallLookup: PreCallLookupTelemetry;
  latestUserTranscript?: string | null;
  maxCallDurationMs?: number;
  sipRoomName: string;
  sipParticipantIdentity: string;
  callId: string;
  callerPhone: string;
  trunkPhone: string;
  transferState: TransferState;
  appointmentActions: AppointmentActionAnalytics[];
  availabilityReads: AvailabilityReadAnalytics[];
  knowledgeRetrievals: OfficeKnowledgeRetrievalAnalytics[];
  ownedMiddlewareFailures: OwnedMiddlewareFailureAnalytics[];
  staffTasks: StaffTaskReceipt[];
  patientIdentityOutcomes: PatientIdentityOutcome[];
  patientIdentityTransitions: PatientIdentityTransitionAnalytics[];
  voiceLanguage?: RuntimeVoiceLanguageState | null;
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
  pendingRegistration?: PendingPatientRegistrationIdentity;
  patient: PatientSessionState;
  patientBackend: PatientBackendRefs;
  operationVersion: number;
  transitionVersion: number;
  latestBookedAppointmentId?: number;
  completedBookingsByPatientId: Record<string, CompletedBookingState>;
  completedCancellations: CompletedCancellationState[];
  completedReschedulesByPatientId: Record<string, CompletedRescheduleState>;
}

interface RoutingSessionState {
  routing?: SchedulingRouting | null;
  allowedProviders: string[];
  routingAmbiguous: boolean;
  preauthRequired: boolean;
}

interface WorkflowSessionState {
  current?: WorkflowTurnContext;
  routing: RoutingSessionState;
}

interface AvailabilitySessionState {
  slots: StoredAvailabilitySlot[];
  latestRouting?: string | null;
  bookingTokensBySlotId: Record<string, string>;
  nextSlotIndex: number;
}

export interface CallState {
  office: OfficeSessionState;
  identity: IdentitySessionState;
  insurance: InsuranceSessionState;
  workflow: WorkflowSessionState;
  availability: AvailabilitySessionState;
  runtime: RuntimeCallState;
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

export function recordPatientIdentityOutcome(
  state: CallState,
  outcome: PatientIdentityOutcome,
): void {
  state.runtime.patientIdentityOutcomes.push(outcome);
}

export function recordPatientIdentityTransition(
  state: CallState,
  transition: PatientIdentityTransitionAnalytics,
): void {
  state.runtime.patientIdentityTransitions.push(transition);
}

export function patientIdentityTransitions(
  state: CallState,
): PatientIdentityTransitionAnalytics[] {
  return [...state.runtime.patientIdentityTransitions];
}

export function takePatientIdentityOutcome(
  state: CallState,
): PatientIdentityOutcome | undefined {
  return state.runtime.patientIdentityOutcomes.shift();
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
  voiceLanguage?: RuntimeVoiceLanguageState | null;
}

export function createCanonicalCallState(
  input: InitialCallStateInput,
): CallState {
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
      completedBookingsByPatientId: {},
      operationVersion: 0,
      transitionVersion: 0,
      completedCancellations: [],
      completedReschedulesByPatientId: {},
    },
    ...createSchedulingState(input),
    runtime: {
      preCallLookup: input.preCallLookup,
      latestUserTranscript: null,
      sipRoomName: input.sipRoomName,
      sipParticipantIdentity: input.sipParticipantIdentity,
      callId: input.callId,
      callerPhone: input.callerPhone,
      trunkPhone: input.trunkPhone,
      transferState: "idle",
      appointmentActions: [],
      availabilityReads: [],
      knowledgeRetrievals: [],
      ownedMiddlewareFailures: [],
      staffTasks: [],
      patientIdentityOutcomes: [],
      patientIdentityTransitions: initialPatientIdentityTransitions(
        input.preCall,
      ),
      voiceLanguage: input.voiceLanguage ?? null,
    },
  };

  setPatientBackendRefs(state, {
    insPlanId: input.insPlanId,
    respPartyId: input.respPartyId,
  });
  return state;
}

function initialPatientIdentityTransitions(
  preCall: PreCallContextState | null | undefined,
): PatientIdentityTransitionAnalytics[] {
  if (!preCall) return [];

  switch (preCall.status) {
    case "single_match_pending_confirmation":
    case "multiple_matches_pending_selection":
      return [{ outcome: "pending", source: "pre_call_phone_lookup" }];
    case "lookup_failed":
      return [{ outcome: "lookup_failed", source: "pre_call_phone_lookup" }];
    case "no_match":
      return [{ outcome: "not_found", source: "pre_call_phone_lookup" }];
    case "single_match_confirmed":
    case "multiple_match_confirmed":
      return [
        {
          outcome: "confirmed",
          source:
            preCall.identityPromotion === "confirmed_by_transcript"
              ? "caller_transcript"
              : "resolve_patient",
        },
      ];
    case "not_attempted":
      return [];
  }
}
