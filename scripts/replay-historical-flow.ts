import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import {
  advanceFlowForTurn,
  createInitialFlowState,
  parseTurnUnderstanding,
  type CallFlowState,
  type FlowTurnAdvanceResult,
  type TurnUnderstanding,
  type VisitType,
} from "../src/flow/index.js";

interface HistoricalCall {
  id: string;
  startedAt?: string;
  status?: string;
  transferred?: boolean;
  bookedAppointment?: boolean;
  confirmedAppointment?: boolean;
  cancelledAppointment?: boolean;
  totalTurns?: number;
  toolCalls?: number;
  turns?: HistoricalTurn[];
  flow?: unknown;
  preCallLookup?: unknown;
}

interface HistoricalTurn {
  turn?: number;
  callerText?: string | null;
  agentText?: string | null;
  toolCalls?: HistoricalToolCall[];
}

interface HistoricalToolCall {
  name?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
}

interface Options {
  limit: number;
  input?: string;
  report?: string;
  before?: string;
  after?: string;
  excludeHarness: boolean;
  exactOnly: boolean;
  strict: boolean;
}

interface StateSnapshot {
  activeIntent: string | null;
  activeFlow: string;
  step: string;
  patientStatus: string;
  activePatientRef: string;
  visitType: string;
  coverageType: string;
  routing: string;
  currentTask: string;
  taskStackDepth: number;
  pendingActions: string[];
  availabilitySearches: string[];
  schedulingGoal: Record<string, unknown>;
  patientRegistry: Record<string, unknown>;
}

interface TurnReplay {
  turnIndex: number;
  source: "exact" | "heuristic";
  confidence: number;
  goal: string;
  decision: string;
  changedPaths: string[];
  before: StateSnapshot;
  after: StateSnapshot;
  warnings: ReplayIssue[];
}

interface CallReplay {
  callId: string;
  startedAt?: string;
  status?: string;
  callerTurns: number;
  exactTurns: number;
  heuristicTurns: number;
  finalState: StateSnapshot;
  turns: TurnReplay[];
  warnings: ReplayIssue[];
  historicalToolCounts: Record<string, number>;
}

interface ReplayIssue {
  callId: string;
  turnIndex?: number;
  kind: string;
  detail: string;
}

interface ReplayStats {
  calls: number;
  callerTurns: number;
  exactTurns: number;
  heuristicTurns: number;
  exactHarnessCalls: number;
  exactHarnessParseFailures: number;
  reducerFailures: ReplayIssue[];
  packetFailures: ReplayIssue[];
  smoothnessWarnings: ReplayIssue[];
  exactHarnessOrderingFailures: ReplayIssue[];
  packetChars: number[];
  packetLines: number[];
  changedPathCounts: number[];
  changedPathFrequency: Map<string, number>;
  decisionCounts: Map<string, number>;
  historicalToolCounts: Map<string, number>;
  availabilityCallsByCall: number[];
  duplicateAvailabilityCalls: number;
}

const guardedTools = new Set([
  "verify_patient",
  "check_insurance",
  "get_availability",
  "confirm_appt",
  "book_appt",
  "cancel_appt",
  "add_patient",
  "update_insurance",
  "transfer_call",
  "lookup_knowledge",
  "route_to_spring_hill",
  "add_patient_note",
  "confirm_booking_action",
  "confirm_side_effect_action",
]);

const options = parseOptions(process.argv.slice(2));
const calls = options.input
  ? readJsonl(options.input)
  : fetchCallsFromPostgres(options);
const stats = createStats(calls.length);
const report: CallReplay[] = [];

for (const call of calls) {
  report.push(replayCall(call, stats));
}

printSummary(stats, options, report);
if (options.report) {
  writeFileSync(options.report, `${JSON.stringify(report, null, 2)}\n`);
}

const hardFailureCount =
  stats.reducerFailures.length +
  stats.packetFailures.length +
  stats.exactHarnessOrderingFailures.length +
  stats.exactHarnessParseFailures;
const strictFailureCount = options.strict
  ? hardFailureCount + stats.smoothnessWarnings.length
  : hardFailureCount;

if (strictFailureCount > 0) process.exitCode = 1;

