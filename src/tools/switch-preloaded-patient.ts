import { llm } from "@livekit/agents";
import { z } from "zod";
import {
  clearAvailabilitySelection,
  insuranceSnapshot,
  setInsuranceOnFile,
  setPatientBackendRefs,
  setRoutingContext,
  type CallState,
  type PreCallContextState,
} from "../state/call-state.js";
import { getState } from "./session.js";

const switchPreloadedPatientParameters = z.object({
  firstName: z
    .string()
    .trim()
    .min(1)
    .describe("First name of the preloaded patient the caller wants to use."),
});

type SwitchPreloadedPatientArgs = z.infer<
  typeof switchPreloadedPatientParameters
>;
type PreCallCandidate = PreCallContextState["candidates"][number];

export const switch_preloaded_patient = llm.tool({
  description:
    "Switch the active patient to another patient already returned by the pre-call phone lookup. " +
    "Use only when the caller clearly gives the first name of another preloaded patient, such as when a parent is scheduling multiple children on the same call. " +
    "After this tool switches patients, call get_availability again before booking or rescheduling.",
  parameters: switchPreloadedPatientParameters,
  execute: async ({ firstName }: SwitchPreloadedPatientArgs, { ctx }) => {
    const state = getState(ctx);
    const candidate = uniquePreloadedCandidateByFirstName(state, firstName);
    if (candidate.status !== "matched") return candidate.reply;

    ctx.speechHandle.allowInterruptions = false;
    const activePatientId = state.identity.patient.patientId?.trim() || null;
    state.identity.preCall!.status = "multiple_match_confirmed";
    state.identity.preCall!.selectedCandidateRef = candidate.value.ref;

    if (activePatientId && activePatientId === candidate.value.patientId) {
      return `Active patient is already ${candidateDisplayName(candidate.value)}. Continue with loaded patient state.`;
    }

    state.identity.preCall!.identityPromotion = "switched_by_tool";
    applyPreloadedPatientSwitch(state, candidate.value);

    return `Switched active patient to ${candidateDisplayName(candidate.value)}. Check availability again before booking.`;
  },
});

function uniquePreloadedCandidateByFirstName(
  state: CallState,
  firstName: string,
):
  | { status: "matched"; value: PreCallCandidate & { patientId: string } }
  | { status: "not_found"; reply: string }
  | { status: "ambiguous"; reply: string } {
  const preCall = state.identity.preCall;
  if (
    !preCall ||
    preCall.source !== "phone_lookup" ||
    (preCall.status !== "multiple_matches_pending_selection" &&
      preCall.status !== "multiple_match_confirmed")
  ) {
    throw new llm.ToolError(
      "No preloaded patient candidates are available. Collect the patient's first name, last name, and date of birth, then use confirm_patient_identity.",
    );
  }

  const matches = preCall.candidates.filter(
    (candidate): candidate is PreCallCandidate & { patientId: string } =>
      Boolean(candidate.patientId) &&
      namesMatch(firstName, candidate.firstName),
  );

  if (matches.length === 1) {
    return { status: "matched", value: matches[0] };
  }

  if (matches.length > 1) {
    return {
      status: "ambiguous",
      reply:
        "More than one preloaded patient matched that first name. Collect last name and date of birth, then use confirm_patient_identity.",
    };
  }

  return {
    status: "not_found",
    reply:
      "No preloaded patient matched that first name. Collect first name, last name, and date of birth, then use confirm_patient_identity.",
  };
}

function applyPreloadedPatientSwitch(
  state: CallState,
  candidate: PreCallCandidate & { patientId: string },
): void {
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

function candidateDisplayName(candidate: PreCallCandidate): string {
  return [candidate.firstName, candidate.lastName].filter(Boolean).join(" ");
}

function namesMatch(
  provided: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  const providedName = normalizeName(provided);
  const expectedName = normalizeName(expected);
  if (!providedName || !expectedName) return false;
  if (providedName === expectedName) return true;
  return (
    providedName.length >= 3 &&
    expectedName.length >= 3 &&
    (providedName.startsWith(expectedName) ||
      expectedName.startsWith(providedName))
  );
}

function normalizeName(value: string | null | undefined): string {
  return collapseConsecutiveLetters(
    value
      ?.normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z]/g, "") ?? "",
  );
}

function collapseConsecutiveLetters(value: string): string {
  return value.replace(/(.)\1+/g, "$1");
}
