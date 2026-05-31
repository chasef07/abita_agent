import { CALLER_CANDIDATE_REF, type CallState } from "../state/call-state.js";
import { restoreConfirmedPreCallCaller } from "../tools/patient-state.js";

type PreCallCandidate = NonNullable<CallState["preCall"]>["candidates"][number];

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
  const preCall = state.preCall;
  if (!preCall || state.patient.identityConfirmed) return null;
  if (!isFirstNamePrompt(lastAssistantText)) return null;

  const candidate =
    preCall.status === "single_match_pending_confirmation"
      ? singlePreCallCandidate(preCall)
      : uniqueMultiplePreCallCandidate(preCall, transcript);
  if (!candidate?.patientId) return null;
  if (!candidateFirstNameMatchesTranscript(candidate, transcript)) return null;

  preCall.status =
    preCall.status === "single_match_pending_confirmation"
      ? "single_match_confirmed"
      : "multiple_match_confirmed";
  preCall.selectedCandidateRef = candidate.ref;
  preCall.identityPromotion = "confirmed_by_transcript";
  restoreConfirmedPreCallCaller(state);

  if (!state.patient.identityConfirmed) return null;

  return {
    candidateRef: candidate.ref,
    systemMessage: confirmedPatientSystemMessage(state),
  };
}

function singlePreCallCandidate(
  preCall: NonNullable<CallState["preCall"]>,
): PreCallCandidate | null {
  return (
    candidateByRef(preCall, preCall.selectedCandidateRef) ??
    candidateByRef(preCall, CALLER_CANDIDATE_REF) ??
    (preCall.candidates.length === 1 ? preCall.candidates[0] : null)
  );
}

function uniqueMultiplePreCallCandidate(
  preCall: NonNullable<CallState["preCall"]>,
  transcript: string,
): PreCallCandidate | null {
  if (preCall.status !== "multiple_matches_pending_selection") return null;
  const matches = preCall.candidates.filter((candidate) =>
    candidateFirstNameMatchesTranscript(candidate, transcript),
  );
  return matches.length === 1 ? matches[0] : null;
}

function candidateByRef(
  preCall: NonNullable<CallState["preCall"]>,
  ref: string | undefined,
): PreCallCandidate | null {
  if (!ref) return null;
  return preCall.candidates.find((candidate) => candidate.ref === ref) ?? null;
}

function candidateFirstNameMatchesTranscript(
  candidate: PreCallCandidate,
  transcript: string,
): boolean {
  if (!candidate.patientId || !candidate.firstName) return false;
  return transcriptNameSignals(transcript).some((signal) =>
    namesMatch(signal, candidate.firstName),
  );
}

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

function transcriptNameSignals(transcript: string): string[] {
  const signals = new Set<string>();
  const full = normalizeName(transcript);
  if (full) signals.add(full);

  const words = transcript.match(/[A-Za-z]+/g) ?? [];
  let spelledRun = "";
  for (const word of words) {
    const normalized = normalizeName(word);
    if (!normalized) continue;
    if (normalized.length === 1) {
      spelledRun += normalized;
      continue;
    }
    if (spelledRun.length >= 2) signals.add(spelledRun);
    spelledRun = "";
    signals.add(normalized);
  }
  if (spelledRun.length >= 2) signals.add(spelledRun);

  return [...signals].filter((signal) => signal.length >= 3);
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

function confirmedPatientSystemMessage(state: CallState): string {
  const patientName = state.patient.name?.trim() || "the patient";
  const patientId = state.patient.patientId?.trim() || "unknown";
  return [
    "Internal state: patient identity is confirmed from a pre-call phone candidate after the caller provided the patient's first name.",
    `Patient: ${patientName}.`,
    `Patient ID: ${patientId}.`,
    appointmentSummaryForSystemMessage(state),
    "Do not ask for last name or date of birth again. Continue using the loaded patient state for appointment questions, booking, or cancellation.",
  ]
    .filter(Boolean)
    .join(" ");
}

function appointmentSummaryForSystemMessage(state: CallState): string {
  if (
    state.patient.appointmentsStatus === "found" &&
    state.patient.appointments.length > 0
  ) {
    const appointments = state.patient.appointments
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
    const remaining = state.patient.appointments.length - 3;
    const more = remaining > 0 ? `; and ${remaining} more` : "";
    return `Upcoming appointments loaded: ${appointments}${more}.`;
  }
  if (state.patient.appointmentsStatus === "none") {
    return "Appointments status: none. No upcoming appointments are loaded.";
  }
  if (state.patient.appointmentsStatus === "error") {
    return "Appointments status: error. Appointments could not be loaded.";
  }
  return "Patient record is loaded.";
}
