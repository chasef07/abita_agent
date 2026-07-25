import {
  CALLER_CANDIDATE_REF,
  type CallState,
  type PreCallContextState,
} from "../state/call-state.js";
import {
  activatePatient,
  confirmPreCallSelection,
  resetPatientScopedWork,
} from "../state/identity.js";
import { dobMatches, namesMatch } from "./name-matcher.js";

export type PreCallCandidate = PreCallContextState["candidates"][number];

type ActivationReason =
  | "confirmed_by_transcript"
  | "confirmed_by_identity_tool"
  | "switched_by_identity_tool";

export type FullIdentity = {
  firstName: string;
  lastName: string;
  dob: string;
};

export function activatePreloadedCandidate(
  state: CallState,
  candidate: PreCallCandidate,
  reason: ActivationReason,
): void {
  if (!candidate.patientId || !state.identity.preCall) return;

  const selectedRef =
    candidate.ref ||
    state.identity.preCall.selectedCandidateRef ||
    CALLER_CANDIDATE_REF;
  const confirmedStatus =
    state.identity.preCall.status === "single_match_pending_confirmation" ||
    state.identity.preCall.status === "single_match_confirmed"
      ? "single_match_confirmed"
      : "multiple_match_confirmed";

  confirmPreCallSelection(state, {
    candidateRef: selectedRef,
    status: confirmedStatus,
    promotion: reason,
  });
  resetPatientScopedWork(state);
  activatePatient(state, {
    status: "verified",
    patientId: candidate.patientId,
    name: candidateDisplayName(candidate),
    dob: candidate.dob ?? null,
    phone: state.identity.patient.phone ?? state.runtime.callerPhone,
    appointments: candidate.appointments,
    appointmentsStatus: candidate.appointmentsStatus ?? null,
    insuranceCarrier: candidate.insuranceCarrier ?? null,
    insPlanId: candidate.insPlanId ?? null,
    respPartyId: candidate.respPartyId ?? null,
    routing: candidate.routing ?? null,
    allowedProviders: candidate.allowedProviders ?? [],
    routingAmbiguous: candidate.routingAmbiguous ?? false,
    preauthRequired: candidate.preauthRequired ?? false,
  });
}

export function restoreConfirmedPreCallPatient(state: CallState): void {
  const preCall = state.identity.preCall;
  if (
    preCall?.status !== "single_match_confirmed" &&
    preCall?.status !== "multiple_match_confirmed"
  ) {
    return;
  }
  const candidate = candidateByRef(
    preCall,
    preCall.selectedCandidateRef ?? CALLER_CANDIDATE_REF,
  );
  if (!candidate?.patientId) return;
  if (
    state.identity.patient.identityConfirmed ||
    state.identity.patient.status === "created"
  ) {
    return;
  }
  activatePreloadedCandidate(state, candidate, "confirmed_by_identity_tool");
}

export function selectedPreCallCandidate(
  preCall: PreCallContextState,
): PreCallCandidate | null {
  return (
    candidateByRef(preCall, preCall.selectedCandidateRef) ??
    candidateByRef(preCall, CALLER_CANDIDATE_REF) ??
    (preCall.candidates.length === 1 ? preCall.candidates[0] : null)
  );
}

export function candidateByRef(
  preCall: PreCallContextState,
  ref: string | undefined,
): PreCallCandidate | null {
  if (!ref) return null;
  return preCall.candidates.find((candidate) => candidate.ref === ref) ?? null;
}

export function findFullIdentityPreCallMatch(
  preCall: PreCallContextState,
  identity: FullIdentity,
): PreCallCandidate | null {
  const matches = preCall.candidates.filter((candidate) =>
    fullIdentityMatchesCandidate(candidate, identity),
  );
  return matches.length === 1 ? matches[0] : null;
}

export function fullIdentityMatchesCandidate(
  candidate: PreCallCandidate,
  identity: FullIdentity,
): boolean {
  return Boolean(
    candidate.patientId &&
    namesMatch(identity.firstName, candidate.firstName) &&
    namesMatch(identity.lastName, candidate.lastName) &&
    dobMatches(identity.dob, candidate.dob),
  );
}

export function lastNameAndDobMatchCandidate(
  candidate: PreCallCandidate,
  identity: Pick<FullIdentity, "lastName" | "dob">,
): boolean {
  return Boolean(
    candidate.patientId &&
    namesMatch(identity.lastName, candidate.lastName) &&
    dobMatches(identity.dob, candidate.dob),
  );
}

export function candidateDisplayName(candidate: PreCallCandidate): string {
  return [candidate.firstName, candidate.lastName].filter(Boolean).join(" ");
}
