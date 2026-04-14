/**
 * Audits recent production calls into a structured six-bucket evaluation record.
 *
 * Output:
 *   evals/output/audits-(YYYY-MM-DD).json
 *
 * The audit blends deterministic checks (tool args, obvious sequencing issues,
 * repeated questions, turn counts) with bounded LLM judgments (resolved,
 * best-fit bucket, path quality, hallucination risk, strengths, fixes).
 */

import "dotenv/config";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  AUDIT_INTENT_BUCKETS,
  buildCompactTranscript,
  computeExtraTurns,
  countRepeatedAssistantQuestions,
  extractAuditToolCalls,
  inferIntentBucket,
  summarizeAuditReport,
  summarizeDeterministicToolCorrectness,
} from "../lib/audit.js";
import { OUTPUT_DIR, ensureDir, writeJSON } from "../lib/io.js";
import { normalizeCallEvents } from "../lib/normalize-call-events.js";
import type {
  AuditFailureMode,
  AuditIntentBucket,
  AuditOverallStatus,
  CallAuditRecord,
  NormalizedCallEvent,
} from "../lib/types.js";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const RUNBOOK_PATH = resolve(REPO_ROOT, "workspace", "RUNBOOK.md");
const AUDIT_BATCH_SIZE = Number.parseInt(
  process.env.AUDIT_BATCH_SIZE ?? "5",
  10,
);

function defaultAuditProvider(): "openai" | "anthropic" {
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.OPENAI_API_KEY) return "openai";
  return "anthropic";
}

const AUDIT_PROVIDER_OVERRIDE = process.env.AUDIT_PROVIDER as
  | "openai"
  | "anthropic"
  | undefined;
const AUDIT_MODEL =
  process.env.AUDIT_MODEL ??
  ((AUDIT_PROVIDER_OVERRIDE ?? defaultAuditProvider()) === "openai"
    ? "gpt-4.1-mini"
    : "claude-sonnet-4-5");

function inferAuditProvider(model: string): "openai" | "anthropic" {
  const normalized = model.trim().toLowerCase();
  if (normalized.startsWith("claude")) return "anthropic";
  if (
    normalized.startsWith("gpt") ||
    normalized.startsWith("o1") ||
    normalized.startsWith("o3") ||
    normalized.startsWith("o4")
  ) {
    return "openai";
  }
  return process.env.OPENAI_API_KEY ? "openai" : "anthropic";
}

const AUDIT_PROVIDER = AUDIT_PROVIDER_OVERRIDE ?? inferAuditProvider(AUDIT_MODEL);

interface Args {
  hours: number;
  limit: number;
}

interface LlmAuditShape {
  callId: string;
  intentBucket: AuditIntentBucket;
  resolved: boolean;
  resolutionReason: string;
  toolCorrectness: { pass: boolean; issues: string[] };
  pathEfficiency: { score: number; issues: string[] };
  hallucinationSafety: { pass: boolean; issues: string[] };
  strengths: string[];
  failureModes: AuditFailureMode[];
  recommendedFixes: string[];
}

interface AuditInputContext {
  record: NormalizedCallEvent;
  intentBucketGuess: AuditIntentBucket | "unknown";
  deterministicTool: ReturnType<typeof summarizeDeterministicToolCorrectness>;
  repeatedQuestionCount: number;
  extraTurns: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { hours: 24, limit: 200 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--hours" && argv[i + 1])
      args.hours = Number.parseFloat(argv[i + 1]);
    if (argv[i] === "--days" && argv[i + 1])
      args.hours = Number.parseFloat(argv[i + 1]) * 24;
    if (argv[i] === "--limit" && argv[i + 1])
      args.limit = Number.parseInt(argv[i + 1], 10);
  }
  return args;
}

function fetchRecentCalls({ hours, limit }: Args): unknown[] {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const sql = `
    SELECT COALESCE(
      json_agg(
        json_build_object(
          'callId', ce."callId",
          'officePhone', ce."officePhone",
          'totalTurns', ce."totalTurns",
          'durationSec', ce."durationSec",
          'startedAt', ce."startedAt",
          'endedAt', ce."endedAt",
          'data', ce.data
        )
        ORDER BY ce."startedAt" DESC
      ),
      '[]'::json
    )
    FROM (
      SELECT "callId", "officePhone", "totalTurns", "durationSec", "startedAt", "endedAt", data
      FROM "CallEvent"
      WHERE "totalTurns" > 1
        AND "startedAt" > now() - interval '${hours} hours'
      ORDER BY "startedAt" DESC
      LIMIT ${limit}
    ) ce
  `
    .replace(/\s+/g, " ")
    .trim();

  const stdout = execSync(
    `psql "${process.env.DATABASE_URL}" -t -A -c ${JSON.stringify(sql)}`,
    { encoding: "utf-8", timeout: 60_000, maxBuffer: 256 * 1024 * 1024 },
  ).trim();
  if (!stdout) return [];
  return JSON.parse(stdout) as unknown[];
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}

