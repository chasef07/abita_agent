/**
 * Asks a bounded LLM proposer to suggest N variant edits to the agent's prompt files,
 * targeting recent eval failures and real-call buckets. Each variant is
 * written to its own workspace-vN/ directory so the tournament can score it.
 *
 * Usage:
 *   npx tsx evals/scripts/propose-variants.ts --variants 3 [--eval-id <id>]
 *
 * Inputs (all auto-discovered):
 *   - workspace/<files in PROPOSER_EDIT_FILES> (default RUNBOOK.md, VOICE.md, SOUL.md)
 *   - latest promptfoo eval (or --eval-id) → eval failures
 *   - latest evals/output/audits-*.json → structured production-call audit
 *
 * Env:
 *   OPENAI_API_KEY or ANTHROPIC_API_KEY required
 *   PROPOSER_PROVIDER       optional explicit override; otherwise inferred from model
 *   PROPOSER_MODEL          default gpt-4.1-mini or claude-sonnet-4-5 based on provider
 *   PROPOSER_EDIT_FILES     comma-separated list of workspace files the proposer may edit;
 *                           default "RUNBOOK.md,VOICE.md,SOUL.md"
 *
 * Outputs:
 *   - workspace-v1/, workspace-v2/, ...   (each is a complete workspace copy with edits applied)
 *   - evals/output/variants-(timestamp).json (manifest with hypotheses)
 */

import "dotenv/config";
import { execSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  OUTPUT_DIR,
  REPO_ROOT,
  WORKSPACE_DIR,
  ensureDir,
  findLatestOutput,
  readJSON,
  timestampSlug,
  writeJSON,
} from "../lib/io.js";
import {
  derivePromptTargets,
  summarizeCodeBacklog,
  summarizePromptTargets,
  type PromptTargetSignal,
} from "../lib/prompt-targets.js";

function defaultProposerProvider(): "openai" | "anthropic" {
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  return "anthropic";
}

const PROPOSER_PROVIDER_OVERRIDE = process.env.PROPOSER_PROVIDER as
  | "openai"
  | "anthropic"
  | undefined;
const PROPOSER_MODEL =
  process.env.PROPOSER_MODEL ??
  ((PROPOSER_PROVIDER_OVERRIDE ?? defaultProposerProvider()) === "openai"
    ? "gpt-4.1-mini"
    : "claude-sonnet-4-5");

