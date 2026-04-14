/**
 * Generates a markdown report of tool-layer recommendations derived from the
 * latest audit report and baseline promptfoo failures.
 *
 * Output:
 *   evals/output/tool-recommendations.md
 */

import "dotenv/config";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  OUTPUT_DIR,
  ensureDir,
  findLatestOutput,
  readJSON,
  writeText,
} from "../lib/io.js";

interface AuditRecord {
  callId: string;
  intentBucket: string;
  failureModes: string[];
  resolutionReason: string;
  recommendedFixes: string[];
  toolCorrectness: { pass: boolean; issues: string[] };
  hallucinationSafety: { pass: boolean; issues: string[] };
}

interface AuditReport {
  totalCalls: number;
  audits: AuditRecord[];
}

interface SuiteScore {
  pass: number;
  total: number;
}

interface TournamentVariantScore {
  workspace: string;
  evalId: string;
  perSuite: Record<string, { golden: SuiteScore; candidates: SuiteScore }>;
}

interface TournamentReport {
  scores: TournamentVariantScore[];
}

interface EvalFailure {
  caseId: string;
  source: "golden" | "candidates" | "unknown";
  suite: string;
  judgeReason: string;
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
}

interface RecommendationCluster {
  key: string;
  source: "audit" | "eval";
  suiteOrBucket: string;
  issue: string;
  count: number;
  examples: string[];
}

const OUTPUT_PATH = join(OUTPUT_DIR, "tool-recommendations.md");

function loadLatestAuditReport(): AuditReport | undefined {
  return readJSON<AuditReport>(findLatestOutput("audits-"));
}

function loadLatestTournamentReport(): TournamentReport | undefined {
  return readJSON<TournamentReport>(findLatestOutput("tournament-"));
}

function getBaselineEvalId(
  report: TournamentReport | undefined,
): string | undefined {
  return report?.scores.find((entry) => entry.workspace === "workspace")
    ?.evalId;
}

function exportEval(evalId: string): unknown {
  const tmpFile = `/tmp/eval-${evalId}.json`;
  execSync(`npx promptfoo export eval ${evalId} -o ${tmpFile}`, {
    encoding: "utf-8",
  });
  return JSON.parse(readFileSync(tmpFile, "utf-8"));
}

function extractFailures(evalData: any): EvalFailure[] {
  const failures: EvalFailure[] = [];
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
      judgeReason,
      toolCalls: Array.isArray(output.toolCalls) ? output.toolCalls : [],
    });
  }
  return failures;
}

function inferToolLayerIssue(failure: EvalFailure): string | undefined {
  const text = `${failure.judgeReason}`.toLowerCase();
  if (
    failure.suite === "confirm" &&
    !failure.toolCalls.some((call) => call.name === "confirm_appt")
  ) {
    return "confirm_appt grounding or context contract is unclear";
  }
  if (failure.suite === "registration" && text.includes("check_insurance")) {
    return "registration insurance-gate ordering needs stronger enforcement";
  }
  if (failure.suite === "registration" && text.includes("add_patient")) {
    return "add_patient preconditions or readback contract are too loose";
  }
  if (
    failure.suite === "cancel" &&
    !failure.toolCalls.some((call) => call.name === "cancel_appt")
  ) {
    return "cancel_appt completion step is not enforced strongly enough";
  }
  if (failure.suite === "routing") {
    return "routing tool semantics between transfer_call and route_to_spring_hill are too ambiguous";
  }
  if (failure.suite === "insurance" && text.includes("check_insurance")) {
    return "insurance acceptance flow needs a clearer required-tool contract";
  }
  if (
    text.includes("missing required") ||
    text.includes("argument") ||
    text.includes("wrong parameter")
  ) {
    return "tool argument requirements need stricter validation or examples";
  }
  return undefined;
}

function clusterAuditRecommendations(
  report: AuditReport | undefined,
): RecommendationCluster[] {
  if (!report) return [];
  const clustered = new Map<string, RecommendationCluster>();
  for (const audit of report.audits) {
    const toolRelated = audit.failureModes.find((mode) =>
      [
        "wrong_tool",
        "wrong_tool_order",
        "hallucination",
        "toolCorrectness",
      ].includes(mode),
    );
    if (!toolRelated) continue;
    const issue =
      audit.toolCorrectness.issues[0] ??
      audit.hallucinationSafety.issues[0] ??
      audit.recommendedFixes[0] ??
      toolRelated;
    const key = `audit:${audit.intentBucket}:${issue}`;
    const current = clustered.get(key) ?? {
      key,
      source: "audit" as const,
      suiteOrBucket: audit.intentBucket,
      issue,
      count: 0,
      examples: [],
    };
    current.count += 1;
    if (current.examples.length < 3)
      current.examples.push(`${audit.callId}: ${audit.resolutionReason}`);
    clustered.set(key, current);
  }
  return Array.from(clustered.values()).sort(
    (a, b) => b.count - a.count || a.issue.localeCompare(b.issue),
  );
}

