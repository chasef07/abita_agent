import type {
  AuditIntentBucket,
  AuditToolCall,
  AuditToolCorrectness,
  BucketAuditSummary,
  CallAuditRecord,
  CallAuditReport,
  NormalizedCallEvent,
  NormalizedToolCall,
} from "./types.js";

const REQUIRED_TOOL_ARGS: Record<string, string[]> = {
  verify_patient: ["firstName"],
  add_patient: [
    "firstName",
    "lastName",
    "dob",
    "phone",
    "email",
    "street",
    "city",
    "state",
    "zip",
    "sex",
    "insurance",
    "subscriberName",
    "subscriberNum",
  ],
  update_insurance: ["insurance", "subscriberName", "subscriberNum"],
  get_availability: ["date"],
  cancel_appt: ["appointmentId"],
  book_appt: [
    "columnId",
    "profileId",
    "startDatetime",
    "duration",
    "appointmentTypeId",
  ],
  check_insurance: ["plan"],
  lookup_knowledge: ["question"],
};

const IDEAL_MAX_TURNS_BY_BUCKET: Record<AuditIntentBucket, number> = {
  new_patient: 18,
  faq: 5,
  immediate_transfer: 4,
  confirm: 6,
  cancel_rebook: 10,
  existing_patient_booking: 10,
};

export const AUDIT_INTENT_BUCKETS: AuditIntentBucket[] = [
  "new_patient",
  "faq",
  "immediate_transfer",
  "confirm",
  "cancel_rebook",
  "existing_patient_booking",
];

function parseToolArgs(args: NormalizedToolCall["args"] | string | undefined): {
  parsed: Record<string, unknown>;
  error?: string;
} {
  if (!args) return { parsed: {} };
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { parsed: parsed as Record<string, unknown> };
      }
      return { parsed: {}, error: "args JSON was not an object" };
    } catch (error) {
      return {
        parsed: {},
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  if (typeof args === "object") {
    return { parsed: args as Record<string, unknown> };
  }
  return { parsed: {}, error: "args were not an object" };
}

function isBlankValue(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim().length === 0)
  );
}

function questionFingerprint(text: string | null): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  const isQuestion =
    trimmed.includes("?") ||
    /^(what|when|where|which|who|can|could|would|do|did|have|has|is|are)\b/i.test(
      trimmed,
    );
  if (!isQuestion) return null;
  return trimmed
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function countRepeatedAssistantQuestions(
  record: NormalizedCallEvent,
): number {
  const seen = new Set<string>();
  let duplicates = 0;
  for (const turn of record.data.turns) {
    const fingerprint = questionFingerprint(turn.agentText);
    if (!fingerprint) continue;
    if (seen.has(fingerprint)) {
      duplicates += 1;
    } else {
      seen.add(fingerprint);
    }
  }
  return duplicates;
}

function transcriptText(record: NormalizedCallEvent): string {
  return record.data.turns
    .flatMap((turn) => [turn.callerText, turn.agentText])
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase();
}

function toolNames(record: NormalizedCallEvent): string[] {
  return record.data.turns.flatMap((turn) =>
    turn.toolCalls.map((toolCall) => toolCall.name),
  );
}

export function inferIntentBucket(
  record: NormalizedCallEvent,
): AuditIntentBucket | "unknown" {
  const names = toolNames(record);
  const text = transcriptText(record);

  if (names.includes("add_patient")) return "new_patient";
  if (names.includes("confirm_appt")) return "confirm";
  if (names.includes("cancel_appt")) return "cancel_rebook";
  if (text.match(/\b(cancel|reschedule|rebook)\b/)) return "cancel_rebook";
  if (
    text.match(/\b(confirm|what appointments do i have|upcoming appointment)\b/)
  )
    return "confirm";
  if (names.includes("transfer_call")) return "immediate_transfer";
  if (
    text.match(
      /\b(human|representative|billing|glasses|medical records|prescription refill|refill)\b/,
    )
  ) {
    return "immediate_transfer";
  }
  if (names.includes("book_appt") || names.includes("get_availability")) {
    return names.includes("verify_patient")
      ? "existing_patient_booking"
      : "new_patient";
  }
  if (names.includes("verify_patient")) return "existing_patient_booking";
  if (names.includes("lookup_knowledge") || names.includes("check_insurance"))
    return "faq";
  if (text.match(/\b(new patient|never been seen|first time)\b/))
    return "new_patient";
  if (text.match(/\b(seen here before|follow up|follow-up|appointment)\b/))
    return "existing_patient_booking";
  if (
    text.match(
      /\b(hours|location|address|insurance|do you accept|do you take|provider|see kids)\b/,
    )
  )
    return "faq";
  return "unknown";
}

export function extractAuditToolCalls(
  record: NormalizedCallEvent,
): AuditToolCall[] {
  return record.data.turns.flatMap((turn) =>
    turn.toolCalls.map((toolCall) => {
      const { parsed, error } = parseToolArgs(
        toolCall.args as Record<string, unknown> | string | undefined,
      );
      const required = REQUIRED_TOOL_ARGS[toolCall.name] ?? [];
      const missingRequiredArgs = required.filter((key) =>
        isBlankValue(parsed[key]),
      );
      return {
        turn: turn.turn,
        name: toolCall.name,
        args: parsed,
        argParseError: error,
        missingRequiredArgs,
        isError: toolCall.isError,
      };
    }),
  );
}

