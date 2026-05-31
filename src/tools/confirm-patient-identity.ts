import { llm } from "@livekit/agents";
import { z } from "zod";
import type {
  PatientResolveResult,
  PatientResolveVerified,
} from "../clients/advancedmd-client.js";
import {
  CALLER_CANDIDATE_REF,
  type CallState,
  type PreCallContextState,
} from "../state/call-state.js";
import {
  applyResolvedPatientToState,
  resolvePatientForCall,
  restoreConfirmedPreCallCaller,
} from "./patient-state.js";
import { getState } from "./session.js";

const identityParameters = z.object({
  firstName: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Caller-provided patient first name. For a pre-call phone match, this may be the only needed field.",
    ),
  lastName: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Caller-provided patient last name. Required before middleware lookup when no pre-call match can be confirmed.",
    ),
  dob: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Caller-provided date of birth in MM/DD/YYYY format. Required before middleware lookup when no pre-call match can be confirmed.",
    ),
});

type IdentityArgs = z.infer<typeof identityParameters>;
type PreCallCandidate = PreCallContextState["candidates"][number];

export const confirm_patient_identity = llm.tool({
  description:
    "Confirm or load a patient identity for patient-specific work. " +
    "Use only identity details the caller has provided. " +
    "If the phone lookup preloaded a likely patient, the backend can confirm privately from the first name. " +
    "If pre-call identity cannot be confirmed, collect first name, last name, and DOB before calling. " +
    "This tool does not expose preloaded patient details until identity is confirmed.",
  parameters: identityParameters,
  execute: async (args, { ctx }) => {
    const state = getState(ctx);
    const identity = normalizeIdentityArgs(args);

    const preCallReply = confirmFromPreCallState(state, identity);
    if (preCallReply) return preCallReply;

    requireFullIdentity(identity);
    const result = await resolvePatientForCall(state, {
      body: {
        firstName: identity.firstName,
        lastName: identity.lastName,
        dob: identity.dob,
      },
    });
    if (result.status === "verified") {
      applyResolvedPatientToState(state, result);
      return verifiedPatientReply(result);
    }
    return patientLookupReply(result);
  },
});

function confirmFromPreCallState(
  state: CallState,
  identity: IdentityArgs,
): string | null {
  const preCall = state.preCall;
  if (!preCall) return null;

  if (preCall.status === "single_match_pending_confirmation") {
    return confirmSinglePreCallMatch(state, preCall, identity);
  }

  if (preCall.status === "multiple_matches_pending_selection") {
    return confirmMultiplePreCallMatch(state, preCall, identity);
  }

  return null;
}

function confirmSinglePreCallMatch(
  state: CallState,
  preCall: PreCallContextState,
  identity: IdentityArgs,
): string | null {
  const candidate =
    candidateByRef(preCall, preCall.selectedCandidateRef) ??
    candidateByRef(preCall, CALLER_CANDIDATE_REF);
  if (!candidate?.patientId) return null;

  if (!identity.firstName) {
    throw new llm.ToolError(
      "Ask the caller to spell the patient's first name before confirming identity.",
    );
  }

  if (namesMatch(identity.firstName, candidate.firstName)) {
    return promotePreCallCandidate(
      state,
      candidate.ref,
      "single_match_confirmed",
    );
  }

  return null;
}

function confirmMultiplePreCallMatch(
  state: CallState,
  preCall: PreCallContextState,
  identity: IdentityArgs,
): string | null {
  if (!identity.firstName) {
    throw new llm.ToolError(
      "Ask the caller to spell the patient's first name before confirming identity.",
    );
  }

  const fullMatch = findFullIdentityPreCallMatch(preCall, identity);
  if (fullMatch) {
    return promotePreCallCandidate(
      state,
      fullMatch.ref,
      "multiple_match_confirmed",
    );
  }

  const firstNameMatches = preCall.candidates.filter((candidate) =>
    namesMatch(identity.firstName, candidate.firstName),
  );
  if (firstNameMatches.length === 1 && firstNameMatches[0].patientId) {
    return promotePreCallCandidate(
      state,
      firstNameMatches[0].ref,
      "multiple_match_confirmed",
    );
  }

  return null;
}

function promotePreCallCandidate(
  state: CallState,
  candidateRef: string,
  confirmedStatus: Extract<
    PreCallContextState["status"],
    "single_match_confirmed" | "multiple_match_confirmed"
  >,
): string {
  if (!state.preCall) {
    throw new llm.ToolError("Patient identity is not preloaded.");
  }

  state.preCall.status = confirmedStatus;
  state.preCall.selectedCandidateRef = candidateRef;
  state.preCall.identityPromotion = "confirmed_by_identity_tool";
  restoreConfirmedPreCallCaller(state);

  if (!state.patient.identityConfirmed || !state.patient.patientId) {
    throw new llm.ToolError("Patient identity could not be confirmed.");
  }

  return confirmedPatientReply(state);
}

