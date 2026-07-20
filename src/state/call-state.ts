import type { OfficeKey } from "../customers/abita/profile.js";
import type { InsuranceCoverageType } from "../insurance-rules.js";
import type { RimeTtsLanguageCode } from "../tts-config.js";
import { setPatientBackendRefs } from "./identity.js";
import { createSchedulingState } from "./scheduling.js";
import type { TransferState } from "./call-lifecycle.js";

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

export interface AppointmentAnalytics {
  appointmentId?: string;
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

interface PatientBackendRefs {
  insPlanId?: string | null;
  respPartyId?: string | null;
}

export interface RuntimeVoiceLanguageState {
  current: "en" | "es";
  ttsProvider: "rime";
  ttsLanguage: RimeTtsLanguageCode;
  speaker: string;
  confidence?: number;
  providerCode?: string;
  updatedAt?: string;
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
  staffTasks: StaffTaskReceipt[];
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
  patient: PatientSessionState;
  patientBackend: PatientBackendRefs;
  latestBookedAppointmentId?: number;
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
  latestSearch?: AvailabilitySearchCache;
  nextSlotIndex: number;
}

interface AvailabilitySearchCache {
  signature: string;
  response: string;
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
      staffTasks: [],
      voiceLanguage: input.voiceLanguage ?? null,
    },
  };

  setPatientBackendRefs(state, {
    insPlanId: input.insPlanId,
    respPartyId: input.respPartyId,
  });
  return state;
}
