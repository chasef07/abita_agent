import { tool } from "@livekit/agents";
import { z } from "zod";
import type {
  PatientResolveResult,
  PatientResolveVerified,
} from "../clients/advancedmd-client.js";
import {
  dobMatches,
  matchCandidatesByFirstName,
  namesMatch,
} from "../identity/name-matcher.js";
import {
  activatePreloadedCandidate,
  candidateDisplayName,
  findFullIdentityPreCallMatch,
  lastNameAndDobMatchCandidate,
  type FullIdentity,
} from "../identity/preloaded-patient.js";
import {
  insuranceOnFile,
  resetPatientScopedBookingState,
  setPatientBackendRefs,
  type CallState,
  type PreCallContextState,
} from "../state/call-state.js";
import {
  applyResolvedPatientToState,
  resolvePatientForCall,
} from "./patient-state.js";
import { getState } from "./session.js";

const resolvePatientParameters = z.object({
  firstName: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Caller-provided patient first name. Use this alone when matching a preloaded patient from the phone lookup.",
    ),
  lastName: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Caller-provided patient last name. Include with DOB for existing-patient lookup.",
    ),
  dob: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Caller-provided date of birth in MM/DD/YYYY format. Include with first and last name for existing-patient lookup.",
    ),
  registrationStatus: z
    .enum(["registered_before", "not_registered", "unsure"])
    .optional()
    .describe(
      "Set when the caller answers whether the patient has already registered with the practice.",
    ),
});

type ResolvePatientArgs = z.infer<typeof resolvePatientParameters>;
type NormalizedResolvePatientArgs = Partial<ResolvePatientArgs>;

export const resolve_patient = tool({
  name: "resolve_patient",
  description:
    "Resolve who the patient is before patient-specific work. " +
    "Use only identity details the caller has provided. " +
    "For phone lookup matches, pass the caller-provided firstName and this tool will deterministically match or switch the active preloaded patient. " +
    "For existing patients not resolved from phone lookup, collect firstName, lastName, and DOB before calling. " +
    "When the caller says the patient has not registered with us before, call with registrationStatus not_registered before add_patient. " +
    "If internal state says the correct patient is already active, do not call this tool again unless the caller clearly asks about another patient.",
  parameters: resolvePatientParameters,
  execute: async (args, { ctx }) => {
    const state = getState(ctx);
    const identity = normalizeResolvePatientArgs(args);

    if (identity.registrationStatus === "not_registered") {
      const activePatientReply = activePatientBlocksNewChartReply(
        state,
        identity,
      );
      if (activePatientReply) return activePatientReply;
      return markNewChartPath(state);
    }

    const preCallReply = resolveFromPreCallState(state, identity);
    if (preCallReply) return preCallReply;

    if (
      identity.registrationStatus === "registered_before" &&
      !hasFullIdentity(identity)
    ) {
      return "Collect the patient's first name, last name, and date of birth, then call resolve_patient again.";
    }

    if (!hasFullIdentity(identity)) {
      return missingIdentityReply(state, identity);
    }

    if (identityTargetsDifferentPatient(state, identity)) {
      resetPatientScopedBookingState(state);
    }

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
    if (result.status === "not_found") {
      const preCallClarification = preCallNameMismatchReply(state, identity);
      if (preCallClarification) return preCallClarification;
    }
    return patientLookupReply(result);
  },
});

function resolveFromPreCallState(
  state: CallState,
  identity: NormalizedResolvePatientArgs,
): string | null {
  const preCall = state.identity.preCall;
  if (state.identity.patient.status === "new") return null;
  if (!preCall || preCall.candidates.length === 0 || !identity.firstName) {
    return null;
  }

  if (hasFullIdentity(identity)) {
    const fullMatch = findFullIdentityPreCallMatch(preCall, identity);
    if (!fullMatch) return null;
    return activatePreCallMatch(state, fullMatch);
  }

  const match = matchCandidatesByFirstName(
    identity.firstName,
    preCall.candidates.filter((candidate) => candidate.patientId),
    (candidate) => candidate.firstName,
  );

  if (match.status === "no_match") return null;
  if (match.status === "ambiguous") {
    return "More than one preloaded patient matched that first name. Ask for the patient's date of birth, then call resolve_patient with first name, last name, and DOB.";
  }

  return activatePreCallMatch(state, match.candidate);
}

