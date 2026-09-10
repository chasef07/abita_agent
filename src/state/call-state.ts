import type { MiddlewareRequestDiagnostic } from "../clients/middleware-diagnostics.js";
import type { OfficeKey } from "../customers/abita/profile.js";
import type { InsuranceCoverageType } from "../insurance-rules.js";
import type { RuntimeVoiceLanguageState } from "../runtime/voice-language.js";
import type {
  LightweightPatientCandidate,
  PatientCandidateSet,
} from "../identity/candidate.js";
import { createSchedulingState } from "../scheduling/state.js";
import type { TransferState } from "./call-lifecycle.js";

export const CALLER_CANDIDATE_REF = "caller";

export type AppointmentLoadStatus = "found" | "none" | "error";
export interface CallerAppointment {
  id: number;
  appointmentRef?: string;
  cancellationToken?: string;
  rescheduleToken?: string;
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
}

export type CallerCandidate = LightweightPatientCandidate;

export interface CallerMultipleMatches {
  status: "multiple_matches";
  message: string;
  matches: Array<CallerMatch | CallerCandidate>;
}

interface CallerNoMatch {
  status: "no_match";
  phone: string;
  message?: string;
}

export interface CallerLookupFailed {
  status: "lookup_failed";
  phone: string;
  reason:
    | "middleware_error"
    | "network_error"
    | "invalid_response"
    | "request_rejected"
    | "unsupported_trunk";
  retryable: boolean;
}

export type PhoneLookupResult =
  | CallerMatch
  | CallerMultipleMatches
  | CallerNoMatch
  | CallerLookupFailed
  | null;

export interface PreCallLookupState {
  status: NonNullable<PhoneLookupResult>["status"] | "not_attempted";
}

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

export interface ActivePatient {
  kind: "existing" | "created";
  patientId: string;
  name: string | null;
  dob: string | null;
  phone: string | null;
  appointments: CallerAppointment[];
  appointmentsStatus: AppointmentLoadStatus | null;
  backend: PatientBackendRefs;
}

type SchedulingRouting =
  "bach_only" | "bach_licht" | "all_three" | "optical_only";

export type VisitType = "medical" | "routine_vision";

export interface CompletedRescheduleState {
  originalAppointmentRef?: string;
  replacementAppointmentRef?: string;
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
  inventoryKey?: string;
  slotId: string;
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
  | "request_rejected"
  | "unsupported_office"
  | "cancelled";

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
  externalPatientId?: string;
  oldAppointmentId?: string;
  newAppointmentId?: string;
  bookingResult?: Record<string, unknown>;
  cancellationResult?: Record<string, unknown>;
  appointment?: AppointmentAnalytics;
  cancelledAppointment?: AppointmentAnalytics;
}

export type DomainOutcomeStatus =
  "success" | "partial" | "blocked" | "ambiguous" | "failed" | "observed";

export type DomainOutcome =
  | "middleware_diagnostics"
  | AppointmentActionName
  | "insurance_update_failed"
  | "insurance_updated"
  | "patient_creation_ambiguous"
  | "patient_creation_failed"
  | "patient_creation_partial"
  | "patient_created"
  | "patient_lookup_ambiguous"
  | "patient_lookup_failed"
  | "patient_lookup_needs_identity"
  | "patient_lookup_returned_multiple"
  | "patient_new"
  | "patient_not_found"
  | "patient_switched"
  | "patient_verified"
  | "staff_task_created"
  | "staff_task_duplicate"
  | "staff_task_failed"
  | "transfer_ambiguous"
  | "transfer_blocked"
  | "transfer_failed"
  | "transfer_started";

/** An Acuity-owned fact recorded where a tool's domain result becomes known. */
export interface DomainOutcomeReceipt {
  middlewareRequests?: MiddlewareRequestDiagnostic[];
  callId: string;
  toolName: string;
  outcome: DomainOutcome;
  status: DomainOutcomeStatus;
  occurredAt: string;
  evidence?: Record<string, unknown>;
}

export type StaffTaskCategory =
  | "billing"
  | "appointments"
  | "documentation"
  | "optical"
  | "medication"
  | "referrals"
  | "other";

export interface StaffTaskReceipt {
  createdAt: string;
  idempotencyKey: string;
  status: "created" | "duplicate";
  taskId: string;
}

export interface PatientBackendRefs {
  insPlanId?: string | null;
  respPartyId?: string | null;
}

export interface RegistrationDraft {
  firstName?: string;
  lastName?: string;
  dob?: string;
}

