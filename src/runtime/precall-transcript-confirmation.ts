import { CALLER_CANDIDATE_REF, type CallState } from "../state/call-state.js";
import { matchCandidatesByFirstName } from "../identity/name-matcher.js";
import {
  activatePreloadedCandidate,
  candidateByRef,
  candidateDisplayName,
  selectedPreCallCandidate,
  type PreCallCandidate,
} from "../identity/preloaded-patient.js";

type PreCallCandidateSelection = {
  candidate: PreCallCandidate;
  otherMentionedCandidates: PreCallCandidate[];
};

export interface PreCallTranscriptConfirmation {
  candidateRef: string;
  systemMessage: string;
}

export function confirmPreCallIdentityFromTranscript({
  state,
  transcript,
  lastAssistantText,
}: {
  state: CallState;
  transcript: string;
  lastAssistantText: string | null | undefined;
}): PreCallTranscriptConfirmation | null {
  const preCall = state.identity.preCall;
  if (!preCall || state.identity.patient.identityConfirmed) return null;
  if (state.identity.patient.status === "new") return null;
  if (!isFirstNamePrompt(lastAssistantText)) return null;

  const selection =
    preCall.status === "single_match_pending_confirmation"
      ? singlePreCallCandidateSelection(preCall, transcript)
      : multiplePreCallCandidateSelection(preCall, transcript);
  const candidate = selection?.candidate ?? null;
  if (!candidate?.patientId) return null;

  activatePreloadedCandidate(state, candidate, "confirmed_by_transcript");

  if (!state.identity.patient.identityConfirmed) return null;

  return {
    candidateRef: candidate.ref,
    systemMessage: confirmedPatientSystemMessage(
      state,
      selection?.otherMentionedCandidates ?? [],
    ),
  };
}

function singlePreCallCandidateSelection(
  preCall: NonNullable<CallState["identity"]["preCall"]>,
  transcript: string,
): PreCallCandidateSelection | null {
  const candidate =
    selectedPreCallCandidate(preCall) ??
    candidateByRef(preCall, CALLER_CANDIDATE_REF);
  if (!candidate) return null;

  const match = matchCandidatesByFirstName(
    transcript,
    [candidate],
    (item) => item.firstName,
    transcriptMatchOptions,
  );
  return match.status === "unique"
    ? { candidate: match.candidate, otherMentionedCandidates: [] }
    : null;
}

function multiplePreCallCandidateSelection(
  preCall: NonNullable<CallState["identity"]["preCall"]>,
  transcript: string,
): PreCallCandidateSelection | null {
  if (preCall.status !== "multiple_matches_pending_selection") return null;
  const match = matchCandidatesByFirstName(
    transcript,
    preCall.candidates.filter((candidate) => candidate.patientId),
    (candidate) => candidate.firstName,
    transcriptMatchOptions,
  );
  if (match.status !== "unique") return null;

  return {
    candidate: match.candidate,
    otherMentionedCandidates: match.otherCandidates,
  };
}

const transcriptMatchOptions = {
  allowEditDistance: true,
  includeFullInput: false,
};

function isFirstNamePrompt(text: string | null | undefined): boolean {
  const normalized = text?.toLowerCase() ?? "";
  if (!normalized) return false;
  if (
    normalized.includes("last name") ||
    normalized.includes("date of birth") ||
    normalized.includes("dob")
  ) {
    return false;
  }
  return (
    normalized.includes("first name") ||
    (normalized.includes("who") && normalized.includes("for"))
  );
}

function confirmedPatientSystemMessage(
  state: CallState,
  otherMentionedCandidates: PreCallCandidate[] = [],
): string {
  const patientName = state.identity.patient.name?.trim() || "the patient";
  const patientId = state.identity.patient.patientId?.trim() || "unknown";
  return [
    "Internal state: patient identity is confirmed from a pre-call phone candidate after the caller provided the patient's first name.",
    `Patient: ${patientName}.`,
    `Patient ID: ${patientId}.`,
    otherMentionedPatientsSystemMessage(patientName, otherMentionedCandidates),
    appointmentSummaryForSystemMessage(state),
    "Do not ask for last name or date of birth again. Continue using the loaded patient state for appointment questions, booking, or cancellation.",
  ]
    .filter(Boolean)
    .join(" ");
}

function otherMentionedPatientsSystemMessage(
  activePatientName: string,
  candidates: PreCallCandidate[],
): string {
  const names = uniqueCandidateNames(candidates);
  if (names.length === 0) return "";
  return [
    `Caller also mentioned preloaded patient${names.length === 1 ? "" : "s"}: ${names.join(", ")}.`,
    `Finish ${activePatientName} first.`,
    "Before working on another mentioned patient, call resolve_patient with that patient's first name to switch the active patient.",
  ].join(" ");
}

function uniqueCandidateNames(candidates: PreCallCandidate[]): string[] {
  return [...new Set(candidates.map(candidateDisplayName).filter(Boolean))];
}

function appointmentSummaryForSystemMessage(state: CallState): string {
  if (
    state.identity.patient.appointmentsStatus === "found" &&
    state.identity.patient.appointments.length > 0
  ) {
    const appointments = state.identity.patient.appointments
      .slice(0, 3)
      .map((appointment) =>
        [
          appointment.date,
          appointment.time ? `at ${appointment.time}` : "",
          appointment.provider ? `with ${appointment.provider}` : "",
        ]
          .filter(Boolean)
          .join(" "),
      )
      .join("; ");
    const remaining = state.identity.patient.appointments.length - 3;
    const more = remaining > 0 ? `; and ${remaining} more` : "";
    return `Upcoming appointments loaded: ${appointments}${more}.`;
  }
  if (state.identity.patient.appointmentsStatus === "none") {
    return "Appointments status: none. No upcoming appointments are loaded.";
  }
  if (state.identity.patient.appointmentsStatus === "error") {
    return "Appointments status: error. Appointments could not be loaded.";
  }
  return "Patient record is loaded.";
}