function activatePreCallMatch(
  state: CallState,
  candidate: PreCallContextState["candidates"][number],
): string {
  const activePatientId = state.identity.patient.patientId?.trim() || null;
  const wasConfirmedActive =
    state.identity.patient.identityConfirmed &&
    Boolean(activePatientId) &&
    activePatientId === candidate.patientId;
  const hadDifferentActivePatient =
    state.identity.patient.identityConfirmed && !wasConfirmedActive;

  if (wasConfirmedActive) {
    return `${candidateDisplayName(candidate)} is already the active patient. Continue with loaded patient state.`;
  }

  activatePreloadedCandidate(
    state,
    candidate,
    hadDifferentActivePatient
      ? "switched_by_identity_tool"
      : "confirmed_by_identity_tool",
  );

  if (hadDifferentActivePatient) {
    return `Switched active patient to ${candidateDisplayName(candidate)}. Check availability again before booking.`;
  }

  return confirmedPatientReply(state);
}

function preCallNameMismatchReply(
  state: CallState,
  identity: FullIdentity,
): string | null {
  const preCall = state.identity.preCall;
  if (preCall?.status !== "single_match_pending_confirmation") return null;

  const matchingLastNameAndDob = preCall.candidates.some((candidate) =>
    lastNameAndDobMatchCandidate(candidate, identity),
  );
  if (!matchingLastNameAndDob) return null;
  return "I found a record with that last name and date of birth, but the first name does not match what I heard. Could you spell the patient's first name?";
}

function activePatientBlocksNewChartReply(
  state: CallState,
  identity: NormalizedResolvePatientArgs,
): string | null {
  if (!state.identity.patient.identityConfirmed) return null;
  if (identityTargetsDifferentPatient(state, identity)) return null;
  const patientName =
    state.identity.patient.name?.trim() || "the active patient";
  return `${patientName} is already loaded as an existing patient. Continue with the loaded patient state instead of creating a new chart.`;
}

function identityTargetsDifferentPatient(
  state: CallState,
  identity: NormalizedResolvePatientArgs,
): boolean {
  const activeDob = state.identity.patient.dob;
  if (identity.dob && activeDob && !dobMatches(identity.dob, activeDob)) {
    return true;
  }

  const activeName = activePatientNameParts(state.identity.patient.name);
  if (!activeName) return false;
  if (
    identity.firstName &&
    !matchesAnyNamePart(identity.firstName, activeName.firstNames)
  ) {
    return true;
  }
  if (
    identity.lastName &&
    !matchesAnyNamePart(identity.lastName, activeName.lastNames)
  ) {
    return true;
  }
  return false;
}

function activePatientNameParts(
  name: string | null | undefined,
): { firstNames: string[]; lastNames: string[] } | null {
  const trimmed = name?.trim();
  if (!trimmed) return null;

  const [commaLastName, commaFirstAndMiddle] = trimmed
    .split(",", 2)
    .map((part) => part.trim())
    .filter(Boolean);
  if (commaLastName && commaFirstAndMiddle) {
    const firstParts = commaFirstAndMiddle.match(/[A-Za-z]+/g) ?? [];
    const lastParts = commaLastName.match(/[A-Za-z]+/g) ?? [];
    return {
      firstNames: uniqueNameParts([firstParts[0], firstParts.join(" ")]),
      lastNames: uniqueNameParts([
        commaLastName,
        lastParts[lastParts.length - 1],
      ]),
    };
  }

  const parts = trimmed.match(/[A-Za-z]+/g) ?? [];
  if (parts.length === 0) return null;

  return {
    firstNames: uniqueNameParts([
      parts[0],
      parts.length > 1 ? parts.slice(0, -1).join(" ") : parts[0],
    ]),
    lastNames: uniqueNameParts([
      parts[parts.length - 1],
      parts.length > 1 ? parts.slice(1).join(" ") : parts[0],
    ]),
  };
}

function matchesAnyNamePart(
  provided: string,
  candidates: readonly string[],
): boolean {
  return candidates.some((candidate) => namesMatch(provided, candidate));
}

function uniqueNameParts(parts: Array<string | undefined>): string[] {
  return parts.filter(
    (part, index): part is string =>
      Boolean(part?.trim()) && parts.indexOf(part) === index,
  );
}

function markNewChartPath(state: CallState): string {
  resetPatientScopedBookingState(state, { preserveEligibilityCheck: true });
  state.insurance.onFile = null;
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
  return "New-chart path confirmed. Continue registration and call add_patient only after read-back confirmation.";
}