function clusterEvalRecommendations(
  failures: EvalFailure[],
): RecommendationCluster[] {
  const clustered = new Map<string, RecommendationCluster>();
  for (const failure of failures) {
    const issue = inferToolLayerIssue(failure);
    if (!issue) continue;
    const key = `eval:${failure.suite}:${issue}`;
    const current = clustered.get(key) ?? {
      key,
      source: "eval" as const,
      suiteOrBucket: failure.suite,
      issue,
      count: 0,
      examples: [],
    };
    current.count += 1;
    if (current.examples.length < 3)
      current.examples.push(
        `${failure.caseId}: ${failure.judgeReason || "(no judge reason)"}`,
      );
    clustered.set(key, current);
  }
  return Array.from(clustered.values()).sort(
    (a, b) => b.count - a.count || a.issue.localeCompare(b.issue),
  );
}

function recommendationForIssue(issue: string): string {
  const lower = issue.toLowerCase();
  if (lower.includes("confirm_appt")) {
    return "Review the confirm flow contract. Make it explicit in tool definitions/helpers when context is sufficient and when confirm_appt must be called.";
  }
  if (lower.includes("insurance-gate")) {
    return "Add a stricter registration state transition around check_insurance so downstream steps cannot proceed before insurance acceptance is grounded.";
  }
  if (lower.includes("add_patient")) {
    return "Tighten add_patient preconditions in the tool wrapper or planner. Reject submission without required readback-confirmed fields.";
  }
  if (lower.includes("cancel_appt")) {
    return "Make cancellation completion depend on cancel_appt success instead of verbal confirmation alone.";
  }
  if (
    lower.includes("route_to_spring_hill") ||
    lower.includes("routing tool semantics")
  ) {
    return "Clarify routing tool responsibilities in code comments/tool docs and make the routing choice easier to infer from office and patient type.";
  }
  if (lower.includes("insurance acceptance")) {
    return "Document check_insurance as the only grounding path for plan acceptance and add examples for ambiguous plan names.";
  }
  if (lower.includes("argument requirements")) {
    return "Strengthen tool schemas and examples so required args are obvious and invalid calls fail fast.";
  }
  if (lower.includes("hallucination")) {
    return "Move the grounding requirement closer to the tool wrapper or helper so the agent cannot answer without retrieved context.";
  }
  return "Review this cluster as a tool contract problem first, not a prompt rewrite. Prefer a stricter helper, wrapper, schema, or state transition.";
}

function toSection(title: string, clusters: RecommendationCluster[]): string[] {
  if (clusters.length === 0)
    return [`## ${title}`, "", "_No tool-layer clusters found._"];
  const lines = [`## ${title}`, ""];
  for (const cluster of clusters.slice(0, 10)) {
    lines.push(`### ${cluster.suiteOrBucket} × ${cluster.count}`);
    lines.push(`Issue: ${cluster.issue}`);
    lines.push(`Recommendation: ${recommendationForIssue(cluster.issue)}`);
    lines.push("Examples:");
    for (const example of cluster.examples) lines.push(`- ${example}`);
    lines.push("");
  }
  return lines;
}

function main() {
  const auditReport = loadLatestAuditReport();
  const tournamentReport = loadLatestTournamentReport();
  const baselineEvalId = getBaselineEvalId(tournamentReport);
  const evalFailures = baselineEvalId
    ? extractFailures(exportEval(baselineEvalId))
    : [];

  const auditClusters = clusterAuditRecommendations(auditReport);
  const evalClusters = clusterEvalRecommendations(evalFailures);

  const lines = [
    "# Tool-Layer Recommendations",
    "",
    "This report only covers failures that look like tool-contract, tool-semantics, grounding, or state-transition problems.",
    "These are the failures you should not try to solve with a broad prompt rewrite.",
    "",
    ...(baselineEvalId
      ? [`Baseline eval: \`${baselineEvalId}\``, ""]
      : ["_No baseline eval id found from latest tournament._", ""]),
    ...toSection("Audit-derived tool-layer clusters", auditClusters),
    ...toSection("Promptfoo-derived tool-layer clusters", evalClusters),
  ];

  ensureDir(OUTPUT_DIR);
  writeText(OUTPUT_PATH, `${lines.join("\n")}\n`);
  console.log(`Wrote ${OUTPUT_PATH}`);
}

main();
