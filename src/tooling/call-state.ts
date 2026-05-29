import type { InsuranceCoverageType } from "../insurance-rules.js";
import {
  DEFAULT_PATIENT_REF,
  type AvailabilityInvalidationReason,
  AppointmentLoadStatus,
  CallFlowState,
  CallerAppointment,
  type CachedSlot,
  GuardObservation,
  nextFlowEventId,
  normalizeSchedulingRouting,
  type PatientContext,
  type PatientRef,
  type PreCallPatientCandidate,
  reduceFlowEvent,
  type SchedulingRouting,
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
  columnId?: number;
  profileId?: number;
  duration?: number;
  routing: string | null;
}

export interface PrivatePatientToolState {
  insPlanId?: string | null;
  respPartyId?: string | null;
  raw?: unknown;
}

export interface PrivateAppointmentToolState {
  patientRef?: PatientRef;
  appointmentId: number;
  cancelToken?: string;
  raw?: unknown;
}

export interface PrivateToolState {
  patients: Record<PatientRef, PrivatePatientToolState>;
  appointments: Record<string, PrivateAppointmentToolState>;
  availability: {
    bookingTokens: Record<string, string>;
    rawSlots: Record<string, unknown>;
    slotSequence: number;
  };
}

export interface RuntimeCallState {
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
  officePhoneOverrides?: Partial<Record<OfficeKey, string>>;
  sipRoomName: string;
  sipParticipantIdentity: string;
  callId: string;
  callerPhone: string;
  trunkPhone: string;
  transferred: boolean;
  transferAttempted?: boolean;
  transferInFlight?: boolean;
}

export interface CallState {
  flow: CallFlowState;
  private: PrivateToolState;
  runtime: RuntimeCallState;
}

export interface InitialCallStateInput {
  flow: CallFlowState;
  flowHarnessEnabled?: boolean;
  flowGuardObservations?: GuardObservation[];
  preCallLookup: PreCallLookupTelemetry;
  latestUserTranscript?: string | null;
  turnUnderstandingAppliedForTranscript?: string | null;
  dynamicToolsEnabled?: boolean;
  latestToolExposure?: RuntimeCallState["latestToolExposure"];
  lastTurnUnderstanding?: RuntimeCallState["lastTurnUnderstanding"];
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
  transferAttempted?: boolean;
  transferInFlight?: boolean;
}

export function createPrivateToolState(): PrivateToolState {
  return {
    patients: {},
    appointments: {},
    availability: {
      bookingTokens: {},
      rawSlots: {},
      slotSequence: 0,
    },
  };
}

