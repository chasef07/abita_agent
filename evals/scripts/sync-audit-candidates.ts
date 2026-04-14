/**
 * Promotes repeated production audit failures into promptfoo candidate cases.
 *
 * Inputs:
 *   - latest audits-YYYY-MM-DD.json
 *   - CallEvent rows from DATABASE_URL for selected callIds
 *
 * Output:
 *   - new files in evals/cases/candidates/
 *   - evals/output/audit-candidates-*.json summary
 */

import "dotenv/config";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { findLatestOutput, OUTPUT_DIR, readJSON, timestampSlug } from "../lib/io.js";
import { normalizeCallEvents } from "../lib/normalize-call-events.js";
import { extractDecisionPointCases } from "../lib/extract-decision-points.js";
import type { AuditFailureMode, CallAuditReport, DecisionPointCase, NormalizedCallEvent } from "../lib/types.js";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const CANDIDATES_DIR = resolve(REPO_ROOT, "evals", "cases", "candidates");
const GOLDEN_DIR = resolve(REPO_ROOT, "evals", "cases", "golden");

interface Args {
  perCluster: number;
  maxClusters: number;
}

interface AuditSummary {
  callId: string;
  intentBucket: string;
  overallStatus: "great" | "needs_work" | "failed";
  resolved: boolean;
  resolutionReason: string;
  failureModes: string[];
  pathEfficiency: { score: number };
}

interface ClusteredAudit {
  key: string;
  count: number;
  intentBucket: string;
  failureMode: string;
  calls: AuditSummary[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = { perCluster: 2, maxClusters: 10 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--per-cluster" && argv[i + 1]) args.perCluster = Number.parseInt(argv[i + 1], 10);
    if (argv[i] === "--max-clusters" && argv[i + 1]) args.maxClusters = Number.parseInt(argv[i + 1], 10);
  }
  return args;
}

function loadKnownCaseIds(): Set<string> {
  const ids = new Set<string>();
  for (const dir of [GOLDEN_DIR, CANDIDATES_DIR]) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      if (file.endsWith(".json")) ids.add(file.replace(/\.json$/, ""));
    }
  }
  return ids;
}

function loadLatestAuditReport(): CallAuditReport {
  const path = findLatestOutput("audits-");
  const report = readJSON<CallAuditReport>(path);
  if (!report) throw new Error("No audits report found. Run optimize:audit first.");
  return report;
}