function buildAuditPrompt(runbook: string, calls: AuditInputContext[]): string {
  const callSections = calls
    .map(
      ({
        record,
        intentBucketGuess,
        deterministicTool,
        repeatedQuestionCount,
        extraTurns,
      }) => {
        const compactTranscript = buildCompactTranscript(record);
        const tools =
          extractAuditToolCalls(record)
            .map((toolCall) => {
              const notes: string[] = [];
              if (toolCall.argParseError)
                notes.push(`argParseError=${toolCall.argParseError}`);
              if (toolCall.missingRequiredArgs.length > 0) {
                notes.push(
                  `missingRequiredArgs=${toolCall.missingRequiredArgs.join("|")}`,
                );
              }
              return `- turn ${toolCall.turn}: ${toolCall.name}(${JSON.stringify(toolCall.args)})${notes.length > 0 ? ` [${notes.join("; ")}]` : ""}`;
            })
            .join("\n") || "- none";

        return [
          `## CALL ${record.callId}`,
          `officePhone=${record.officePhone}`,
          `totalTurns=${record.totalTurns ?? record.data.turns.length}`,
          `durationSec=${record.durationSec ?? 0}`,
          `intentBucketGuess=${intentBucketGuess}`,
          `repeatedQuestionCount=${repeatedQuestionCount}`,
          `extraTurnsVsIdeal=${extraTurns}`,
          `deterministicToolPass=${deterministicTool.pass}`,
          `deterministicToolIssues=${deterministicTool.issues.join(" || ") || "(none)"}`,
          "",
          "### Tool timeline",
          tools,
          "",
          "### Transcript",
          compactTranscript,
        ].join("\n");
      },
    )
    .join("\n\n---\n\n");

  return [
    "You are auditing voice-agent calls for operational quality.",
    "",
    "# RUNBOOK",
    runbook,
    "",
    "# REQUIRED INTENT BUCKETS",
    AUDIT_INTENT_BUCKETS.map((bucket) => `- ${bucket}`).join("\n"),
    "",
    "# FAILURE MODES",
    [
      "wrong_tool",
      "bad_tool_args",
      "wrong_tool_order",
      "hallucination",
      "policy_violation",
      "unnecessary_transfer",
      "missed_transfer",
      "slow_path",
      "repeat_question",
      "caller_abandoned",
      "unresolved_need",
      "knowledge_gap",
    ]
      .map((mode) => `- ${mode}`)
      .join("\n"),
    "",
    "# CALLS",
    callSections,
    "",
    "# TASK",
    "For each call, return one structured audit record.",
    "Be strict about whether the caller's actual need was resolved.",
    "Be strict about hallucination, incorrect tool usage, and obvious runbook violations.",
    "Be concise. Use callIds and turn numbers only. Do not include patient names, DOBs, phone numbers, addresses, member IDs, or other PHI.",
    "",
    "Definitions:",
    "- resolved=true only if the caller's need for that bucket was actually completed or correctly handed off",
    "- toolCorrectness.pass=false if a required tool was skipped, a wrong tool was used, or parameters were materially wrong",
    "- pathEfficiency.score is 0.00 to 1.00 where 1.00 is the shortest clean path",
    "- hallucinationSafety.pass=false if the agent invented facts, answered from memory when the runbook required grounding, gave prohibited advice, or otherwise overstated certainty",
    "- strengths should capture what the agent did well in this specific call",
    "- recommendedFixes should be short prompt or workflow changes that would reduce recurrence",
    "",
    "# OUTPUT FORMAT",
    "Return a single JSON object exactly matching this shape (no markdown, no preamble):",
    JSON.stringify(
      {
        audits: [
          {
            callId: "SCL_...",
            intentBucket: "new_patient",
            resolved: false,
            resolutionReason: "Short non-PHI sentence.",
            toolCorrectness: { pass: false, issues: ["Short issue"] },
            pathEfficiency: { score: 0.52, issues: ["Short issue"] },
            hallucinationSafety: { pass: true, issues: [] },
            strengths: ["Short strength"],
            failureModes: ["slow_path"],
            recommendedFixes: ["Short fix"],
          },
        ],
      },
      null,
      2,
    ),
  ].join("\n");
}