export function summarizeDeterministicToolCorrectness(
  record: NormalizedCallEvent,
  intentBucketGuess: AuditIntentBucket | "unknown",
): AuditToolCorrectness {
  const calls = extractAuditToolCalls(record);
  const malformedArgs = calls
    .filter((toolCall) => toolCall.argParseError)
    .map(
      (toolCall) =>
        `${toolCall.name} on turn ${toolCall.turn}: ${toolCall.argParseError}`,
    );
  const missingRequiredArgs = calls
    .filter((toolCall) => toolCall.missingRequiredArgs.length > 0)
    .map(
      (toolCall) =>
        `${toolCall.name} on turn ${toolCall.turn}: missing ${toolCall.missingRequiredArgs.join(", ")}`,
    );
  const sequenceIssues: string[] = [];
  const names = calls.map((toolCall) => toolCall.name);
  const firstBook = names.indexOf("book_appt");
  const firstAvailability = names.indexOf("get_availability");
  if (
    firstBook >= 0 &&
    (firstAvailability === -1 || firstBook < firstAvailability)
  ) {
    sequenceIssues.push(
      "book_appt was called before get_availability returned a slot",
    );
  }
  const transferCount = names.filter((name) => name === "transfer_call").length;
  if (transferCount > 1) {
    sequenceIssues.push(
      `transfer_call was invoked ${transferCount} times in the same call`,
    );
  }
  if (intentBucketGuess === "confirm" && !names.includes("confirm_appt")) {
    sequenceIssues.push("confirm bucket never called confirm_appt");
  }
  if (
    intentBucketGuess === "cancel_rebook" &&
    !names.includes("cancel_appt") &&
    transcriptText(record).includes("cancel")
  ) {
    sequenceIssues.push(
      "caller asked to cancel but cancel_appt was never called",
    );
  }

  const issues = [...malformedArgs, ...missingRequiredArgs, ...sequenceIssues];
  return {
    pass: issues.length === 0,
    issues,
    malformedArgs,
    missingRequiredArgs,
    sequenceIssues,
  };
}

export function computeExtraTurns(
  record: NormalizedCallEvent,
  intentBucket: AuditIntentBucket | "unknown",
): number {
  if (intentBucket === "unknown") return 0;
  const totalTurns = record.totalTurns ?? record.data.turns.length;
  return Math.max(0, totalTurns - IDEAL_MAX_TURNS_BY_BUCKET[intentBucket]);
}

export function buildCompactTranscript(record: NormalizedCallEvent): string {
  return record.data.turns
    .map((turn) => {
      const lines = [`Turn ${turn.turn}:`];
      if (turn.callerText) lines.push(`  CALLER: ${turn.callerText}`);
      if (turn.agentText) lines.push(`  AGENT: ${turn.agentText}`);
      for (const toolCall of turn.toolCalls) {
        const { parsed } = parseToolArgs(
          toolCall.args as Record<string, unknown> | string | undefined,
        );
        lines.push(
          `  TOOL: ${toolCall.name}(${JSON.stringify(parsed)})${toolCall.isError ? " [ERROR]" : ""}`,
        );
      }
      return lines.join("\n");
    })
    .join("\n");
}

export function summarizeAuditReport(
  audits: CallAuditRecord[],
  date: string,
  windowHours: number,
): CallAuditReport {
  const emptyBucketSummary = (): BucketAuditSummary => ({
    total: 0,
    resolved: 0,
    toolCorrect: 0,
    hallucinationSafe: 0,
    avgTurns: 0,
    avgDurationSec: 0,
    avgPathScore: 0,
  });

  const byBucket = Object.fromEntries(
    AUDIT_INTENT_BUCKETS.map((bucket) => [bucket, emptyBucketSummary()]),
  ) as Record<AuditIntentBucket, BucketAuditSummary>;

  const failureModeCounts: Record<string, number> = {};
  const strengthCounts: Record<string, number> = {};

  for (const audit of audits) {
    const bucket = byBucket[audit.intentBucket];
    bucket.total += 1;
    bucket.resolved += audit.resolved ? 1 : 0;
    bucket.toolCorrect += audit.toolCorrectness.pass ? 1 : 0;
    bucket.hallucinationSafe += audit.hallucinationSafety.pass ? 1 : 0;
    bucket.avgTurns += audit.totalTurns ?? 0;
    bucket.avgDurationSec += audit.durationSec ?? 0;
    bucket.avgPathScore += audit.pathEfficiency.score;

    for (const mode of audit.failureModes) {
      failureModeCounts[mode] = (failureModeCounts[mode] ?? 0) + 1;
    }
    for (const strength of audit.strengths) {
      strengthCounts[strength] = (strengthCounts[strength] ?? 0) + 1;
    }
  }

  for (const bucket of AUDIT_INTENT_BUCKETS) {
    const summary = byBucket[bucket];
    if (summary.total === 0) continue;
    summary.avgTurns = Number((summary.avgTurns / summary.total).toFixed(1));
    summary.avgDurationSec = Number(
      (summary.avgDurationSec / summary.total).toFixed(1),
    );
    summary.avgPathScore = Number(
      (summary.avgPathScore / summary.total).toFixed(2),
    );
  }

  const totalCalls = audits.length;
  const overall = {
    resolved: audits.filter((audit) => audit.resolved).length,
    toolCorrect: audits.filter((audit) => audit.toolCorrectness.pass).length,
    hallucinationSafe: audits.filter((audit) => audit.hallucinationSafety.pass)
      .length,
    avgTurns:
      totalCalls === 0
        ? 0
        : Number(
            (
              audits.reduce((sum, audit) => sum + (audit.totalTurns ?? 0), 0) /
              totalCalls
            ).toFixed(1),
          ),
    avgDurationSec:
      totalCalls === 0
        ? 0
        : Number(
            (
              audits.reduce((sum, audit) => sum + (audit.durationSec ?? 0), 0) /
              totalCalls
            ).toFixed(1),
          ),
  };

  return {
    date,
    windowHours,
    totalCalls,
    overall,
    byBucket,
    failureModeCounts,
    strengthCounts,
    audits,
  };
}