export function createCanonicalCallState(
  input: InitialCallStateInput,
): CallState {
  const state: CallState = {
    flow: input.flow,
    private: createPrivateToolState(),
    runtime: {
      flowHarnessEnabled: input.flowHarnessEnabled,
      flowGuardObservations: input.flowGuardObservations ?? [],
      preCallLookup: input.preCallLookup,
      latestUserTranscript: input.latestUserTranscript ?? null,
      turnUnderstandingAppliedForTranscript:
        input.turnUnderstandingAppliedForTranscript ?? null,
      dynamicToolsEnabled: input.dynamicToolsEnabled,
      latestToolExposure: input.latestToolExposure,
      lastTurnUnderstanding: input.lastTurnUnderstanding,
      officePhoneOverrides: {
        [input.officeKey]: input.amdOfficePhone,
      },
      sipRoomName: input.sipRoomName,
      sipParticipantIdentity: input.sipParticipantIdentity,
      callId: input.callId,
      callerPhone: input.callerPhone,
      trunkPhone: input.trunkPhone,
      transferred: input.transferred,
      transferAttempted: input.transferAttempted,
      transferInFlight: input.transferInFlight,
    },
  };

  const patientRef = activePatientRef(state);
  setPatientBackendRefs(state, patientRef, {
    insPlanId: input.insPlanId,
    respPartyId: input.respPartyId,
  });
  setAppointmentCancelTokens(state, patientRef, input.appointmentCancelTokens);
  state.flow.routing = normalizeSchedulingRouting(input.routing);
  state.flow.allowedProviders = input.allowedProviders;
  state.flow.routingAmbiguous = input.routingAmbiguous;
  state.flow.preauthRequired = input.preauthRequired;
  state.flow.coverageType =
    input.checkedInsuranceCoverageType ?? state.flow.coverageType;

  if (input.checkedInsurancePlan || input.insuranceCarrier) {
    reduceFlowEvent(state.flow, {
      id: nextFlowEventId("active_patient_insurance"),
      type: "active_patient_insurance_updated",
      source: "system",
      createdAt: Date.now(),
      plan: input.insuranceCarrier ?? input.checkedInsurancePlan,
      coverageType: input.checkedInsuranceCoverageType,
      canonicalPlan: input.checkedInsurancePlan ?? input.insuranceCarrier,
      currentCarrier: input.insuranceCarrier,
      routing: normalizeSchedulingRouting(input.routing),
      allowedProviders: input.allowedProviders,
      routingAmbiguous: input.routingAmbiguous,
      preauthRequired: input.preauthRequired,
    });
  }

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

export function activePatientRef(state: CallState): PatientRef {
  return state.flow.activePatientRef ?? DEFAULT_PATIENT_REF;
}

export function activePatient(state: CallState): PatientContext | undefined {
  return state.flow.patients[activePatientRef(state)];
}

export function activePatientId(state: CallState): string | null {
  return activePatient(state)?.patientId ?? null;
}

export function activePatientName(state: CallState): string | null {
  const patient = activePatient(state);
  if (!patient) return null;
  return formatFlowPatientName(
    patient.firstName?.value,
    patient.lastName?.value,
  );
}

export function activePatientDob(state: CallState): string | null {
  return activePatient(state)?.dob?.value ?? null;
}

export function activeAppointments(state: CallState): CallerAppointment[] {
  return [...(activePatient(state)?.appointments ?? [])];
}

export function activeAppointmentsStatus(
  state: CallState,
): AppointmentLoadStatus | null {
  return activePatient(state)?.appointmentsStatus ?? null;
}

export function activeInsuranceContext(state: CallState): {
  plan: string | null;
  canonicalPlan: string | null;
  coverageType: InsuranceCoverageType | null;
  currentCarrier: string | null;
} {
  const insurance = activePatient(state)?.insurance;
  const plan = insurance?.plan?.value ?? insurance?.canonicalPlan ?? null;
  return {
    plan,
    canonicalPlan: insurance?.canonicalPlan ?? plan,
    coverageType: insurance?.coverageType ?? state.flow.coverageType ?? null,
    currentCarrier: insurance?.currentCarrier ?? null,
  };
}

export function activeRoutingContext(state: CallState): {
  routing: SchedulingRouting | null;
  allowedProviders: string[];
  routingAmbiguous: boolean;
  preauthRequired: boolean;
} {
  return {
    routing: state.flow.routing ?? null,
    allowedProviders: state.flow.allowedProviders ?? [],
    routingAmbiguous: state.flow.routingAmbiguous ?? false,
    preauthRequired: state.flow.preauthRequired ?? false,
  };
}

export function activeOfficeKey(state: CallState): OfficeKey {
  return state.flow.officeKey;
}

export function runtimeCallerPhone(state: CallState): string {
  return state.runtime.callerPhone;
}

export function runtimeTrunkPhone(state: CallState): string {
  return state.runtime.trunkPhone;
}

export function patientBackendRefs(
  state: CallState,
  patientRef: PatientRef = activePatientRef(state),
): PrivatePatientToolState {
  return state.private.patients[patientRef] ?? {};
}

export function setPatientBackendRefs(
  state: CallState,
  patientRef: PatientRef,
  refs: PrivatePatientToolState,
): void {
  state.private.patients[patientRef] = {
    ...(state.private.patients[patientRef] ?? {}),
    ...refs,
  };
}

export function clearPatientBackendRefs(
  state: CallState,
  patientRef: PatientRef = activePatientRef(state),
): void {
  delete state.private.patients[patientRef];
}

export function setAppointmentCancelTokens(
  state: CallState,
  patientRef: PatientRef,
  tokens: Record<string, string> | undefined,
): void {
  for (const [appointmentId, appointment] of Object.entries(
    state.private.appointments,
  )) {
    if (appointment.patientRef === patientRef) {
      delete state.private.appointments[appointmentId];
    }
  }

  for (const [appointmentId, cancelToken] of Object.entries(tokens ?? {})) {
    const numericId = Number(appointmentId);
    if (!Number.isFinite(numericId)) continue;
    state.private.appointments[appointmentId] = {
      ...(state.private.appointments[appointmentId] ?? {
        appointmentId: numericId,
      }),
      appointmentId: numericId,
      patientRef,
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
  rawSlot: unknown,
  bookingToken?: string,
): void {
  if (bookingToken?.trim()) {
    state.private.availability.bookingTokens[slotId] = bookingToken.trim();
  }
  state.private.availability.rawSlots[slotId] = rawSlot;
}

export function availabilityBookingToken(
  state: CallState,
  slotId: string,
): string | null {
  return state.private.availability.bookingTokens[slotId]?.trim() || null;
}

export function clearAvailabilityPrivateData(state: CallState): void {
  state.private.availability.bookingTokens = {};
  state.private.availability.rawSlots = {};
  state.private.availability.slotSequence = 0;
}

export function latestAvailabilityRouting(state: CallState): string | null {
  return (
    latestUsableAvailabilitySearch(state)?.routing ?? state.flow.routing ?? null
  );
}

export function availabilitySlotsForState(
  state: CallState,
): StoredAvailabilitySlot[] {
  return state.flow.availabilitySearches
    .filter((search) => search.status !== "invalidated")
    .flatMap((search) =>
      search.cachedSlots
        .filter((slot) => !search.rejectedSlotHashes.includes(slot.slotHash))
        .map((slot) => cachedSlotToStoredSlot(slot, search.routing ?? null)),
    );
}

export function lastAvailabilitySlotsForState(
  state: CallState,
): StoredAvailabilitySlot[] {
  const search = latestUsableAvailabilitySearch(state);
  const latestSlotHashes = new Set(search?.latestCachedSlotHashes);
  const slots =
    search?.latestCachedSlotHashes === undefined
      ? (search?.cachedSlots ?? [])
      : (search?.cachedSlots ?? []).filter((slot) =>
          latestSlotHashes.has(slot.slotHash),
        );
  return slots
    .filter((slot) => !search?.rejectedSlotHashes.includes(slot.slotHash))
    .map((slot) => cachedSlotToStoredSlot(slot, search?.routing ?? null));
}

export function nextAvailabilitySlotIndex(
  state: CallState,
  slots: StoredAvailabilitySlot[],
): number {
  const nextIndexFromSlots =
    Math.max(-1, ...slots.map((slot) => slotIndexFromId(slot.slotId))) + 1;
  const nextIndex = Math.max(
    state.private.availability.slotSequence,
    nextIndexFromSlots,
  );
  state.private.availability.slotSequence = nextIndex;
  return nextIndex;
}

export function reconcileCallStateAfterActivePatientChange(
  state: CallState,
  reason: AvailabilityInvalidationReason = "patient_changed",
): void {
  clearAvailabilityPrivateData(state);
  reduceFlowEvent(state.flow, {
    id: nextFlowEventId("availability_invalidated"),
    type: "availability_invalidated",
    source: "system",
    createdAt: Date.now(),
    reason,
  });

  const patient = activePatient(state);
  if (!patient) return;

  state.private.appointments = {};
  reduceFlowEvent(state.flow, {
    id: nextFlowEventId("active_patient_status"),
    type: "active_patient_status_synced",
    source: "system",
    createdAt: Date.now(),
    patientStatus: patient.status,
  });

  const insurancePlan =
    patient.insurance?.canonicalPlan ?? patient.insurance?.plan?.value ?? null;
  clearPatientBackendRefs(state, patient.ref);
  reduceFlowEvent(state.flow, {
    id: nextFlowEventId("patient_payload"),
    type: "patient_payload_applied",
    source: "system",
    createdAt: Date.now(),
    officeKey: activeOfficeKey(state),
    coverageType: patient.insurance?.coverageType,
    insurance: insurancePlan
      ? {
          plan: insurancePlan,
          coverageType: patient.insurance?.coverageType,
          canonicalPlan: insurancePlan,
          currentCarrier: patient.insurance?.currentCarrier ?? insurancePlan,
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

  setAppointmentCancelTokens(
    state,
    patient.ref,
    candidate.appointmentCancelTokens,
  );
  setPatientBackendRefs(state, patient.ref, {
    insPlanId: candidate.insPlanId ?? null,
    respPartyId: candidate.respPartyId ?? null,
  });
  const coverageType =
    candidate.routing === "optical_only" ? "routine_vision" : null;
  reduceFlowEvent(state.flow, {
    id: nextFlowEventId("patient_payload"),
    type: "patient_payload_applied",
    source: "system",
    createdAt: Date.now(),
    officeKey: activeOfficeKey(state),
    routing: normalizeSchedulingRouting(candidate.routing),
    allowedProviders: candidate.allowedProviders ?? [],
    routingAmbiguous: candidate.routingAmbiguous ?? false,
    preauthRequired: candidate.preauthRequired ?? false,
    coverageType: coverageType ?? undefined,
    visitType: coverageType === "routine_vision" ? "routine_vision" : undefined,
    insurance: candidate.insuranceCarrier
      ? {
          plan: candidate.insuranceCarrier,
          coverageType,
          canonicalPlan: candidate.insuranceCarrier,
          currentCarrier: candidate.insuranceCarrier,
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

function latestUsableAvailabilitySearch(state: CallState) {
  return [...state.flow.availabilitySearches]
    .reverse()
    .find((search) => search.status !== "invalidated");
}

function cachedSlotToStoredSlot(
  slot: CachedSlot,
  routing: SchedulingRouting | string | null,
): StoredAvailabilitySlot {
  return {
    slotId: slot.slotHash,
    spoken:
      slot.spoken ??
      [slot.date, slot.time, slot.provider ? `with ${slot.provider}` : ""]
        .filter(Boolean)
        .join(" "),
    provider: slot.provider ?? "",
    date: slot.date ?? slot.startDatetime?.split("T")[0] ?? "",
    time: slot.time ?? slot.startDatetime?.split("T")[1]?.slice(0, 5) ?? "",
    datetime: slot.startDatetime ?? "",
    columnId: slot.columnId,
    profileId: slot.profileId,
    duration: slot.duration,
    routing: slot.routing ?? routing,
  };
}

function slotIndexFromId(slotId: string): number {
  const normalized = slotId.trim().toUpperCase();
  if (/^[A-Z]$/.test(normalized)) {
    return normalized.charCodeAt(0) - "A".charCodeAt(0);
  }
  const match = normalized.match(/^SLOT_(\d+)$/);
  return match ? Number(match[1]) - 1 : -1;
}