interface AnthropicResponse {
  content: Array<{ type: string; text: string }>;
}

interface OpenAIResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
}

async function callAuditModel(prompt: string): Promise<string> {
  if (AUDIT_PROVIDER === "openai") {
    if (!process.env.OPENAI_API_KEY)
      throw new Error("OPENAI_API_KEY is required");
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: AUDIT_MODEL,
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
        response_format: { type: "json_object" },
      }),
    });
    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`OpenAI API ${response.status}: ${errorBody}`);
    }
    const data = (await response.json()) as OpenAIResponse;
    const content = data.choices?.[0]?.message?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content.map((part) => part.text ?? "").join("");
    }
    return "";
  }

  if (!process.env.ANTHROPIC_API_KEY)
    throw new Error("ANTHROPIC_API_KEY is required");
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: AUDIT_MODEL,
      max_tokens: 16000,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Anthropic API ${response.status}: ${errorBody}`);
  }
  const data = (await response.json()) as AnthropicResponse;
  return data.content[0]?.text ?? "";
}

function parseLlmAudits(text: string): LlmAuditShape[] {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match)
    throw new Error(`Audit model did not return JSON: ${text.slice(0, 400)}`);
  const parsed = JSON.parse(match[0]) as { audits?: LlmAuditShape[] };
  if (!Array.isArray(parsed.audits))
    throw new Error("Audit model JSON missing 'audits'");
  return parsed.audits;
}

function normalizeIntentBucket(
  value: string | undefined,
  fallback: AuditIntentBucket | "unknown",
): AuditIntentBucket {
  if (value && (AUDIT_INTENT_BUCKETS as string[]).includes(value)) {
    return value as AuditIntentBucket;
  }
  return fallback === "unknown" ? "faq" : fallback;
}

function dedupe(values: string[] | undefined, limit: number): string[] {
  return Array.from(
    new Set((values ?? []).map((value) => value.trim()).filter(Boolean)),
  ).slice(0, limit);
}

function deriveOverallStatus(
  resolved: boolean,
  toolCorrect: boolean,
  hallucinationSafe: boolean,
  pathScore: number,
): AuditOverallStatus {
  if (!resolved || !hallucinationSafe) return "failed";
  if (!toolCorrect || pathScore < 0.8) return "needs_work";
  return "great";
}

function mergeAudit(
  recordContext: AuditInputContext,
  llmAudit: LlmAuditShape | undefined,
): CallAuditRecord {
  const {
    record,
    intentBucketGuess,
    deterministicTool,
    repeatedQuestionCount,
    extraTurns,
  } = recordContext;
  const finalToolIssues = dedupe(
    [
      ...(llmAudit?.toolCorrectness?.issues ?? []),
      ...deterministicTool.issues,
      ...(repeatedQuestionCount > 0
        ? [`assistant repeated a question ${repeatedQuestionCount} time(s)`]
        : []),
    ],
    8,
  );
  const toolCorrectness = {
    pass: Boolean(llmAudit?.toolCorrectness?.pass) && deterministicTool.pass,
    issues: finalToolIssues,
    malformedArgs: deterministicTool.malformedArgs,
    missingRequiredArgs: deterministicTool.missingRequiredArgs,
    sequenceIssues: deterministicTool.sequenceIssues,
  };
  const pathIssues = dedupe(
    [
      ...(llmAudit?.pathEfficiency?.issues ?? []),
      ...(repeatedQuestionCount > 0
        ? [`assistant repeated a question ${repeatedQuestionCount} time(s)`]
        : []),
      ...(extraTurns > 0
        ? [
            `call took about ${extraTurns} turn(s) more than the current target path`,
          ]
        : []),
    ],
    8,
  );
  const pathScore = Math.max(
    0,
    Math.min(1, Number(llmAudit?.pathEfficiency?.score ?? 0.5)),
  );
  const hallucinationIssues = dedupe(
    llmAudit?.hallucinationSafety?.issues ?? [],
    6,
  );
  const failureModes = new Set<AuditFailureMode>(llmAudit?.failureModes ?? []);
  if (!toolCorrectness.pass) {
    if (
      toolCorrectness.malformedArgs.length > 0 ||
      toolCorrectness.missingRequiredArgs.length > 0
    ) {
      failureModes.add("bad_tool_args");
    }
    if (toolCorrectness.sequenceIssues.length > 0) {
      failureModes.add("wrong_tool_order");
    }
  }
  if (repeatedQuestionCount > 0) failureModes.add("repeat_question");
  if (pathScore < 0.75 || extraTurns > 0) failureModes.add("slow_path");
  if (
    hallucinationIssues.length > 0 ||
    llmAudit?.hallucinationSafety?.pass === false
  ) {
    failureModes.add("hallucination");
  }

  const intentBucket = normalizeIntentBucket(
    llmAudit?.intentBucket,
    intentBucketGuess,
  );
  const resolved = Boolean(llmAudit?.resolved);
  const hallucinationSafety = {
    pass:
      Boolean(llmAudit?.hallucinationSafety?.pass) &&
      hallucinationIssues.length === 0,
    issues: hallucinationIssues,
  };

  return {
    callId: record.callId,
    startedAt: record.startedAt,
    durationSec: record.durationSec,
    totalTurns: record.totalTurns ?? record.data.turns.length,
    officePhone: record.officePhone,
    intentBucket,
    intentBucketGuess,
    overallStatus: deriveOverallStatus(
      resolved,
      toolCorrectness.pass,
      hallucinationSafety.pass,
      pathScore,
    ),
    resolved,
    resolutionReason:
      llmAudit?.resolutionReason?.trim() || "No resolution analysis returned.",
    failureModes: Array.from(failureModes),
    toolCorrectness,
    pathEfficiency: {
      score: pathScore,
      issues: pathIssues,
      repeatedQuestionCount,
      extraTurns,
    },
    hallucinationSafety,
    strengths: dedupe(llmAudit?.strengths ?? [], 4),
    recommendedFixes: dedupe(llmAudit?.recommendedFixes ?? [], 4),
    toolCalls: extractAuditToolCalls(record),
    metrics: {
      toolCallCount: record.data.turns.reduce(
        (sum, turn) => sum + turn.toolCalls.length,
        0,
      ),
      toolErrorCount: record.data.turns.reduce(
        (sum, turn) =>
          sum + turn.toolCalls.filter((toolCall) => toolCall.isError).length,
        0,
      ),
      transferred: record.data.turns.some((turn) =>
        turn.toolCalls.some((toolCall) => toolCall.name === "transfer_call"),
      ),
      repeatedQuestionCount,
      extraTurns,
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runbook = readFileSync(RUNBOOK_PATH, "utf-8");
  const rows = fetchRecentCalls(args);
  const records = normalizeCallEvents(rows);
  console.log(
    `Auditing ${records.length} call(s) from the past ${args.hours}h`,
  );

  if (records.length === 0) {
    console.log("No calls to audit.");
    return;
  }

  const prepared = records.map((record) => {
    const intentBucketGuess = inferIntentBucket(record);
    return {
      record,
      intentBucketGuess,
      deterministicTool: summarizeDeterministicToolCorrectness(
        record,
        intentBucketGuess,
      ),
      repeatedQuestionCount: countRepeatedAssistantQuestions(record),
      extraTurns: computeExtraTurns(record, intentBucketGuess),
    } satisfies AuditInputContext;
  });

  const llmAuditsByCallId = new Map<string, LlmAuditShape>();
  for (const batch of chunk(prepared, Math.max(1, AUDIT_BATCH_SIZE))) {
    const prompt = buildAuditPrompt(runbook, batch);
    const responseText = await callAuditModel(prompt);
    const llmAudits = parseLlmAudits(responseText);
    for (const llmAudit of llmAudits) {
      llmAuditsByCallId.set(llmAudit.callId, llmAudit);
    }
    console.log(
      `  audited batch of ${batch.length} (${llmAuditsByCallId.size}/${prepared.length})`,
    );
  }

  const audits = prepared.map((context) =>
    mergeAudit(context, llmAuditsByCallId.get(context.record.callId)),
  );
  const date = new Date().toISOString().slice(0, 10);
  const report = summarizeAuditReport(audits, date, args.hours);
  const outPath = join(OUTPUT_DIR, `audits-${date}.json`);
  ensureDir(OUTPUT_DIR);
  writeJSON(outPath, report);

  console.log(`Wrote ${outPath}`);
  console.log(
    `Resolved ${report.overall.resolved}/${report.totalCalls}, tool-correct ${report.overall.toolCorrect}/${report.totalCalls}, hallucination-safe ${report.overall.hallucinationSafe}/${report.totalCalls}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
