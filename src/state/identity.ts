import type {
  AppointmentLoadStatus,
  CallState,
  CallerAppointment,
  PatientIdentitySnapshot,
} from "./call-state.js";
import { resetActiveOfficeToTrunk } from "./call-lifecycle.js";
import {
  insuranceSnapshot,
  resetPatientSchedulingState,
  setInsuranceOnFile,
  setRoutingContext,
} from "./scheduling.js";

interface PatientBackendRefs {
  insPlanId?: string | null;
  respPartyId?: string | null;
}

export interface ActivePatientInput {
  status: "verified" | "created";
  patientId: string;
  name: string | null;
  dob: string | null;
  phone: string | null;
  appointments: CallerAppointment[];
  appointmentsStatus: AppointmentLoadStatus | null;
  insuranceCarrier: string | null;
  insPlanId: string | null;
  respPartyId: string | null;
  routing: string | null;
  allowedProviders: string[];
  routingAmbiguous: boolean;
  preauthRequired: boolean;
}

export function confirmPreCallSelection(
  state: CallState,
  selection: {
    candidateRef: string;
    status: "single_match_confirmed" | "multiple_match_confirmed";
    promotion: string;
  },
): void {
  const preCall = state.identity.preCall;
  if (!preCall) return;
  preCall.status = selection.status;
  preCall.selectedCandidateRef = selection.candidateRef;
  preCall.identityPromotion = selection.promotion;
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

export function activatePatient(
  state: CallState,
  patient: ActivePatientInput,
): void {
  const previous = snapshotActivePatientIdentity(state);
  if (identityDiffers(previous, patient)) {
    resetPatientScopedWork(state);
  }

  setPatientBackendRefs(state, {
    insPlanId: patient.insPlanId,
    respPartyId: patient.respPartyId,
  });
  state.identity.patient = {
    ...state.identity.patient,
    status: patient.status,
    identityConfirmed: true,
    patientId: patient.patientId,
    name: patient.name,
    dob: patient.dob,
    phone: patient.phone,
    appointments: patient.appointments,
    appointmentsStatus: patient.appointmentsStatus,
  };
  setInsuranceOnFile(
    state,
    patient.insuranceCarrier
      ? insuranceSnapshot({
          plan: patient.insuranceCarrier,
          canonicalPlan: patient.insuranceCarrier,
          coverageType:
            patient.routing === "optical_only" ? "routine_vision" : null,
          currentCarrier: patient.insuranceCarrier,
        })
      : null,
  );
  setRoutingContext(state, patient);
}

export function beginNewPatientRegistration(state: CallState): void {
  resetPatientScopedWork(state, { preserveEligibilityCheck: true });
  setInsuranceOnFile(state, null);
  setPatientBackendRefs(state, {
    insPlanId: null,
    respPartyId: null,
  });
  state.identity.patient = {
    ...state.identity.patient,
    status: "new",
    identityConfirmed: false,
    patientId: null,
    name: null,
    dob: null,
    appointments: [],
    appointmentsStatus: null,
  };
}

export function resetPatientScopedWork(
  state: CallState,
  options: { preserveEligibilityCheck?: boolean } = {},
): void {
  resetPatientSchedulingState(state, options);
  delete state.identity.latestBookedAppointmentId;
  resetActiveOfficeToTrunk(state);
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

function identityDiffers(
  previous: PatientIdentitySnapshot,
  next: Pick<ActivePatientInput, "patientId" | "name" | "dob">,
): boolean {
  if (sameKnownIdentityValue(previous.patientId, next.patientId)) return false;
  return (
    changedKnownIdentityValue(previous.patientId, next.patientId) ||
    changedKnownIdentityValue(previous.name, next.name) ||
    changedKnownIdentityValue(previous.dob, next.dob)
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

function sameKnownIdentityValue(
  previous: string | null | undefined,
  next: string | null | undefined,
): boolean {
  const normalizedPrevious = normalizeIdentityValue(previous);
  const normalizedNext = normalizeIdentityValue(next);
  return Boolean(
    normalizedPrevious &&
    normalizedNext &&
    normalizedPrevious === normalizedNext,
  );
}

function normalizeIdentityValue(value: string | null | undefined): string {
  return value?.trim().toLowerCase().replace(/\s+/g, " ") ?? "";
}
