import { CALLER_CANDIDATE_REF, type CallState } from "../state/call-state.js";
import { restoreConfirmedPreCallCaller } from "../tools/patient-state.js";

type PreCallCandidate = NonNullable<
  CallState["identity"]["preCall"]
>["candidates"][number];

type PreCallCandidateSelection = {
  candidate: PreCallCandidate;
  otherMentionedCandidates: PreCallCandidate[];
};

type NameSignal = {
  value: string;
  index: number;
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
  if (!isFirstNamePrompt(lastAssistantText)) return null;

  const selection =
    preCall.status === "single_match_pending_confirmation"
      ? singlePreCallCandidateSelection(preCall)
      : multiplePreCallCandidateSelection(preCall, transcript);
  const candidate = selection?.candidate ?? null;
  if (!candidate?.patientId) return null;
  if (
    preCall.status === "single_match_pending_confirmation" &&
    !candidateFirstNameMatchesTranscript(candidate, transcript)
  ) {
    return null;
  }

  preCall.status =
    preCall.status === "single_match_pending_confirmation"
      ? "single_match_confirmed"
      : "multiple_match_confirmed";
  preCall.selectedCandidateRef = candidate.ref;
  preCall.identityPromotion = "confirmed_by_transcript";
  restoreConfirmedPreCallCaller(state);

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
): PreCallCandidateSelection | null {
  const candidate =
    candidateByRef(preCall, preCall.selectedCandidateRef) ??
    candidateByRef(preCall, CALLER_CANDIDATE_REF) ??
    (preCall.candidates.length === 1 ? preCall.candidates[0] : null);
  return candidate ? { candidate, otherMentionedCandidates: [] } : null;
}

function multiplePreCallCandidateSelection(
  preCall: NonNullable<CallState["identity"]["preCall"]>,
  transcript: string,
): PreCallCandidateSelection | null {
  if (preCall.status !== "multiple_matches_pending_selection") return null;
  const mentions = mentionedPreCallCandidates(preCall, transcript);
  const firstMention = mentions[0];
  if (!firstMention) return null;

  const ambiguousFirstMention = mentions.some(
    (mention) =>
      mention.index === firstMention.index &&
      mention.candidate.ref !== firstMention.candidate.ref,
  );
  if (ambiguousFirstMention) return null;

  return {
    candidate: firstMention.candidate,
    otherMentionedCandidates: mentions
      .filter((mention) => mention.candidate.ref !== firstMention.candidate.ref)
      .map((mention) => mention.candidate),
  };
}

function candidateByRef(
  preCall: NonNullable<CallState["identity"]["preCall"]>,
  ref: string | undefined,
): PreCallCandidate | null {
  if (!ref) return null;
  return preCall.candidates.find((candidate) => candidate.ref === ref) ?? null;
}

function candidateFirstNameMatchesTranscript(
  candidate: PreCallCandidate,
  transcript: string,
): boolean {
  return candidateFirstNameMentionIndex(candidate, transcript) !== null;
}

function mentionedPreCallCandidates(
  preCall: NonNullable<CallState["identity"]["preCall"]>,
  transcript: string,
): Array<{ candidate: PreCallCandidate; index: number }> {
  return preCall.candidates
    .map((candidate) => ({
      candidate,
      index: candidateFirstNameMentionIndex(candidate, transcript),
    }))
    .filter(
      (mention): mention is { candidate: PreCallCandidate; index: number } =>
        mention.index !== null,
    )
    .sort((a, b) => a.index - b.index);
}

function candidateFirstNameMentionIndex(
  candidate: PreCallCandidate,
  transcript: string,
): number | null {
  if (!candidate.patientId || !candidate.firstName) return null;
  const matchingSignals = transcriptNameSignalSpans(transcript)
    .filter((signal) => namesMatch(signal.value, candidate.firstName))
    .map((signal) => signal.index);
  if (matchingSignals.length === 0) return null;
  return Math.min(...matchingSignals);
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

function transcriptNameSignalSpans(transcript: string): NameSignal[] {
  const signals: NameSignal[] = [];
  const full = normalizeName(transcript);
  if (full) signals.push({ value: full, index: 0 });

  const wordMatches = transcript.matchAll(/[A-Za-z]+/g);
  let spelledRun = "";
  let spelledRunIndex: number | null = null;
  for (const match of wordMatches) {
    const word = match[0];
    const index = match.index ?? 0;
    const normalized = normalizeName(word);
    if (!normalized) continue;
    if (normalized.length === 1) {
      if (spelledRunIndex === null) spelledRunIndex = index;
      spelledRun += normalized;
      continue;
    }
    if (spelledRun.length >= 2) {
      signals.push({ value: spelledRun, index: spelledRunIndex ?? index });
    }
    spelledRun = "";
    spelledRunIndex = null;
    signals.push({ value: normalized, index });
  }
  if (spelledRun.length >= 2) {
    signals.push({ value: spelledRun, index: spelledRunIndex ?? 0 });
  }

  return signals.filter((signal) => signal.value.length >= 3);
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
    "Before working on another mentioned patient, use switch_preloaded_patient to switch the active patient.",
  ].join(" ");
}

function uniqueCandidateNames(candidates: PreCallCandidate[]): string[] {
  return [
    ...new Set(
      candidates
        .map((candidate) =>
          [candidate.firstName, candidate.lastName].filter(Boolean).join(" "),
        )
        .filter(Boolean),
    ),
  ];
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