export interface UnregisteredPatientReceipt {
  identity: Pick<Required<RegistrationDraft>, "firstName" | "dob"> &
    Pick<RegistrationDraft, "lastName">;
  lookupOperationVersion: number;
  insuranceCheckVersion: number;
}

export type PatientIdentityOutcome =
  | "verified"
  | "switched"
  | "new"
  | "not_found"
  | "multiple_matches"
  | "lookup_failed"
  | "needs_identity";

interface RuntimeCallState {
  endedReason?: "duration_limit";
  preCallLookup: PreCallLookupState;
  sipRoomName: string;
  sipParticipantIdentity: string;
  callId: string;
  callerPhone: string;
  trunkPhone: string;
  transferState: TransferState;
  outcomeReceipts: DomainOutcomeReceipt[];
  staffTasks: StaffTaskReceipt[];
  voiceLanguage?: RuntimeVoiceLanguageState | null;
}

interface OfficeSessionState {
  activeKey: OfficeKey;
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
  privateCandidates: PreCallPatientCandidate[];
  nameSearch: {
    officePhone: string;
    firstName: string;
    dob: string;
    result: PatientCandidateSet;
  } | null;
  pendingIdentity: {
    details: RegistrationDraft;
    // Present only during a caller-declared patient switch (null if no chart was active).
    previousPatientId?: string | null;
    excludePreviousPatient?: boolean;
  } | null;
  activePatient: ActivePatient | null;
  registration: RegistrationDraft | null;
  unregisteredPatientReceipt: UnregisteredPatientReceipt | null;
  operationVersion: number;
  transitionVersion: number;
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
  visitType: VisitType | null;
  routing: RoutingSessionState;
}

interface AvailabilitySessionState {
  slots: StoredAvailabilitySlot[];
  requestedStartDate?: string;
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
  return state.identity.activePatient?.patientId ?? null;
}

export function activePatientName(state: CallState): string | null {
  return state.identity.activePatient?.name?.trim() || null;
}

export function activePatientDob(state: CallState): string | null {
  return state.identity.activePatient?.dob?.trim() || null;
}

export function patientBackendRefs(state: CallState): PatientBackendRefs {
  return state.identity.activePatient?.backend ?? {};
}

export function setActivePatientBackendRefs(
  state: CallState,
  refs: PatientBackendRefs,
): void {
  const patient = state.identity.activePatient;
  if (!patient) return;
  patient.backend = { ...patient.backend, ...refs };
}

export function recordUnregisteredPatientInsuranceCheck(
  state: CallState,
): void {
  const receipt = state.identity.unregisteredPatientReceipt;
  if (receipt?.lookupOperationVersion === state.identity.operationVersion) {
    receipt.insuranceCheckVersion += 1;
  }
}

export interface InitialCallStateInput {
  preCallCandidates?: PreCallPatientCandidate[];
  activePatient?: ActivePatient | null;
  preCallLookup: PreCallLookupState;
  officeKey: OfficeKey;
  sipRoomName: string;
  sipParticipantIdentity: string;
  callId: string;
  callerPhone: string;
  trunkPhone: string;
  insuranceCarrier: string | null;
  checkedInsurancePlan: string | null;
  checkedInsuranceCoverageType: InsuranceCoverageType | null;
  routing: string | null;
  allowedProviders: string[];
  routingAmbiguous: boolean;
  preauthRequired: boolean;
  voiceLanguage?: RuntimeVoiceLanguageState | null;
}

export function createCanonicalCallState(
  input: InitialCallStateInput,
): CallState {
  const state: CallState = {
    office: {
      activeKey: input.officeKey,
    },
    identity: {
      privateCandidates: input.preCallCandidates ?? [],
      activePatient: input.activePatient ?? null,
      registration: null,
      pendingIdentity: null,
      nameSearch: null,
      unregisteredPatientReceipt: null,
      completedBookingsByPatientId: {},
      operationVersion: 0,
      transitionVersion: 0,
      completedCancellations: [],
      completedReschedulesByPatientId: {},
    },
    ...createSchedulingState(input),
    runtime: {
      preCallLookup: input.preCallLookup,
      sipRoomName: input.sipRoomName,
      sipParticipantIdentity: input.sipParticipantIdentity,
      callId: input.callId,
      callerPhone: input.callerPhone,
      trunkPhone: input.trunkPhone,
      transferState: "idle",
      outcomeReceipts: [],
      staffTasks: [],
      voiceLanguage: input.voiceLanguage ?? null,
    },
  };
  return state;
}