function parseOptions(args: string[]): Options {
  const options: Options = {
    limit: 100,
    excludeHarness: false,
    exactOnly: false,
    strict: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    switch (arg) {
      case "--limit":
        options.limit = parsePositiveInt(args[++i], "--limit");
        break;
      case "--input":
        options.input = requiredValue(args[++i], "--input");
        break;
      case "--report":
        options.report = requiredValue(args[++i], "--report");
        break;
      case "--before":
        options.before = requiredValue(args[++i], "--before");
        break;
      case "--after":
        options.after = requiredValue(args[++i], "--after");
        break;
      case "--exclude-harness":
        options.excludeHarness = true;
        break;
      case "--exact-only":
        options.exactOnly = true;
        break;
      case "--strict":
        options.strict = true;
        break;
      case "--help":
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (options.excludeHarness && options.exactOnly) {
    throw new Error("--exclude-harness and --exact-only cannot be combined");
  }
  return options;
}

function printHelp(): void {
  console.log(`Usage:
  DATABASE_URL=postgres://... pnpm test:historical-flow -- --limit 100 --exclude-harness --report /private/tmp/abita-flow-replay.json

Options:
  --limit N            Number of calls to replay. Default: 100
  --before ISO         Only calls before this startedAt timestamp
  --after ISO          Only calls after this startedAt timestamp
  --exclude-harness    Replay only older calls without record_turn_understanding telemetry
  --exact-only         Replay only calls with record_turn_understanding telemetry
  --input PATH         Replay an existing JSONL export instead of querying Postgres
  --report PATH        Write redacted per-turn state transitions to PATH
  --strict             Exit non-zero on smoothness warnings as well as hard failures
`);
}

function parsePositiveInt(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function requiredValue(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} requires a value`);
  return value;
}

function readJsonl(path: string): HistoricalCall[] {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as HistoricalCall);
}

function fetchCallsFromPostgres(options: Options): HistoricalCall[] {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is required unless --input points at a JSONL export",
    );
  }

  const output = execFileSync(
    "psql",
    [
      databaseUrl,
      "-v",
      "ON_ERROR_STOP=1",
      "-At",
      "-c",
      historicalCallQuery(options),
    ],
    {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    },
  );

  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as HistoricalCall);
}

function historicalCallQuery(options: Options): string {
  const filters = [
    "data is not null",
    "jsonb_typeof(data->'turns') = 'array'",
    "jsonb_array_length(data->'turns') > 1",
  ];
  if (options.before) {
    filters.push(`"startedAt" < ${sqlLiteral(options.before)}`);
  }
  if (options.after) {
    filters.push(`"startedAt" > ${sqlLiteral(options.after)}`);
  }
  if (options.excludeHarness) {
    filters.push(`not exists (${recordTurnUnderstandingSubquery()})`);
  }
  if (options.exactOnly) {
    filters.push(`exists (${recordTurnUnderstandingSubquery()})`);
  }

  return `
select jsonb_build_object(
  'id', id,
  'startedAt', "startedAt",
  'status', status,
  'transferred', transferred,
  'bookedAppointment', "bookedAppointment",
  'confirmedAppointment', "confirmedAppointment",
  'cancelledAppointment', "cancelledAppointment",
  'totalTurns', "totalTurns",
  'toolCalls', "toolCalls",
  'turns', data->'turns',
  'toolExecutions', data->'toolExecutions',
  'flow', data->'flow',
  'preCallLookup', data->'preCallLookup'
)::text
from public.agent_call
where ${filters.join("\n  and ")}
order by "startedAt" desc
limit ${options.limit};
`;
}

function recordTurnUnderstandingSubquery(): string {
  return `
select 1
from jsonb_array_elements(data->'turns') turn(value),
     jsonb_array_elements(turn.value->'toolCalls') tool(value)
where jsonb_typeof(turn.value->'toolCalls') = 'array'
  and tool.value->>'name' = 'record_turn_understanding'
`;
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function createStats(calls: number): ReplayStats {
  return {
    calls,
    callerTurns: 0,
    exactTurns: 0,
    heuristicTurns: 0,
    exactHarnessCalls: 0,
    exactHarnessParseFailures: 0,
    reducerFailures: [],
    packetFailures: [],
    smoothnessWarnings: [],
    exactHarnessOrderingFailures: [],
    packetChars: [],
    packetLines: [],
    changedPathCounts: [],
    changedPathFrequency: new Map(),
    decisionCounts: new Map(),
    historicalToolCounts: new Map(),
    availabilityCallsByCall: [],
    duplicateAvailabilityCalls: 0,
  };
}

function replayCall(call: HistoricalCall, stats: ReplayStats): CallReplay {
  const flow = createInitialFlowState({
    officeKey: "spring-hill",
    patientId: null,
    patientName: null,
    dob: null,
    callerPhone: null,
    appointments: [],
    routing: "all_three",
    coverageType: null,
  });
  const callReport: CallReplay = {
    callId: call.id,
    startedAt: call.startedAt,
    status: call.status,
    callerTurns: 0,
    exactTurns: 0,
    heuristicTurns: 0,
    finalState: snapshotFlow(flow),
    turns: [],
    warnings: [],
    historicalToolCounts: {},
  };
  const exactHarnessCall = hasRecordTurnUnderstanding(call);
  if (exactHarnessCall) stats.exactHarnessCalls += 1;

  const availabilityKeys = new Set<string>();
  let availabilityCalls = 0;
  let previousIntent = flow.activeIntent;
  let previousFlow = flow.activeFlow;
  let intentChanges = 0;
  let flowChanges = 0;

  for (const [turnIndex, turn] of (call.turns ?? []).entries()) {
    countHistoricalTools(turn, callReport, stats);
    inspectExactHarnessOrdering(call.id, turnIndex, turn, stats);
    for (const tool of turn.toolCalls ?? []) {
      if (tool.name !== "get_availability") continue;
      availabilityCalls += 1;
      const key = normalizedAvailabilityKey(tool.args);
      if (availabilityKeys.has(key)) stats.duplicateAvailabilityCalls += 1;
      availabilityKeys.add(key);
    }

    if (!turn.callerText?.trim()) continue;
    stats.callerTurns += 1;
    callReport.callerTurns += 1;

    const exact = exactUnderstanding(turn);
    if (exact?.parseFailures) {
      stats.exactHarnessParseFailures += exact.parseFailures;
    }
    const source = exact?.understanding ? "exact" : "heuristic";
    const understanding =
      exact?.understanding ?? heuristicUnderstanding(turn.callerText, turn);
    if (source === "exact") {
      stats.exactTurns += 1;
      callReport.exactTurns += 1;
    } else {
      stats.heuristicTurns += 1;
      callReport.heuristicTurns += 1;
    }

    const before = snapshotFlow(flow);
    let decision: FlowTurnAdvanceResult;
    let turnState: string;
    try {
      const result = advanceFlowForTurn({
        flow,
        transcript: turn.callerText,
        understanding,
      });
      decision = result;
      turnState = result.turnState;
      bump(stats.decisionCounts, decisionLabel(decision));
    } catch (error) {
      stats.reducerFailures.push({
        callId: call.id,
        turnIndex,
        kind: "reducer_exception",
        detail: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const after = snapshotFlow(flow);
    const changedPaths = changedSnapshotPaths(before, after);
    for (const path of changedPaths) bump(stats.changedPathFrequency, path);
    stats.changedPathCounts.push(changedPaths.length);
    inspectTurnStatePacket(
      call.id,
      turnIndex,
      turn.callerText,
      turnState,
      stats,
    );

    const warnings = smoothnessWarnings({
      callId: call.id,
      turnIndex,
      understanding,
      before,
      after,
      decision,
      changedPaths,
    });
    stats.smoothnessWarnings.push(...warnings);
    callReport.warnings.push(...warnings);

    callReport.turns.push({
      turnIndex,
      source,
      confidence: understanding.confidence,
      goal: understanding.goal,
      decision: decisionLabel(decision),
      changedPaths,
      before,
      after,
      warnings,
    });

    if (flow.activeIntent !== previousIntent) intentChanges += 1;
    if (flow.activeFlow !== previousFlow) flowChanges += 1;
    previousIntent = flow.activeIntent;
    previousFlow = flow.activeFlow;
  }

  if (intentChanges > 6) {
    const warning = {
      callId: call.id,
      kind: "intent_thrash",
      detail: `${intentChanges} activeIntent changes`,
    };
    stats.smoothnessWarnings.push(warning);
    callReport.warnings.push(warning);
  }
  if (flowChanges > 6) {
    const warning = {
      callId: call.id,
      kind: "flow_thrash",
      detail: `${flowChanges} activeFlow changes`,
    };
    stats.smoothnessWarnings.push(warning);
    callReport.warnings.push(warning);
  }

  stats.availabilityCallsByCall.push(availabilityCalls);
  callReport.finalState = snapshotFlow(flow);
  return callReport;
}

function hasRecordTurnUnderstanding(call: HistoricalCall): boolean {
  return Boolean(
    call.turns?.some((turn) =>
      turn.toolCalls?.some((tool) => tool.name === "record_turn_understanding"),
    ),
  );
}

function exactUnderstanding(
  turn: HistoricalTurn,
): { understanding?: TurnUnderstanding; parseFailures: number } | undefined {
  const calls = (turn.toolCalls ?? []).filter(
    (tool) => tool.name === "record_turn_understanding",
  );
  if (calls.length === 0) return undefined;

  let understanding: TurnUnderstanding | undefined;
  let parseFailures = 0;
  for (const call of calls) {
    const args = parsePossiblyJson(call.args);
    const parsed =
      parseTurnUnderstanding(args) ??
      parseTurnUnderstanding(
        typeof args === "object" && args
          ? (args as { understanding?: unknown }).understanding
          : undefined,
      ) ??
      parseTurnUnderstanding(
        typeof args === "object" && args
          ? (args as { state?: unknown }).state
          : undefined,
      );
    if (parsed && !understanding) understanding = parsed;
    if (!parsed) parseFailures += 1;
  }

  return { understanding, parseFailures };
}

function heuristicUnderstanding(
  callerText: string,
  turn: HistoricalTurn,
): TurnUnderstanding {
  const text = callerText.toLowerCase();
  const evidence = [safeEvidence(callerText)];
  const toolNames = new Set((turn.toolCalls ?? []).map((tool) => tool.name));

  if (
    /\b(representative|human|person|operator|front desk|staff)\b/.test(text)
  ) {
    return {
      goal: "transfer_request",
      appointmentAction: null,
      interruption: "transfer_request",
      confidence: 0.86,
      evidence,
    };
  }

  if (/\b(cancel|cancellation)\b/.test(text) || toolNames.has("cancel_appt")) {
    return appointmentManagementUnderstanding("cancel", evidence);
  }

  if (/\b(reschedule|move|change my appointment)\b/.test(text)) {
    return appointmentManagementUnderstanding("reschedule", evidence);
  }

  if (
    /\b(confirm|confirmation|yes|that works|that time works|sounds good)\b/.test(
      text,
    ) &&
    toolNames.has("confirm_appt")
  ) {
    return appointmentManagementUnderstanding("confirm", evidence);
  }

  if (
    /\b(insurance|medicare|medicaid|aetna|humana|cigna|blue cross|bcbs|vsp|eyemed|ambetter|united|oscar|florida blue)\b/.test(
      text,
    ) ||
    toolNames.has("check_insurance")
  ) {
    const scheduling =
      toolNames.has("get_availability") || schedulingWords(text)
        ? {
            visitType: visitTypeForText(text),
            visitReason: "caller-described visit",
          }
        : undefined;
    return {
      goal: scheduling ? "schedule" : "insurance_question",
      appointmentAction: null,
      patient: { patientMentioned: "caller", relationshipToCaller: "self" },
      scheduling,
      insurance: {
        coverageType: coverageTypeForText(text),
        plan: insurancePlanMentioned(text)
          ? "caller-mentioned-plan"
          : undefined,
      },
      interruption: "none",
      confidence: 0.78,
      evidence,
    };
  }

  if (
    schedulingWords(text) ||
    toolNames.has("get_availability") ||
    toolNames.has("book_appt")
  ) {
    return {
      goal: "schedule",
      appointmentAction: null,
      patient: {
        patientMentioned: /\b(my son|my daughter|child|kid)\b/.test(text)
          ? "someone_else"
          : "caller",
        relationshipToCaller: /\b(my son|my daughter|child|kid)\b/.test(text)
          ? "child"
          : "self",
      },
      scheduling: {
        visitReason: "caller-described visit",
        visitType: visitTypeForText(text),
        preferredWindow: preferredWindowMentioned(text)
          ? "caller-mentioned-window"
          : undefined,
      },
      interruption: "none",
      confidence: 0.82,
      evidence,
    };
  }

  if (
    /\b(hour|address|location|fax|doctor|provider|open|closed|directions|parking)\b/.test(
      text,
    ) ||
    toolNames.has("lookup_knowledge")
  ) {
    return {
      goal: "faq",
      appointmentAction: null,
      interruption: "faq",
      confidence: 0.76,
      evidence,
    };
  }

  return {
    goal: "unclear",
    appointmentAction: null,
    interruption: "none",
    confidence: 0.42,
    evidence,
  };
}

function appointmentManagementUnderstanding(
  action: "confirm" | "cancel" | "reschedule",
  evidence: string[],
): TurnUnderstanding {
  return {
    goal: "manage_existing_appointment",
    appointmentAction: action,
    patient: { patientMentioned: "caller", relationshipToCaller: "self" },
    scheduling: {},
    interruption: "none",
    confidence: 0.84,
    evidence,
  };
}

function schedulingWords(text: string): boolean {
  return /\b(appointment|schedule|seen|visit|exam|glasses|contacts|cataract|glaucoma|retina|floaters|blurry|vision|eye)\b/.test(
    text,
  );
}

function visitTypeForText(text: string): VisitType {
  if (
    /\b(glasses|contacts|contact lens|routine|annual|eye exam|vision exam|vsp|eyemed)\b/.test(
      text,
    )
  ) {
    return "routine_vision";
  }
  if (/\b(urgent|emergency|pain|flashes|floaters|sudden)\b/.test(text)) {
    return "urgent";
  }
  return "medical";
}

function coverageTypeForText(
  text: string,
): "medical" | "routine_vision" | undefined {
  if (/\b(vsp|eyemed|routine|glasses|contacts|vision exam)\b/.test(text)) {
    return "routine_vision";
  }
  if (
    /\b(medicare|medicaid|medical|surgery|cataract|glaucoma|retina)\b/.test(
      text,
    )
  ) {
    return "medical";
  }
  return undefined;
}

function insurancePlanMentioned(text: string): boolean {
  return /\b(medicare|medicaid|aetna|humana|cigna|blue cross|bcbs|vsp|eyemed|ambetter|united|oscar|florida blue)\b/.test(
    text,
  );
}

function preferredWindowMentioned(text: string): boolean {
  return /\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|morning|afternoon|next week|\d{1,2}\/\d{1,2})\b/.test(
    text,
  );
}

function safeEvidence(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= 40) return normalized;
  return `${normalized.slice(0, 37)}...`;
}

function snapshotFlow(flow: CallFlowState): StateSnapshot {
  return {
    activeIntent: flow.activeIntent,
    activeFlow: flow.activeFlow,
    step: flow.step,
    patientStatus: flow.patientStatus,
    activePatientRef: flow.activePatientRef ?? "unknown",
    visitType: flow.visitType ?? "unknown",
    coverageType: flow.coverageType ?? "unknown",
    routing: flow.routing ?? "unknown",
    currentTask: flow.currentTask
      ? `${flow.currentTask.kind}:${flow.currentTask.step}:${flow.currentTask.patientRef ?? "none"}`
      : "none",
    taskStackDepth: flow.taskStack.length,
    pendingActions: flow.pendingActions.map(
      (action) =>
        `${action.type}:${action.confirmed ? "confirmed" : "pending"}:${action.consumed ? "consumed" : "open"}`,
    ),
    availabilitySearches: flow.availabilitySearches.map(
      (search) =>
        `${search.status}:exact=${search.exactSearchCount}:dupe=${search.duplicateSearchCount}:slots=${search.cachedSlots.length}`,
    ),
    schedulingGoal: flow.schedulingGoal
      ? {
          status: flow.schedulingGoal.status,
          appointmentAction: flow.schedulingGoal.appointmentAction ?? "none",
          visitType: flow.schedulingGoal.visitType ?? "unknown",
          hasReason: Boolean(flow.schedulingGoal.visitReason),
          hasPreferredWindow: Boolean(flow.schedulingGoal.preferredWindow),
          hasSelectedSlot: Boolean(flow.schedulingGoal.selectedSlotId),
          bookingConfirmed: flow.schedulingGoal.bookingConfirmed ?? null,
          hasNoteReason: Boolean(
            flow.schedulingGoal.noteDraft?.appointmentReason,
          ),
          hasReferrer: Boolean(flow.schedulingGoal.noteDraft?.referringDoctor),
        }
      : {},
    patientRegistry: Object.fromEntries(
      Object.entries(flow.patients).map(([ref, patient]) => [
        ref,
        {
          status: patient.status,
          relationshipToCaller: patient.relationshipToCaller ?? "unknown",
          hasFirstName: Boolean(patient.firstName?.value),
          firstNameConfirmed: Boolean(patient.firstName?.confirmed),
          hasLastName: Boolean(patient.lastName?.value),
          hasDob: Boolean(patient.dob?.value),
          dobConfirmed: Boolean(patient.dob?.confirmed),
          hasPhone: Boolean(patient.phone?.value),
          hasPatientId: Boolean(patient.patientId),
          appointments: patient.appointments.length,
          verificationAttempts: patient.verificationAttempts,
          insuranceCoverageType: patient.insurance?.coverageType ?? "unknown",
          hasInsurancePlan: Boolean(patient.insurance?.plan?.value),
        },
      ]),
    ),
  };
}

function changedSnapshotPaths(
  before: StateSnapshot,
  after: StateSnapshot,
): string[] {
  const beforeFlat = flattenSnapshot(before);
  const afterFlat = flattenSnapshot(after);
  const paths = new Set([
    ...Object.keys(beforeFlat),
    ...Object.keys(afterFlat),
  ]);
  return [...paths]
    .filter((path) => beforeFlat[path] !== afterFlat[path])
    .sort();
}

function flattenSnapshot(value: unknown, prefix = ""): Record<string, string> {
  if (Array.isArray(value)) {
    return Object.fromEntries(
      value.map((entry, index) => [
        `${prefix}[${index}]`,
        typeof entry === "object" ? JSON.stringify(entry) : String(entry),
      ]),
    );
  }
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).reduce<
      Record<string, string>
    >(
      (acc, [key, nested]) => ({
        ...acc,
        ...flattenSnapshot(nested, prefix ? `${prefix}.${key}` : key),
      }),
      {},
    );
  }
  return { [prefix]: String(value) };
}

function inspectTurnStatePacket(
  callId: string,
  turnIndex: number,
  callerText: string,
  packet: string,
  stats: ReplayStats,
): void {
  stats.packetChars.push(packet.length);
  stats.packetLines.push(packet.split("\n").length);
  if (
    !packet.includes("<turn_state>") ||
    !packet.includes("<context_capsules>")
  ) {
    stats.packetFailures.push({
      callId,
      turnIndex,
      kind: "packet_missing_sections",
      detail: "missing turn_state or context_capsules",
    });
  }
  if (packet.length > 1_000) {
    stats.packetFailures.push({
      callId,
      turnIndex,
      kind: "packet_too_large",
      detail: `${packet.length} chars`,
    });
  }
  if (leaksRawCallerText(packet, callerText)) {
    stats.packetFailures.push({
      callId,
      turnIndex,
      kind: "packet_raw_transcript_leak",
      detail: "packet contains a long caller-text phrase",
    });
  }
  if (containsLikelyPrivateValue(packet)) {
    stats.packetFailures.push({
      callId,
      turnIndex,
      kind: "packet_private_value_pattern",
      detail: "packet contains phone/email/DOB-like pattern",
    });
  }
}

function smoothnessWarnings({
  callId,
  turnIndex,
  understanding,
  before,
  after,
  decision,
  changedPaths,
}: {
  callId: string;
  turnIndex: number;
  understanding: TurnUnderstanding;
  before: StateSnapshot;
  after: StateSnapshot;
  decision: FlowTurnAdvanceResult;
  changedPaths: string[];
}): ReplayIssue[] {
  const warnings: ReplayIssue[] = [];
  if (understanding.confidence < 0.5 && changedPaths.length > 0) {
    warnings.push({
      callId,
      turnIndex,
      kind: "low_confidence_mutated_state",
      detail: changedPaths.join(", "),
    });
  }
  if (
    before.activePatientRef === after.activePatientRef &&
    patientRank(after.patientStatus) < patientRank(before.patientStatus)
  ) {
    warnings.push({
      callId,
      turnIndex,
      kind: "patient_status_regression",
      detail: `${before.patientStatus} -> ${after.patientStatus}`,
    });
  }
  if (
    decision.action === "call_tool" &&
    decision.tool === "book_appt" &&
    !after.pendingActions.some((action) => action.startsWith("book_appt:"))
  ) {
    warnings.push({
      callId,
      turnIndex,
      kind: "book_without_pending_action",
      detail: "controller chose book_appt without a pending booking action",
    });
  }
  if (
    decision.action === "call_tool" &&
    decision.tool === "cancel_appt" &&
    !after.pendingActions.some((action) => action.startsWith("cancel_appt:"))
  ) {
    warnings.push({
      callId,
      turnIndex,
      kind: "cancel_without_pending_action",
      detail: "controller chose cancel_appt without a pending cancel action",
    });
  }
  if (changedPaths.length > 14) {
    warnings.push({
      callId,
      turnIndex,
      kind: "large_state_jump",
      detail: `${changedPaths.length} changed paths`,
    });
  }
  return warnings;
}

function patientRank(status: string): number {
  switch (status) {
    case "unknown":
      return 0;
    case "candidate":
      return 1;
    case "matched":
      return 2;
    case "new":
      return 3;
    case "verified":
      return 4;
    case "created":
      return 5;
    default:
      return 0;
  }
}

function inspectExactHarnessOrdering(
  callId: string,
  turnIndex: number,
  turn: HistoricalTurn,
  stats: ReplayStats,
): void {
  const hasExactHarness = turn.toolCalls?.some(
    (tool) => tool.name === "record_turn_understanding",
  );
  if (!hasExactHarness) return;

  let sawUnderstanding = false;
  for (const tool of turn.toolCalls ?? []) {
    if (tool.name === "record_turn_understanding") {
      sawUnderstanding = true;
      continue;
    }
    if (!tool.name || !guardedTools.has(tool.name)) continue;
    if (!sawUnderstanding) {
      stats.exactHarnessOrderingFailures.push({
        callId,
        turnIndex,
        kind: "guarded_tool_before_record_turn_understanding",
        detail: tool.name,
      });
    }
  }
}

function countHistoricalTools(
  turn: HistoricalTurn,
  callReport: CallReplay,
  stats: ReplayStats,
): void {
  for (const tool of turn.toolCalls ?? []) {
    if (!tool.name) continue;
    bump(stats.historicalToolCounts, tool.name);
    callReport.historicalToolCounts[tool.name] =
      (callReport.historicalToolCounts[tool.name] ?? 0) + 1;
  }
}

function decisionLabel(decision: FlowTurnAdvanceResult): string {
  switch (decision.action) {
    case "ask":
      return `ask:${decision.slot ?? decision.nextAction}`;
    case "call_tool":
      return `tool:${decision.tool ?? decision.nextAction}`;
    case "confirm":
      return `confirm:${decision.confirmationType ?? decision.nextAction}`;
    case "respond":
      return "respond";
    case "complete":
      return "complete";
  }
}

function leaksRawCallerText(packet: string, callerText: string): boolean {
  const words = callerText
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2);
  if (words.length < 6) return false;
  const normalizedPacket = packet.toLowerCase();
  for (let i = 0; i <= words.length - 6; i += 1) {
    const phrase = words.slice(i, i + 6).join(" ");
    if (normalizedPacket.includes(phrase)) return true;
  }
  return false;
}

function containsLikelyPrivateValue(packet: string): boolean {
  return (
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(packet) ||
    /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/.test(packet) ||
    /\b(?:19|20)\d{2}-\d{2}-\d{2}\b/.test(packet)
  );
}

function normalizedAvailabilityKey(args: unknown): string {
  const parsed = parsePossiblyJson(args);
  if (!parsed || typeof parsed !== "object") return "unknown";
  const record = parsed as Record<string, unknown>;
  return JSON.stringify({
    date: record.date ?? null,
    preferredWindow: record.preferredWindow ?? record.window ?? null,
    routing: record.routing ?? null,
    visitType: record.visitType ?? null,
    officeKey: record.officeKey ?? null,
  });
}

function parsePossiblyJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function topEntries(
  map: Map<string, number>,
  limit = 12,
): Array<[string, number]> {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  ];
}

function printSummary(
  stats: ReplayStats,
  options: Options,
  report: CallReplay[],
): void {
  const callsWithAvailability = stats.availabilityCallsByCall.filter(
    (count) => count > 0,
  );
  const callsOverThreeAvailability = stats.availabilityCallsByCall.filter(
    (count) => count > 3,
  );
  const smoothnessByKind = stats.smoothnessWarnings.reduce<Map<string, number>>(
    (acc, issue) => {
      bump(acc, issue.kind);
      return acc;
    },
    new Map(),
  );

  const summary = {
    mode: options.exactOnly
      ? "exact-harness-only"
      : options.excludeHarness
        ? "older-calls-without-harness-telemetry"
        : "mixed",
    calls: stats.calls,
    callerTurns: stats.callerTurns,
    turnUnderstanding: {
      exactTurns: stats.exactTurns,
      heuristicTurns: stats.heuristicTurns,
      exactHarnessCalls: stats.exactHarnessCalls,
      exactHarnessParseFailures: stats.exactHarnessParseFailures,
    },
    hardFailures: {
      reducerFailures: stats.reducerFailures.length,
      packetFailures: stats.packetFailures.length,
      exactHarnessOrderingFailures: stats.exactHarnessOrderingFailures.length,
    },
    packets: {
      avgChars: Math.round(average(stats.packetChars)),
      p95Chars: percentile(stats.packetChars, 95),
      maxChars: Math.max(0, ...stats.packetChars),
      avgLines: Math.round(average(stats.packetLines)),
      maxLines: Math.max(0, ...stats.packetLines),
    },
    stateChanges: {
      avgChangedPaths: Number(average(stats.changedPathCounts).toFixed(2)),
      p95ChangedPaths: percentile(stats.changedPathCounts, 95),
      maxChangedPaths: Math.max(0, ...stats.changedPathCounts),
      topChangedPaths: Object.fromEntries(
        topEntries(stats.changedPathFrequency),
      ),
    },
    decisions: Object.fromEntries(topEntries(stats.decisionCounts)),
    smoothnessWarnings: {
      total: stats.smoothnessWarnings.length,
      byKind: Object.fromEntries(topEntries(smoothnessByKind)),
      first: stats.smoothnessWarnings.slice(0, 8),
    },
    historicalTools: {
      topToolCalls: Object.fromEntries(topEntries(stats.historicalToolCounts)),
      availability: {
        callsWithAvailability: callsWithAvailability.length,
        maxAvailabilityCallsInCall: Math.max(
          0,
          ...stats.availabilityCallsByCall,
        ),
        callsOverThreeAvailability: callsOverThreeAvailability.length,
        duplicateAvailabilityCalls: stats.duplicateAvailabilityCalls,
      },
    },
    mostChangedCalls: report
      .map((call) => ({
        callId: call.callId,
        callerTurns: call.callerTurns,
        warnings: call.warnings.length,
        changedPaths: call.turns.reduce(
          (sum, turn) => sum + turn.changedPaths.length,
          0,
        ),
      }))
      .sort((a, b) => b.changedPaths - a.changedPaths)
      .slice(0, 8),
    reportPath: options.report ?? null,
  };

  console.log(JSON.stringify(summary, null, 2));
}
