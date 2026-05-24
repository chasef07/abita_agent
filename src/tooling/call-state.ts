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
  appointments: CallerAppointment[];
  appointmentCancelTokens?: Record<string, string>;
  transferred: boolean;
  transferInFlight?: boolean;
}

export function publicCallerAppointments(
  appointments: readonly StoredCallerAppointment[] | null | undefined,
): CallerAppointment[] {
  return upcomingStoredCallerAppointments(appointments).map(
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
    upcomingStoredCallerAppointments(appointments)
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

export function upcomingStoredCallerAppointments(
  appointments: readonly StoredCallerAppointment[] | null | undefined,
  now = new Date(),
): StoredCallerAppointment[] {
  return (appointments ?? []).filter((appointment) =>
    isUpcomingCallerAppointment(appointment, now),
  );
}

export function isUpcomingCallerAppointment(
  appointment: Pick<StoredCallerAppointment, "date" | "time">,
  now = new Date(),
): boolean {
  const startsAt = parseAppointmentWallClock(
    appointment.date,
    appointment.time,
  );
  if (!startsAt) return false;
  return startsAt.getTime() > easternWallClock(now).getTime();
}

const EASTERN_TIME_ZONE = "America/New_York";

function parseAppointmentWallClock(date: string, time: string): Date | null {
  const parsed = new Date(date);
  const appointmentTime = parseAppointmentTime(time);
  if (Number.isNaN(parsed.getTime()) || !appointmentTime) return null;
  return new Date(
    Date.UTC(
      parsed.getFullYear(),
      parsed.getMonth(),
      parsed.getDate(),
      appointmentTime.hour,
      appointmentTime.minute,
      0,
    ),
  );
}

function parseAppointmentTime(
  time: string,
): { hour: number; minute: number } | null {
  const match = time
    .trim()
    .match(/^(\d{1,2})(?::(\d{2}))?\s*([AaPp])\.?\s*([Mm])\.?$/);
  if (!match) return null;
  const rawHour = Number(match[1]);
  const minute = Number(match[2] ?? "0");
  if (rawHour < 1 || rawHour > 12 || minute < 0 || minute > 59) return null;

  const period = match[3].toUpperCase();
  let hour = rawHour;
  if (period === "A" && hour === 12) hour = 0;
  if (period === "P" && hour !== 12) hour += 12;
  return { hour, minute };
}

function easternWallClock(now: Date): Date {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: EASTERN_TIME_ZONE,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(now).map((part) => [part.type, Number(part.value)]),
  );
  return new Date(
    Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    ),
  );
}