function clusterAudits(audits: AuditSummary[], args: Args): ClusteredAudit[] {
  const clustered = new Map<string, ClusteredAudit>();
  for (const audit of audits) {
    const primaryFailure = audit.failureModes[0] ?? (audit.resolved ? "quality_gap" : "unresolved_need");
    const key = `${audit.intentBucket}:${primaryFailure}`;
    const current = clustered.get(key) ?? {
      key,
      count: 0,
      intentBucket: audit.intentBucket,
      failureMode: primaryFailure,
      calls: [],
    };
    current.count += 1;
    current.calls.push(audit);
    clustered.set(key, current);
  }

  return Array.from(clustered.values())
    .map((cluster) => ({
      ...cluster,
      calls: cluster.calls
        .sort((a, b) =>
          (a.overallStatus === "failed" ? 0 : 1) - (b.overallStatus === "failed" ? 0 : 1)
          || a.pathEfficiency.score - b.pathEfficiency.score,
        )
        .slice(0, args.perCluster),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, args.maxClusters);
}

function fetchCallsByIds(callIds: string[]): NormalizedCallEvent[] {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  if (callIds.length === 0) return [];
  const idsSql = callIds
    .map((callId) => `'${callId.replace(/'/g, "''")}'`)
    .join(", ");
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
      WHERE "callId" IN (${idsSql})
    ) ce
  `.replace(/\s+/g, " ").trim();
  const stdout = execSync(
    `psql "${process.env.DATABASE_URL}" -t -A -c ${JSON.stringify(sql)}`,
    { encoding: "utf-8", timeout: 60_000, maxBuffer: 256 * 1024 * 1024 },
  ).trim();
  if (!stdout) return [];
  return normalizeCallEvents(JSON.parse(stdout) as unknown[]);
}

function suitePriority(intentBucket: string, failureMode: string, suite: string): number {
  const base: Record<string, Record<string, number>> = {
    new_patient: { registration: 4, scheduling: 3, verification: 2 },
    faq: { "quick-question": 4, transfer: 2 },
    immediate_transfer: { transfer: 4, routing: 3 },
    confirm: { confirm: 4, verification: 2 },
    cancel_rebook: { cancel: 4, scheduling: 3, confirm: 2 },
    existing_patient_booking: { scheduling: 4, verification: 3, confirm: 2 },
  };
  let score = base[intentBucket]?.[suite] ?? 0;
  if (failureMode === "wrong_tool_order" && suite === "scheduling") score += 2;
  if (failureMode === "bad_tool_args" && ["registration", "cancel", "confirm"].includes(suite)) score += 2;
  if (failureMode === "unnecessary_transfer" && suite === "transfer") score += 3;
  if (failureMode === "slow_path" && ["scheduling", "registration", "verification"].includes(suite)) score += 1;
  return score;
}

function chooseBestCase(cases: DecisionPointCase[], intentBucket: string, failureMode: string): DecisionPointCase | undefined {
  return [...cases]
    .sort((a, b) => suitePriority(intentBucket, failureMode, b.suite) - suitePriority(intentBucket, failureMode, a.suite))
    .at(0);
}

function hasDirectExpectations(testCase: DecisionPointCase): boolean {
  const expectations = testCase.expectations;
  return (
    (expectations.mustCallTools?.length ?? 0) > 0
    || (expectations.mustNotCallTools?.length ?? 0) > 0
    || (expectations.mustSay?.length ?? 0) > 0
    || (expectations.mustNotSay?.length ?? 0) > 0
    || (expectations.policyFlags?.length ?? 0) > 0
  );
}

function shouldUseStrictAssertions(testCase: DecisionPointCase, failureMode: AuditFailureMode): boolean {
  if (!hasDirectExpectations(testCase)) return false;

  switch (failureMode) {
    case "wrong_tool":
    case "policy_violation":
    case "missed_transfer":
    case "unnecessary_transfer":
      return ["transfer", "routing", "confirm", "cancel", "verification", "quick-question"].includes(testCase.suite);
    case "wrong_tool_order":
      return (testCase.expectations.policyFlags ?? []).some((flag) =>
        [
          "ask_reason_before_get_availability",
          "book_new_before_cancel_old",
          "read_back_appointment_before_booking",
          "check_insurance_gate_before_collecting_other_fields",
          "follow_registration_field_order",
        ].includes(flag),
      );
    case "hallucination":
    case "knowledge_gap":
      return (testCase.expectations.policyFlags ?? []).some((flag) =>
        [
          "ground_practice_facts_in_lookup_knowledge",
          "check_insurance_for_acceptance_questions",
          "never_give_medical_advice",
          "add_patient_uses_caller_provided_values_exactly",
        ].includes(flag),
      );
    case "bad_tool_args":
      return (testCase.expectations.policyFlags ?? []).some((flag) =>
        [
          "collect_insurance_card_fields_before_update_insurance",
          "add_patient_uses_caller_provided_values_exactly",
          "cancel_only_the_appointment_caller_specified",
        ].includes(flag),
      );
    case "slow_path":
    case "repeat_question":
    case "caller_abandoned":
    case "unresolved_need":
      return false;
  }
}

function writeCandidate(testCase: DecisionPointCase): void {
  mkdirSync(CANDIDATES_DIR, { recursive: true });
  const filePath = join(CANDIDATES_DIR, `${testCase.id}.json`);
  writeFileSync(filePath, `${JSON.stringify(testCase, null, 2)}\n`, "utf-8");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const auditReport = loadLatestAuditReport();
  const known = loadKnownCaseIds();
  const failingAudits = auditReport.audits.filter((audit) => audit.overallStatus !== "great");
  const clusters = clusterAudits(failingAudits, args);
  const selectedCallIds = Array.from(new Set(clusters.flatMap((cluster) => cluster.calls.map((audit) => audit.callId))));
  const records = fetchCallsByIds(selectedCallIds);
  const recordsByCallId = new Map(records.map((record) => [record.callId, record]));

  let added = 0;
  const summary: Array<{
    cluster: string;
    callId: string;
    caseId?: string;
    status: "added" | "skipped" | "missing_record" | "no_case";
  }> = [];

  for (const cluster of clusters) {
    for (const audit of cluster.calls) {
      const record = recordsByCallId.get(audit.callId);
      if (!record) {
        summary.push({ cluster: cluster.key, callId: audit.callId, status: "missing_record" });
        continue;
      }
      const extracted = extractDecisionPointCases(record);
      const best = chooseBestCase(extracted, cluster.intentBucket, cluster.failureMode);
      if (!best) {
        summary.push({ cluster: cluster.key, callId: audit.callId, status: "no_case" });
        continue;
      }
      const candidate: DecisionPointCase = {
        ...best,
        ...(shouldUseStrictAssertions(best, cluster.failureMode as AuditFailureMode)
          ? { assertionMode: "strict" as const }
          : {}),
        tags: Array.from(new Set([
          ...(best.tags ?? []),
          "audit-driven",
          `bucket:${cluster.intentBucket}`,
          `failure:${cluster.failureMode}`,
        ])),
        context: {
          ...best.context,
          notes: [best.context.notes, `Promoted from audit cluster ${cluster.key}: ${audit.resolutionReason}`]
            .filter(Boolean)
            .join(" "),
        },
      };
      if (known.has(candidate.id)) {
        summary.push({ cluster: cluster.key, callId: audit.callId, caseId: candidate.id, status: "skipped" });
        continue;
      }
      writeCandidate(candidate);
      known.add(candidate.id);
      added += 1;
      summary.push({ cluster: cluster.key, callId: audit.callId, caseId: candidate.id, status: "added" });
    }
  }

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const outPath = join(OUTPUT_DIR, `audit-candidates-${timestampSlug()}.json`);
  writeFileSync(outPath, `${JSON.stringify({ totalAudits: failingAudits.length, clusters, summary, added }, null, 2)}\n`, "utf-8");
  console.log(`Audit candidate sync: ${failingAudits.length} failing audit(s), ${clusters.length} cluster(s), added ${added} candidate case(s).`);
  console.log(`Wrote ${outPath}`);
}

main();
