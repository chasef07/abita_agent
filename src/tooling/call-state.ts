import type { InsuranceCoverageType } from "../insurance-rules.js";
import {
  DEFAULT_PATIENT_REF,
  type AvailabilityInvalidationReason,
  AppointmentLoadStatus,
  CallFlowState,
  CallerAppointment,
  GuardObservation,
  nextFlowEventId,
  normalizeSchedulingRouting,
  type PatientContext,
  type PreCallPatientCandidate,
  reduceFlowEvent,
} from "../flow/index.js";
import type { OfficeKey } from "../customer/profile.js";
import type { AgentToolName } from "./tool-exposure.js";

export type { CallerAppointment } from "../flow/index.js";

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

export interface CallerNoMatch {
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
  preCallLookup: PreCallLookupTelemetry;
  latestUserTranscript?: string | null;
  turnUnderstandingAppliedForTranscript?: string | null;
  dynamicToolsEnabled?: boolean;
  latestToolExposure?: {
    visibleToolNames: AgentToolName[];
    reason: string;
    refreshReason: string;
    step: CallFlowState["step"];
    activeIntent: CallFlowState["activeIntent"];
  };
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
  bookableAvailabilitySlots?: StoredAvailabilitySlot[];
  availabilitySlotSequence?: number;
  allowedProviders: string[];
  routingAmbiguous: boolean;
  preauthRequired: boolean;
  appointmentsStatus: AppointmentLoadStatus | null;
  appointments: CallerAppointment[];
  appointmentCancelTokens?: Record<string, string>;
  transferred: boolean;
  transferInFlight?: boolean;
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

export function reconcileCallStateAfterActivePatientChange(
  state: CallState,
  reason: AvailabilityInvalidationReason = "patient_changed",
): void {
  state.lastAvailabilitySlots = [];
  state.bookableAvailabilitySlots = [];
  state.availabilitySlotSequence = 0;
  state.lastAvailabilityRouting = null;
  reduceFlowEvent(state.flow, {
    id: nextFlowEventId("availability_invalidated"),
    type: "availability_invalidated",
    source: "system",
    createdAt: Date.now(),
    reason,
  });

  const patient = activeFlowPatient(state);
  if (!patient) return;

  state.patientId = patient.patientId ?? null;
  state.patientName = formatFlowPatientName(
    patient.firstName?.value,
    patient.lastName?.value,
  );
  state.dob = patient.dob?.value ?? null;
  state.appointments = [...patient.appointments];
  state.appointmentsStatus = patient.appointmentsStatus ?? null;
  state.appointmentCancelTokens = {};
  reduceFlowEvent(state.flow, {
    id: nextFlowEventId("active_patient_status"),
    type: "active_patient_status_synced",
    source: "system",
    createdAt: Date.now(),
    patientStatus: patient.status,
  });

  const insurancePlan =
    patient.insurance?.canonicalPlan ?? patient.insurance?.plan?.value ?? null;
  state.insuranceCarrier = insurancePlan;
  state.checkedInsurancePlan = insurancePlan;
  state.checkedInsuranceCoverageType = patient.insurance?.coverageType ?? null;
  state.insPlanId = null;
  state.respPartyId = null;
  state.routing = null;
  state.allowedProviders = [];
  state.routingAmbiguous = false;
  state.preauthRequired = false;
  reduceFlowEvent(state.flow, {
    id: nextFlowEventId("patient_payload"),
    type: "patient_payload_applied",
    source: "system",
    createdAt: Date.now(),
    officeKey: state.officeKey,
    coverageType: patient.insurance?.coverageType,
    insurance: insurancePlan
      ? {
          plan: insurancePlan,
          coverageType: patient.insurance?.coverageType,
          canonicalPlan: insurancePlan,
        }
      : undefined,
  });
  applyPreCallCandidateSessionDetails(state, patient);
}

function applyPreCallCandidateSessionDetails(
  state: CallState,
  patient: PatientContext,
): void {
  const candidate = selectedPreCallCandidateForPatient(state, patient);
  if (!candidate?.patientId) return;

  state.patientId = candidate.patientId;
  state.patientName = formatFlowPatientName(
    candidate.firstName ?? patient.firstName?.value,
    candidate.lastName ?? patient.lastName?.value,
  );
  state.dob = candidate.dob ?? patient.dob?.value ?? null;
  state.appointments = [...candidate.appointments];
  state.appointmentsStatus = candidate.appointmentsStatus ?? null;
  state.appointmentCancelTokens = candidate.appointmentCancelTokens ?? {};
  state.insuranceCarrier = candidate.insuranceCarrier ?? null;
  state.insPlanId = candidate.insPlanId ?? null;
  state.respPartyId = candidate.respPartyId ?? null;
  state.checkedInsurancePlan = candidate.insuranceCarrier ?? null;
  state.checkedInsuranceCoverageType =
    candidate.routing === "optical_only" ? "routine_vision" : null;
  state.routing = candidate.routing ?? null;
  state.allowedProviders = candidate.allowedProviders ?? [];
  state.routingAmbiguous = candidate.routingAmbiguous ?? false;
  state.preauthRequired = candidate.preauthRequired ?? false;
  reduceFlowEvent(state.flow, {
    id: nextFlowEventId("patient_payload"),
    type: "patient_payload_applied",
    source: "system",
    createdAt: Date.now(),
    officeKey: state.officeKey,
    routing: normalizeSchedulingRouting(state.routing),
    coverageType: state.checkedInsuranceCoverageType ?? undefined,
    visitType:
      state.checkedInsuranceCoverageType === "routine_vision"
        ? "routine_vision"
        : undefined,
    insurance: state.insuranceCarrier
      ? {
          plan: state.insuranceCarrier,
          coverageType: state.checkedInsuranceCoverageType,
          canonicalPlan: state.checkedInsurancePlan ?? state.insuranceCarrier,
        }
      : undefined,
  });
}

function selectedPreCallCandidateForPatient(
  state: CallState,
  patient: PatientContext,
): PreCallPatientCandidate | undefined {
  const preCall = state.flow.preCall;
  const selectedRef = preCall?.selectedCandidateRef;
  if (!preCall || !selectedRef || selectedRef !== patient.ref) return undefined;
  return preCall.candidates.find((candidate) => candidate.ref === selectedRef);
}

function activeFlowPatient(state: CallState): PatientContext | undefined {
  return state.flow.patients[
    state.flow.activePatientRef ?? DEFAULT_PATIENT_REF
  ];
}

function formatFlowPatientName(
  firstName: string | undefined,
  lastName: string | undefined,
): string | null {
  const fullName = [firstName, lastName]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(" ");
  return fullName || null;
}