function findFullIdentityPreCallMatch(
  preCall: PreCallContextState,
  identity: IdentityArgs,
): PreCallCandidate | null {
  if (!identity.firstName || !identity.lastName || !identity.dob) return null;

  const matches = preCall.candidates.filter(
    (candidate) =>
      candidate.patientId &&
      namesMatch(identity.firstName, candidate.firstName) &&
      namesMatch(identity.lastName, candidate.lastName) &&
      dobMatches(identity.dob, candidate.dob),
  );
  return matches.length === 1 ? matches[0] : null;
}

function candidateByRef(
  preCall: PreCallContextState,
  ref: string | undefined,
): PreCallCandidate | null {
  if (!ref) return null;
  return preCall.candidates.find((candidate) => candidate.ref === ref) ?? null;
}

function requireFullIdentity(identity: IdentityArgs): asserts identity is {
  firstName: string;
  lastName: string;
  dob: string;
} {
  if (!identity.firstName || !identity.lastName || !identity.dob) {
    throw new llm.ToolError(
      "Collect the patient's first name, last name, and date of birth before looking up identity.",
    );
  }
}

function normalizeIdentityArgs(args: IdentityArgs): IdentityArgs {
  return {
    firstName: args.firstName?.trim() || undefined,
    lastName: args.lastName?.trim() || undefined,
    dob: args.dob?.trim() || undefined,
  };
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

function dobMatches(
  provided: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  const providedDob = normalizeDob(provided);
  const expectedDob = normalizeDob(expected);
  return Boolean(providedDob && expectedDob && providedDob === expectedDob);
}

function normalizeDob(value: string | null | undefined): string {
  return value?.replace(/\D/g, "") ?? "";
}

function confirmedPatientReply(state: CallState): string {
  const patientName = state.patient.name?.trim() || "the patient";
  if (
    state.patient.appointmentsStatus === "found" &&
    state.patient.appointments.length > 0
  ) {
    const appointments = state.patient.appointments
      .slice(0, 3)
      .map(spokenAppointment)
      .join("; ");
    const remaining = state.patient.appointments.length - 3;
    const more = remaining > 0 ? `; and ${remaining} more` : "";
    return `Confirmed ${patientName} and loaded ${state.patient.appointments.length} appointment${state.patient.appointments.length === 1 ? "" : "s"}: ${appointments}${more}.`;
  }
  if (state.patient.appointmentsStatus === "none") {
    return `Confirmed ${patientName}. No upcoming appointments are loaded.`;
  }
  if (state.patient.appointmentsStatus === "error") {
    return `Confirmed ${patientName}, but appointments could not be loaded. Try confirming identity again before confirming or cancelling.`;
  }
  return `Confirmed ${patientName} and loaded the patient record.`;
}

function verifiedPatientReply(result: PatientResolveVerified): string {
  const patientName = result.name?.trim() || "the patient";
  if (result.appointmentsStatus === "found" && result.appointments.length > 0) {
    const appointments = result.appointments
      .slice(0, 3)
      .map(spokenAppointment)
      .join("; ");
    const remaining = result.appointments.length - 3;
    const more = remaining > 0 ? `; and ${remaining} more` : "";
    return `Found ${patientName} and loaded ${result.appointments.length} appointment${result.appointments.length === 1 ? "" : "s"}: ${appointments}${more}.`;
  }
  if (result.appointmentsStatus === "none") {
    return `Found ${patientName}. No upcoming appointments are loaded.`;
  }
  if (result.appointmentsStatus === "error") {
    return `Found ${patientName}, but appointments could not be loaded. Try confirming identity again before confirming or cancelling.`;
  }
  return `Found ${patientName} and loaded the patient record.`;
}

function patientLookupReply(result: PatientResolveResult): string {
  if (result.status === "not_found") {
    return (
      result.message ??
      "No matching patient was found. Confirm the spelling and date of birth, or register them as a new patient."
    );
  }
  if (result.status === "multiple_matches") {
    return "Multiple matching patients were found. Confirm the spelling and date of birth, then try again.";
  }
  return result.message ?? "Patient lookup failed. Try again.";
}

function spokenAppointment(
  appointment:
    | PatientResolveVerified["appointments"][number]
    | CallState["patient"]["appointments"][number],
): string {
  return [
    appointment.date,
    appointment.time ? `at ${appointment.time}` : "",
    appointment.provider ? `with ${appointment.provider}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}
