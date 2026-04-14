export interface NormalizedToolCall {
  name: string;
  args?: Record<string, unknown>;
  durationMs?: number;
  isError?: boolean;
  result?: unknown;
}

export interface NormalizedTurn {
  turn: number;
  callerText: string | null;
  agentText: string | null;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  ttftMs?: number;
  ttsttfbMs?: number;
  toolCalls: NormalizedToolCall[];
}

export interface NormalizedCallEventData {
  turns: NormalizedTurn[];
  compactions?: unknown[];
  phoneLookupStatus?: "verified" | "multiple_matches" | "no_match" | "unknown";
}

export interface NormalizedCallEvent {
  callId: string;
  officePhone: string;
  totalTurns?: number;
  durationSec?: number;
  startedAt?: string;
  endedAt?: string;
  data: NormalizedCallEventData;
}

export interface DecisionPointCaseAppointment {
  id: number;
  date: string;
  time: string;
  provider: string;
  type: string;
}

export interface DecisionPointCase {
  id: string;
  suite: string;
  source: string;
  assertionMode?: "strict" | "runbook_only";
  traceId?: string;
  tags: string[];
  context: {
    trunkPhone: string;
    phoneLookupStatus: "verified" | "multiple_matches" | "no_match" | "unknown";
    notes?: string;
    appointments?: DecisionPointCaseAppointment[];
  };
  conversation: Array<{
    role: "user" | "assistant";
    content: string;
  }>;
  expectations: {
    mustCallTools: string[];
    mustNotCallTools: string[];
    mustSay?: string[];
    mustNotSay?: string[];
    policyFlags?: string[];
    styleFlags?: string[];
  };
}

export type AuditIntentBucket =
  | "new_patient"
  | "faq"
  | "immediate_transfer"
  | "confirm"
  | "cancel_rebook"
  | "existing_patient_booking";

export type AuditFailureMode =
  | "wrong_tool"
  | "bad_tool_args"
  | "wrong_tool_order"
  | "hallucination"
  | "policy_violation"
  | "unnecessary_transfer"
  | "missed_transfer"
  | "slow_path"
  | "repeat_question"
  | "caller_abandoned"
  | "unresolved_need"
  | "knowledge_gap";

export type AuditOverallStatus = "great" | "needs_work" | "failed";

export interface AuditToolCall {
  turn: number;
  name: string;
  args: Record<string, unknown>;
  argParseError?: string;
  missingRequiredArgs: string[];
  isError?: boolean;
}

export interface AuditToolCorrectness {
  pass: boolean;
  issues: string[];
  malformedArgs: string[];
  missingRequiredArgs: string[];
  sequenceIssues: string[];
}

export interface AuditPathEfficiency {
  score: number;
  issues: string[];
  repeatedQuestionCount: number;
  extraTurns: number;
}

export interface AuditHallucinationSafety {
  pass: boolean;
  issues: string[];
}

export interface CallAuditRecord {
  callId: string;
  startedAt?: string;
  durationSec?: number;
  totalTurns?: number;
  officePhone: string;
  intentBucket: AuditIntentBucket;
  intentBucketGuess: AuditIntentBucket | "unknown";
  overallStatus: AuditOverallStatus;
  resolved: boolean;
  resolutionReason: string;
  failureModes: AuditFailureMode[];
  toolCorrectness: AuditToolCorrectness;
  pathEfficiency: AuditPathEfficiency;
  hallucinationSafety: AuditHallucinationSafety;
  strengths: string[];
  recommendedFixes: string[];
  toolCalls: AuditToolCall[];
  metrics: {
    toolCallCount: number;
    toolErrorCount: number;
    transferred: boolean;
    repeatedQuestionCount: number;
    extraTurns: number;
  };
}

export interface BucketAuditSummary {
  total: number;
  resolved: number;
  toolCorrect: number;
  hallucinationSafe: number;
  avgTurns: number;
  avgDurationSec: number;
  avgPathScore: number;
}

export interface CallAuditReport {
  date: string;
  windowHours: number;
  totalCalls: number;
  overall: {
    resolved: number;
    toolCorrect: number;
    hallucinationSafe: number;
    avgTurns: number;
    avgDurationSec: number;
  };
  byBucket: Record<AuditIntentBucket, BucketAuditSummary>;
  failureModeCounts: Record<string, number>;
  strengthCounts: Record<string, number>;
  audits: CallAuditRecord[];
}
