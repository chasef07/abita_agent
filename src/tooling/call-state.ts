import type { InsuranceCoverageType } from "../insurance-rules.js";
import type {
  CallFlowState,
  CallerAppointment,
  GuardObservation,
} from "../flow/index.js";
import type { OfficeKey } from "../customer/profile.js";
import type { AgentToolName } from "./tool-exposure.js";

export type { CallerAppointment } from "../flow/index.js";

export interface StoredCallerAppointment extends CallerAppointment {
  cancelToken?: string;
}

export type PatientAppointmentsStatus = "found" | "none" | "skipped" | "error";

export interface CallerMatch {
  status: "verified";
  patientId: string;
  name: string;
  dob: string;
  phone: string;
  insuranceCarrier: string | null;
  insPlanId: string | null;
  respPartyId: string | null;
  routing: string;
  allowedProviders: string[];
  routingAmbiguous: boolean;
  appointmentsStatus: PatientAppointmentsStatus | null;
  appointments: StoredCallerAppointment[] | null;
  lookupDurationMs?: number;
}

export interface CallerMultipleMatches {
  status: "multiple_matches";
  message: string;
  matches: Array<{ firstName: string }>;
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
  allowedProviders: string[];
  routingAmbiguous: boolean;
  preauthRequired: boolean;
  appointmentsStatus: PatientAppointmentsStatus | null;
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
