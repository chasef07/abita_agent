import {
  CALLER_CANDIDATE_REF,
  clearAvailabilitySelection,
  insuranceSnapshot,
  setInsuranceOnFile,
  setPatientBackendRefs,
  setRoutingContext,
  type CallState,
  type PreCallContextState,
} from "../state/call-state.js";
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

  state.identity.preCall.status = confirmedStatus;
  state.identity.preCall.selectedCandidateRef = selectedRef;
  state.identity.preCall.identityPromotion = reason;

  clearAvailabilitySelection(state);
  delete state.identity.latestBookedAppointmentId;
  state.insurance.lastEligibilityCheck = null;

  state.identity.patient = {
    ...state.identity.patient,
    status: "verified",
    identityConfirmed: true,
    patientId: candidate.patientId,
    name: candidateDisplayName(candidate),
    dob: candidate.dob ?? null,
    appointments: candidate.appointments,
    appointmentsStatus: candidate.appointmentsStatus ?? null,
  };

  setInsuranceOnFile(
    state,
    candidate.insuranceCarrier
      ? insuranceSnapshot({
          plan: candidate.insuranceCarrier,
          canonicalPlan: candidate.insuranceCarrier,
          coverageType:
            candidate.routing === "optical_only" ? "routine_vision" : null,
          currentCarrier: candidate.insuranceCarrier,
        })
      : null,
  );
  setPatientBackendRefs(state, {
    insPlanId: candidate.insPlanId ?? null,
    respPartyId: candidate.respPartyId ?? null,
  });
  setRoutingContext(state, {
    routing: candidate.routing,
    allowedProviders: candidate.allowedProviders,
    routingAmbiguous: candidate.routingAmbiguous,
    preauthRequired: candidate.preauthRequired,
  });
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