function missingIdentityReply(
  state: CallState,
  identity: NormalizedResolvePatientArgs,
): string {
  if (identity.registrationStatus === "unsure") {
    return "Collect the patient's first name, last name, and date of birth so I can check for an existing record.";
  }
  if (identity.firstName) {
    return "Collect the patient's last name and date of birth, then call resolve_patient again.";
  }
  if (state.identity.preCall?.status === "no_match") {
    return "Collect the patient's first name, last name, and date of birth to check for an existing record. If the caller already said the patient is not registered with us, call resolve_patient with registrationStatus not_registered.";
  }
  return "Ask who the appointment is for. If the patient is not preloaded from the phone lookup, collect first name, last name, and date of birth.";
}

function hasFullIdentity(
  identity: NormalizedResolvePatientArgs,
): identity is FullIdentity {
  return Boolean(identity.firstName && identity.lastName && identity.dob);
}

function normalizeResolvePatientArgs(
  args: ResolvePatientArgs,
): NormalizedResolvePatientArgs {
  return {
    firstName: args.firstName?.trim() || undefined,
    lastName: args.lastName?.trim() || undefined,
    dob: args.dob?.trim() || undefined,
    registrationStatus: args.registrationStatus,
  };
}

function verifiedPatientReply(result: PatientResolveVerified): string {
  const patientName = result.name?.trim() || "the patient";
  const prefix = verifiedExistingPatientPrefix(
    patientName,
    result.insuranceCarrier,
  );
  if (result.appointmentsStatus === "found" && result.appointments.length > 0) {
    const appointments = result.appointments
      .slice(0, 3)
      .map(spokenAppointment)
      .join("; ");
    const remaining = result.appointments.length - 3;
    const more = remaining > 0 ? `; and ${remaining} more` : "";
    return `${prefix} Loaded ${result.appointments.length} appointment${result.appointments.length === 1 ? "" : "s"}: ${appointments}${more}.`;
  }
  if (result.appointmentsStatus === "none") {
    return `${prefix} No upcoming appointments are loaded.`;
  }
  if (result.appointmentsStatus === "error") {
    return `${prefix} Appointments could not be loaded. Try confirming identity again before confirming or cancelling.`;
  }
  return `${prefix} Patient record is loaded.`;
}

function confirmedPatientReply(state: CallState): string {
  const patientName = state.identity.patient.name?.trim() || "the patient";
  const insurance = insuranceOnFile(state);
  const prefix = verifiedExistingPatientPrefix(
    patientName,
    insurance?.currentCarrier ?? insurance?.canonicalPlan ?? insurance?.plan,
  );
  if (
    state.identity.patient.appointmentsStatus === "found" &&
    state.identity.patient.appointments.length > 0
  ) {
    const appointments = state.identity.patient.appointments
      .slice(0, 3)
      .map(spokenAppointment)
      .join("; ");
    const remaining = state.identity.patient.appointments.length - 3;
    const more = remaining > 0 ? `; and ${remaining} more` : "";
    return `${prefix} Loaded ${state.identity.patient.appointments.length} appointment${state.identity.patient.appointments.length === 1 ? "" : "s"}: ${appointments}${more}.`;
  }
  if (state.identity.patient.appointmentsStatus === "none") {
    return `${prefix} No upcoming appointments are loaded.`;
  }
  if (state.identity.patient.appointmentsStatus === "error") {
    return `${prefix} Appointments could not be loaded. Try confirming identity again before confirming or cancelling.`;
  }
  return `${prefix} Patient record is loaded.`;
}

function verifiedExistingPatientPrefix(
  patientName: string,
  insuranceCarrier: string | null | undefined,
): string {
  const insurance = insuranceCarrier?.trim();
  return `Verified existing patient ${patientName}. ${
    insurance
      ? `Insurance on file: ${insurance}.`
      : "No insurance is currently on file."
  }`;
}

function patientLookupReply(result: PatientResolveResult): string {
  if (result.status === "not_found") {
    return (
      result.message ??
      "No matching patient was found. Confirm the spelling and date of birth, or ask whether the patient is already registered with us."
    );
  }
  if (result.status === "multiple_matches") {
    return "Multiple matching patients were found. Confirm the spelling and date of birth, then try again.";
  }
  return result.message ?? "Patient lookup failed. Try again.";
}

function spokenAppointment(appointment: {
  date: string;
  time?: string | null;
  provider?: string | null;
}): string {
  return [
    appointment.date,
    appointment.time ? `at ${appointment.time}` : "",
    appointment.provider ? `with ${appointment.provider}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}