function inferProposerProvider(model: string): "openai" | "anthropic" {
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

const PROPOSER_PROVIDER =
  PROPOSER_PROVIDER_OVERRIDE ?? inferProposerProvider(PROPOSER_MODEL);
const PROPOSER_MAX_TOKENS = 32000;
const DEFAULT_EDITABLE_FILES = ["RUNBOOK.md", "VOICE.md", "SOUL.md"];

interface Args {
  variants: number;
  evalId?: string;
}

interface VariantFile {
  path: string;
  content: string;
}

interface Variant {
  id: string;
  hypothesis: string;
  focus?: string;
  scope?: "prompt-layer" | "tool-layer";
  files: VariantFile[];
}

interface AuditRecordSummary {
  callId: string;
  intentBucket: string;
  overallStatus: "great" | "needs_work" | "failed";
  resolved: boolean;
  resolutionReason: string;
  failureModes: string[];
  strengths: string[];
  recommendedFixes: string[];
}

interface AuditBucketSummary {
  total: number;
  resolved: number;
  toolCorrect: number;
  hallucinationSafe: number;
  avgTurns: number;
  avgPathScore: number;
}

interface AuditReport {
  date: string;
  totalCalls: number;
  overall: {
    resolved: number;
    toolCorrect: number;
    hallucinationSafe: number;
  };
  byBucket: Record<string, AuditBucketSummary>;
  failureModeCounts: Record<string, number>;
  strengthCounts: Record<string, number>;
  audits: AuditRecordSummary[];
}

interface FailureRecord {
  caseId: string;
  source: "golden" | "candidates" | "unknown";
  suite: string;
  conversation: Array<{ role: string; content: string }>;
  agentResponse: string;
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
  judgeReason: string;
}

interface FailureCluster {
  key: string;
  source: FailureRecord["source"];
  suite: string;
  issue: string;
  scope: "prompt-layer" | "tool-layer";
  count: number;
  examples: FailureRecord[];
}

interface SuiteScore {
  pass: number;
  total: number;
}

interface TournamentVariantScore {
  workspace: string;
  evalId: string;
  goldenPass: number;
  goldenTotal: number;
  candidatePass: number;
  candidateTotal: number;
  perSuite: Record<string, { golden: SuiteScore; candidates: SuiteScore }>;
}

interface TournamentReport {
  scores: TournamentVariantScore[];
}

interface RegressionTrap {
  workspace: string;
  scope: "golden" | "candidates";
  suite: string;
  baseline: string;
  variant: string;
}

interface AuditFailureCluster {
  key: string;
  intentBucket: string;
  failureMode: string;
  scope: "prompt-layer" | "tool-layer";
  count: number;
  examples: AuditRecordSummary[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = { variants: 3 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--variants" && argv[i + 1])
      args.variants = Number.parseInt(argv[i + 1], 10);
    if (argv[i] === "--eval-id" && argv[i + 1]) args.evalId = argv[i + 1];
  }
  return args;
}

function editableFiles(): string[] {
  const raw = process.env.PROPOSER_EDIT_FILES;
  if (!raw) return DEFAULT_EDITABLE_FILES;
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function getLatestEvalId(): string {
  const stdout = execSync("npx promptfoo list evals 2>/dev/null", {
    encoding: "utf-8",
    maxBuffer: 4 * 1024 * 1024,
  });
  const matches = stdout.match(/eval-[A-Za-z0-9]+-\d{4}-\d{2}-\d{2}T[\d:.]+/g);
  if (!matches || matches.length === 0) {
    throw new Error(
      "No promptfoo eval found. Run `npm run evals:run` first or pass --eval-id.",
    );
  }
  return matches[matches.length - 1];
}

function exportEval(evalId: string): unknown {
  const tmpFile = `/tmp/eval-${evalId}.json`;
  execSync(`npx promptfoo export eval ${evalId} -o ${tmpFile}`, {
    encoding: "utf-8",
  });
  return JSON.parse(readFileSync(tmpFile, "utf-8"));
}

function extractFailures(evalData: any): FailureRecord[] {
  const failures: FailureRecord[] = [];
  for (const result of evalData.results?.results ?? []) {
    if (result.success !== false) continue;
    const output = (() => {
      try {
        return typeof result.response?.output === "string"
          ? JSON.parse(result.response.output)
          : (result.response?.output ?? {});
      } catch {
        return {};
      }
    })();
    const casePath = result.testCase?.vars?.casePath ?? "";
    const source = casePath.startsWith("evals/cases/golden/")
      ? "golden"
      : casePath.startsWith("evals/cases/candidates/")
        ? "candidates"
        : "unknown";
    let conversation: Array<{ role: string; content: string }> = [];
    try {
      const caseFile = JSON.parse(
        readFileSync(join(REPO_ROOT, casePath), "utf-8"),
      );
      conversation = caseFile.conversation ?? [];
    } catch {
      // Missing or malformed case context should not block proposal generation.
    }
    const judgeReason = (result.gradingResult?.componentResults ?? [])
      .filter((entry: any) => entry.pass === false)
      .map(
        (entry: any) =>
          `[${entry.assertion?.type}] ${(entry.reason ?? "").split("\n").slice(0, 4).join(" ")}`,
      )
      .join(" || ");
    failures.push({
      caseId: result.testCase?.vars?.caseId ?? casePath,
      source,
      suite: result.testCase?.metadata?.suite ?? "?",
      conversation,
      agentResponse:
        typeof output.finalText === "string" ? output.finalText : "",
      toolCalls: Array.isArray(output.toolCalls) ? output.toolCalls : [],
      judgeReason,
    });
  }
  return failures;
}

function summarizeFailures(
  failures: FailureRecord[],
  maxPerSource: number,
): string {
  const byPriority = [
    ...failures.filter((failure) => failure.source === "golden"),
    ...failures
      .filter((failure) => failure.source === "candidates")
      .slice(0, maxPerSource),
  ];
  return byPriority
    .map((failure) => {
      const conversationText = failure.conversation
        .map((msg) => `  ${msg.role.toUpperCase()}: ${msg.content}`)
        .join("\n");
      const toolText =
        failure.toolCalls
          .map(
            (toolCall) => `${toolCall.name}(${JSON.stringify(toolCall.args)})`,
          )
          .join(", ") || "(none)";
      return [
        `## ${failure.source.toUpperCase()} :: ${failure.suite} :: ${failure.caseId}`,
        `Conversation:`,
        conversationText,
        `Agent response: ${failure.agentResponse}`,
        `Tools called: ${toolText}`,
        `Judge said: ${failure.judgeReason}`,
      ].join("\n");
    })
    .join("\n\n");
}

function loadLatestAuditReport(): AuditReport | undefined {
  return readJSON<AuditReport>(findLatestOutput("audits-"));
}

function loadLatestTournamentReport(): TournamentReport | undefined {
  return readJSON<TournamentReport>(findLatestOutput("tournament-"));
}

function inferFailureIssue(failure: FailureRecord): string {
  const text = `${failure.judgeReason} ${failure.agentResponse}`.toLowerCase();
  if (
    failure.suite === "confirm" &&
    !failure.toolCalls.some((call) => call.name === "confirm_appt")
  ) {
    return "confirm path missing confirm_appt grounding";
  }
  if (failure.suite === "registration" && text.includes("check_insurance")) {
    return "registration insurance-gate or ordering violation";
  }
  if (failure.suite === "registration" && text.includes("add_patient")) {
    return "registration submission/readback violation";
  }
  if (
    failure.suite === "cancel" &&
    !failure.toolCalls.some((call) => call.name === "cancel_appt")
  ) {
    return "cancel path missing cancel_appt";
  }
  if (failure.suite === "routing" && text.includes("spring hill")) {
    return "routing rule violated";
  }
  if (failure.suite === "transfer" && text.includes("transfer")) {
    return "transfer policy or phrasing violation";
  }
  if (failure.suite === "safety") {
    return "clinical safety response violation";
  }
  const firstReason = failure.judgeReason
    .split("||")[0]
    ?.replace(/\[[^\]]+\]\s*/g, "")
    .trim();
  return firstReason || `${failure.suite} behavior mismatch`;
}

function inferFailureScope(
  failure: FailureRecord,
): "prompt-layer" | "tool-layer" {
  const text = `${failure.judgeReason} ${failure.agentResponse}`.toLowerCase();
  if (
    text.includes("missing required") ||
    text.includes("argument") ||
    text.includes("malformed") ||
    text.includes("wrong parameter") ||
    text.includes("tool schema") ||
    text.includes("tool contract")
  ) {
    return "tool-layer";
  }
  if (
    failure.suite === "confirm" ||
    text.includes("confirm_appt") ||
    text.includes("check_insurance") ||
    text.includes("cancel_appt") ||
    text.includes("book_appt") ||
    text.includes("add_patient")
  ) {
    return "tool-layer";
  }
  return "prompt-layer";
}

function clusterFailures(failures: FailureRecord[]): FailureCluster[] {
  const clustered = new Map<string, FailureCluster>();
  for (const failure of failures) {
    const issue = inferFailureIssue(failure);
    const key = `${failure.source}:${failure.suite}:${issue}`;
    const current = clustered.get(key) ?? {
      key,
      source: failure.source,
      suite: failure.suite,
      issue,
      scope: inferFailureScope(failure),
      count: 0,
      examples: [],
    };
    current.count += 1;
    if (current.examples.length < 2) current.examples.push(failure);
    clustered.set(key, current);
  }
  return Array.from(clustered.values()).sort(
    (a, b) =>
      b.count - a.count ||
      a.source.localeCompare(b.source) ||
      a.suite.localeCompare(b.suite),
  );
}

function summarizeFailureClusters(failures: FailureRecord[]): string {
  const clusters = clusterFailures(failures);
  if (clusters.length === 0) return "(no eval failure clusters)";
  return clusters
    .slice(0, 8)
    .map((cluster) => {
      const examples = cluster.examples
        .map(
          (example) =>
            `  - ${example.caseId}: ${example.judgeReason || "(no judge reason)"}`,
        )
        .join("\n");
      return [
        `- ${cluster.source.toUpperCase()} ${cluster.suite} × ${cluster.count}: ${cluster.issue}`,
        `  scope=${cluster.scope}`,
        examples,
      ].join("\n");
    })
    .join("\n");
}

function clusterAuditFailures(
  report: AuditReport | undefined,
): AuditFailureCluster[] {
  if (!report) return [];
  const clustered = new Map<string, AuditFailureCluster>();
  for (const audit of report.audits.filter(
    (entry) => entry.overallStatus !== "great",
  )) {
    const failureMode = audit.failureModes[0] ?? "quality_gap";
    const key = `${audit.intentBucket}:${failureMode}`;
    const current = clustered.get(key) ?? {
      key,
      intentBucket: audit.intentBucket,
      failureMode,
      scope: [
        "wrong_tool",
        "wrong_tool_order",
        "hallucination",
        "toolCorrectness",
      ].includes(failureMode)
        ? "tool-layer"
        : "prompt-layer",
      count: 0,
      examples: [],
    };
    current.count += 1;
    if (current.examples.length < 2) current.examples.push(audit);
    clustered.set(key, current);
  }
  return Array.from(clustered.values()).sort(
    (a, b) => b.count - a.count || a.intentBucket.localeCompare(b.intentBucket),
  );
}

function summarizeAuditClusters(report: AuditReport | undefined): string {
  const clusters = clusterAuditFailures(report);
  if (clusters.length === 0) return "(no audit failure clusters)";
  return clusters
    .slice(0, 8)
    .map((cluster) => {
      const examples = cluster.examples
        .map(
          (example) =>
            `  - ${example.callId}: ${example.resolutionReason} | fixes=${example.recommendedFixes.join(" | ") || "none"}`,
        )
        .join("\n");
      return [
        `- ${cluster.intentBucket} × ${cluster.count}: ${cluster.failureMode}`,
        `  scope=${cluster.scope}`,
        examples,
      ].join("\n");
    })
    .join("\n");
}

function collectPromptTargetSignals(
  failures: FailureRecord[],
  auditReport: AuditReport | undefined,
): PromptTargetSignal[] {
  const failureSignals = clusterFailures(failures).map((cluster) => ({
    source: "eval" as const,
    suiteOrBucket: cluster.suite,
    issue: cluster.issue,
    count: cluster.count,
  }));
  const auditSignals = clusterAuditFailures(auditReport).map((cluster) => ({
    source: "audit" as const,
    suiteOrBucket: cluster.intentBucket,
    issue: cluster.examples[0]?.recommendedFixes[0] || cluster.failureMode,
    count: cluster.count,
  }));
  return [...failureSignals, ...auditSignals];
}

function summarizeRegressionTraps(
  report: TournamentReport | undefined,
): string {
  if (!report) return "(no prior tournament report)";
  const baseline = report.scores.find(
    (entry) => entry.workspace === "workspace",
  );
  if (!baseline) return "(no baseline in prior tournament report)";
  const traps: RegressionTrap[] = [];
  for (const variant of report.scores.filter(
    (entry) => entry.workspace !== "workspace",
  )) {
    for (const [suite, scores] of Object.entries(variant.perSuite)) {
      const baselineGolden = baseline.perSuite[suite]?.golden;
      if (
        baselineGolden &&
        (scores.golden.pass !== baselineGolden.pass ||
          scores.golden.total !== baselineGolden.total)
      ) {
        traps.push({
          workspace: variant.workspace,
          scope: "golden",
          suite,
          baseline: `${baselineGolden.pass}/${baselineGolden.total}`,
          variant: `${scores.golden.pass}/${scores.golden.total}`,
        });
      }
      const baselineCandidates = baseline.perSuite[suite]?.candidates;
      if (
        baselineCandidates &&
        (scores.candidates.pass !== baselineCandidates.pass ||
          scores.candidates.total !== baselineCandidates.total)
      ) {
        traps.push({
          workspace: variant.workspace,
          scope: "candidates",
          suite,
          baseline: `${baselineCandidates.pass}/${baselineCandidates.total}`,
          variant: `${scores.candidates.pass}/${scores.candidates.total}`,
        });
      }
    }
  }
  if (traps.length === 0) return "(no regressions in prior tournament report)";
  return traps
    .slice(0, 12)
    .map(
      (trap) =>
        `- ${trap.workspace} regressed ${trap.scope} ${trap.suite}: ${trap.baseline} -> ${trap.variant}`,
    )
    .join("\n");
}

function summarizeAudits(report: AuditReport | undefined): string {
  if (!report) return "(no structured audit available)";

  const lines: string[] = [
    `Structured audit snapshot: ${report.totalCalls} calls audited.`,
    `Resolved=${report.overall.resolved}/${report.totalCalls}, tool-correct=${report.overall.toolCorrect}/${report.totalCalls}, hallucination-safe=${report.overall.hallucinationSafe}/${report.totalCalls}.`,
    "",
    "BUCKETS:",
  ];

  for (const [bucket, summary] of Object.entries(report.byBucket)) {
    if (summary.total === 0) continue;
    lines.push(
      `- ${bucket}: calls=${summary.total}, resolved=${summary.resolved}/${summary.total}, tool-correct=${summary.toolCorrect}/${summary.total}, hallucination-safe=${summary.hallucinationSafe}/${summary.total}, avgTurns=${summary.avgTurns}, avgPathScore=${summary.avgPathScore}`,
    );
  }

  const weakest = report.audits
    .filter((audit) => audit.overallStatus !== "great")
    .slice(0, 10);
  if (weakest.length > 0) {
    lines.push("");
    lines.push("WEAKEST CALLS (sample):");
    for (const audit of weakest) {
      lines.push(
        `- [${audit.intentBucket}] ${audit.callId}: ${audit.resolutionReason} | failureModes=${audit.failureModes.join(", ") || "none"} | fixes=${audit.recommendedFixes.join(" | ") || "none"}`,
      );
    }
  }

  const strongest = report.audits
    .filter((audit) => audit.strengths.length > 0)
    .slice(0, 6);
  if (strongest.length > 0) {
    lines.push("");
    lines.push("STRENGTHS (sample):");
    for (const audit of strongest) {
      lines.push(
        `- [${audit.intentBucket}] ${audit.callId}: ${audit.strengths.join(" | ")}`,
      );
    }
  }

  return lines.join("\n");
}

function readEditableFileContents(files: string[]): VariantFile[] {
  const out: VariantFile[] = [];
  for (const filename of files) {
    const fullPath = join(WORKSPACE_DIR, filename);
    if (!existsSync(fullPath)) {
      console.warn(`Skipping ${filename}: not found in workspace/`);
      continue;
    }
    out.push({ path: filename, content: readFileSync(fullPath, "utf-8") });
  }
  return out;
}

function buildProposerPrompt(args: {
  baselineFiles: VariantFile[];
  failuresSummary: string;
  failureClusterSummary: string;
  callBucketsSummary: string;
  auditClusterSummary: string;
  regressionTrapSummary: string;
  promptTargetSummary: string;
  codeBacklogSummary: string;
  variants: number;
  editableFilenames: string[];
}): string {
  const baselineSection = args.baselineFiles
    .map((file) => `## ${file.path}\n\n${file.content}`)
    .join("\n\n---\n\n");

  return [
    "You are an expert prompt engineer iterating on a voice agent's prompt stack.",
    "",
    `Your goal: propose ${args.variants} distinct edited prompt variants that would (a) fix the promptfoo failures and (b) improve real production-call audit outcomes. Each variant should test a different hypothesis about a narrow failure cluster.`,
    "",
    "Editable files this round:",
    args.editableFilenames.map((entry) => `- ${entry}`).join("\n"),
    "",
    "Constraints:",
    `- You may edit ANY of the editable files in any combination per variant. A variant might edit just RUNBOOK.md, or RUNBOOK.md + VOICE.md, or just SOUL.md, etc.`,
    "- Each variant must focus on 1 primary cluster and at most 1 secondary cluster. Do not try to fix everything at once.",
    "- Prefer the smallest viable edit that changes the targeted behavior. Do not broadly rewrite unrelated sections.",
    "- Protect working behavior in suites that are not part of the chosen target cluster.",
    "- Treat prompt-layer and tool-layer failures differently. Prompt-layer failures are eligible for prompt edits. Tool-layer failures should usually produce a very small prompt clarification at most; do not paper over a broken tool contract with a broad prompt rewrite.",
    "- Stay faithful to the agent's voice: confident, concise, warm. No corporate-speak.",
    '- Write rules as positive directives ("Always X", "Stay in role") rather than negative prohibitions where possible.',
    "- You may delete noisy, redundant, stale, or conflicting prompt text when that is the cleanest way to improve the targeted behavior. Concision is a valid improvement.",
    "- Do not invent new tools or change tool semantics. You can change instructions about when/how to use existing tools.",
    "- Each variant must be a COMPLETE replacement for each file you edit, not a diff.",
    "- Only include files in the variant's `files` array that you actually changed. Unchanged files do not need to be returned.",
    "- IMPORTANT: do not include any patient names, dates of birth, phone numbers, member IDs, or other PHI in your hypothesis text or anywhere in the response. Refer to calls by callId and turn number only.",
    "",
    "# CURRENT PROMPT FILES",
    "",
    baselineSection,
    "",
    "# REAL-CALL BUCKETS (last 24h)",
    "",
    args.callBucketsSummary,
    "",
    "# REAL-CALL FAILURE CLUSTERS",
    "",
    args.auditClusterSummary,
    "",
    "# PRIOR TOURNAMENT REGRESSION TRAPS",
    "",
    args.regressionTrapSummary,
    "",
    "# PROMPT-ELIGIBLE TARGETS",
    "",
    args.promptTargetSummary,
    "",
    "# CODE-FIRST BACKLOG (DO NOT SPEND WHOLE VARIANTS HERE)",
    "",
    args.codeBacklogSummary,
    "",
    "# EVAL FAILURE CLUSTERS",
    "",
    args.failureClusterSummary,
    "",
    "# EVAL FAILURES",
    "",
    args.failuresSummary,
    "",
    "# PLANNING REQUIREMENTS",
    "",
    "- Variants should not all target the same cluster.",
    "- Prefer the ranked prompt-eligible targets above. Use them to decide exactly which file and section to edit.",
    "- If a target points to RUNBOOK.md sections, make the smallest possible edit in those sections rather than rewriting the whole file tone.",
    "- Do not spend a whole variant on a code-first backlog item. At most, add a tiny clarifying sentence if it helps the model respect the current contract.",
    "- If a prior tournament regressed confirm, cancel, routing, or registration, do not make broad edits that touch those behaviors unless that suite is the explicit target cluster.",
    "- If you target confirm behavior, make confirm_appt grounding explicit without changing unrelated transfer, routing, or registration rules.",
    "- If you target registration behavior, focus on insurance-gate order, readback, and add_patient submission requirements without changing confirm or transfer rules.",
    "- If a cluster is labeled tool-layer, prefer either (a) no prompt change, or (b) a tiny rule clarifying when to call the tool. Do not rewrite broad behavioral sections to compensate for a tool-level issue.",
    "- If there are fewer strong prompt-eligible targets than requested variants, use the extra variants to try alternative phrasings for the top-ranked targets instead of inventing new broad rewrites.",
    "",
    "# OUTPUT FORMAT",
    "",
    "Return a JSON object exactly matching this shape (no markdown, no preamble):",
    JSON.stringify(
      {
        variants: [
          {
            id: "v1",
            hypothesis:
              "one sentence — what this narrow variant changes and why",
            focus: "the exact cluster this variant targets",
            scope: "prompt-layer",
            files: [
              {
                path: "RUNBOOK.md",
                content: "<full edited content of RUNBOOK.md>",
              },
            ],
          },
        ],
      },
      null,
      2,
    ),
    "",
    `Return exactly ${args.variants} variants. Each \`files[].content\` field is the full file content as a JSON string (escape newlines).`,
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

async function callProposerModel(prompt: string): Promise<string> {
  if (PROPOSER_PROVIDER === "openai") {
    if (!process.env.OPENAI_API_KEY)
      throw new Error("OPENAI_API_KEY is required");
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: PROPOSER_MODEL,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
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
    if (Array.isArray(content))
      return content.map((part) => part.text ?? "").join("");
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
      model: PROPOSER_MODEL,
      max_tokens: PROPOSER_MAX_TOKENS,
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

function parseVariantsResponse(
  text: string,
  editableFilenames: string[],
): Variant[] {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch)
    throw new Error(
      "Proposer response did not contain JSON: " + text.slice(0, 500),
    );
  const parsed = JSON.parse(jsonMatch[0]) as {
    variants: Array<{
      id?: string;
      hypothesis?: string;
      files?: VariantFile[];
    }>;
  };
  if (!Array.isArray(parsed.variants))
    throw new Error("Proposer JSON missing 'variants' array");
  const allowed = new Set(editableFilenames);
  return parsed.variants
    .map((variant, index) => {
      const files = (variant.files ?? [])
        .filter((file) => file.path && file.content && allowed.has(file.path))
        .map((file) => ({ path: file.path, content: file.content }));
      return {
        id: variant.id ?? `v${index + 1}`,
        hypothesis: variant.hypothesis ?? "",
        focus:
          typeof (variant as { focus?: string }).focus === "string"
            ? (variant as { focus?: string }).focus
            : undefined,
        scope: (variant as { scope?: "prompt-layer" | "tool-layer" }).scope,
        files,
      };
    })
    .filter((variant) => variant.files.length > 0);
}

function copyAllWorkspaceFiles(srcDir: string, destDir: string) {
  for (const entry of readdirSync(srcDir)) {
    const srcPath = join(srcDir, entry);
    if (statSync(srcPath).isDirectory()) continue;
    copyFileSync(srcPath, join(destDir, entry));
  }
}

function writeVariant(variant: Variant): {
  dir: string;
  editedFiles: string[];
} {
  const dirName = `workspace-${variant.id}`;
  const dirPath = join(REPO_ROOT, dirName);
  if (existsSync(dirPath)) rmSync(dirPath, { recursive: true });
  mkdirSync(dirPath, { recursive: true });
  copyAllWorkspaceFiles(WORKSPACE_DIR, dirPath);
  for (const file of variant.files) {
    const out = file.content.endsWith("\n")
      ? file.content
      : `${file.content}\n`;
    writeFileSync(join(dirPath, file.path), out, "utf-8");
  }
  return { dir: dirName, editedFiles: variant.files.map((file) => file.path) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const evalId = args.evalId ?? getLatestEvalId();
  console.log(`Using eval ${evalId}`);

  const evalData = exportEval(evalId);
  const failures = extractFailures(evalData);
  const goldenFailures = failures.filter(
    (failure) => failure.source === "golden",
  ).length;
  const candidateFailures = failures.filter(
    (failure) => failure.source === "candidates",
  ).length;
  console.log(
    `Found ${failures.length} eval failures (${goldenFailures} golden, ${candidateFailures} candidates)`,
  );

  const auditReport = loadLatestAuditReport();
  const tournamentReport = loadLatestTournamentReport();
  const callBucketsSummary = summarizeAudits(auditReport);
  const auditClusterSummary = summarizeAuditClusters(auditReport);
  const failureClusterSummary = summarizeFailureClusters(failures);
  const regressionTrapSummary = summarizeRegressionTraps(tournamentReport);
  const failuresSummary = summarizeFailures(failures, 12);
  const { targets, backlog } = derivePromptTargets(
    collectPromptTargetSignals(failures, auditReport),
  );
  const promptTargetSummary = summarizePromptTargets(targets);
  const codeBacklogSummary = summarizeCodeBacklog(backlog);

  const hasAuditFailures = auditReport
    ? auditReport.audits.some((audit) => audit.overallStatus !== "great")
    : false;

  if (failures.length === 0 && !hasAuditFailures) {
    console.log(
      "Nothing to propose — eval is clean and no failed calls today.",
    );
    return;
  }

  const editableFilenames = editableFiles();
  console.log(`Editable files this round: ${editableFilenames.join(", ")}`);
  const baselineFiles = readEditableFileContents(editableFilenames);
  if (baselineFiles.length === 0) {
    throw new Error(
      "No editable files found. Check PROPOSER_EDIT_FILES env var.",
    );
  }

  const prompt = buildProposerPrompt({
    baselineFiles,
    failuresSummary,
    failureClusterSummary,
    callBucketsSummary,
    auditClusterSummary,
    regressionTrapSummary,
    promptTargetSummary,
    codeBacklogSummary,
    variants: args.variants,
    editableFilenames,
  });

  console.log(
    `Calling ${PROPOSER_MODEL} with ${args.variants} variants requested...`,
  );
  const responseText = await callProposerModel(prompt);
  const variants = parseVariantsResponse(responseText, editableFilenames);
  if (variants.length === 0) {
    throw new Error(
      `Proposer returned 0 valid variants. Response head: ${responseText.slice(0, 800)}`,
    );
  }
  console.log(`Got ${variants.length} valid variants back.`);

  const written: Array<{
    id: string;
    dir: string;
    hypothesis: string;
    focus?: string;
    scope?: string;
    editedFiles: string[];
  }> = [];
  for (const variant of variants) {
    const { dir, editedFiles } = writeVariant(variant);
    written.push({
      id: variant.id,
      dir,
      hypothesis: variant.hypothesis,
      focus: variant.focus,
      scope: variant.scope,
      editedFiles,
    });
    console.log(
      `  ${variant.id} → ${dir} [${variant.scope ?? "unspecified"}] focus=${variant.focus ?? "n/a"} (edits: ${editedFiles.join(", ")}) | ${variant.hypothesis}`,
    );
  }

  ensureDir(OUTPUT_DIR);
  const reportPath = join(OUTPUT_DIR, `variants-${timestampSlug()}.json`);
  writeJSON(reportPath, {
    evalId,
    baseline: "workspace",
    editableFiles: editableFilenames,
    promptTargets: targets,
    codeBacklog: backlog,
    variants: written,
  });
  console.log(`Wrote variant manifest to ${reportPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
