/**
 * Appends one daily metrics row to evals/output/history.jsonl.
 *
 * Inputs (auto-discovered from evals/output/):
 *   - latest audit result       (audits-YYYY-MM-DD.json)
 *   - latest tournament report  (tournament-*.json)
 *   - latest winner verdict     (winner-*.json)
 *   - workspace/RUNBOOK.md      (for prompt size)
 *
 * History row shape:
 *   { date, golden: {pass, total}, candidate: {pass, total},
 *     audit: {resolved, toolCorrect, hallucinationSafe, total, byBucket},
 *     prompt: {runbookChars, runbookLines},
 *     winner: {promoted: bool, hypothesis?: string} }
 */

import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  OUTPUT_DIR,
  WORKSPACE_DIR,
  ensureDir,
  findLatestOutput,
  findTodayOutput,
  readJSON,
  todayISO,
} from "../lib/io.js";

const HISTORY_PATH = join(OUTPUT_DIR, "history.jsonl");
const RUNBOOK_PATH = join(WORKSPACE_DIR, "RUNBOOK.md");

interface SuiteScore { pass: number; total: number; }
interface VariantScore {
  workspace: string;
  goldenPass: number;
  goldenTotal: number;
  candidatePass: number;
  candidateTotal: number;
  perSuite: Record<string, { golden: SuiteScore; candidates: SuiteScore }>;
}

interface AuditBucketSummary {
  total: number;
  resolved: number;
  toolCorrect: number;
  hallucinationSafe: number;
  avgTurns: number;
}

interface AuditReport {
  totalCalls: number;
  overall: {
    resolved: number;
    toolCorrect: number;
    hallucinationSafe: number;
  };
  byBucket: Record<string, AuditBucketSummary>;
}

function main() {
  const date = todayISO();
  const auditReport = readJSON<AuditReport>(findTodayOutput("audits-"));
  const tournament = readJSON<{ scores: VariantScore[] }>(findLatestOutput("tournament-"));
  const winner = readJSON<{ status: string; winner?: string; candidates?: Array<{ workspace: string; reason: string }> }>(
    findLatestOutput("winner-"),
  );

  const baseline = tournament?.scores?.find?.((entry: VariantScore) => entry.workspace === "workspace");

  const runbook = readFileSync(RUNBOOK_PATH, "utf-8");

  const row = {
    date,
    timestamp: new Date().toISOString(),
    golden: baseline
      ? { pass: baseline.goldenPass, total: baseline.goldenTotal }
      : undefined,
    candidates: baseline
      ? { pass: baseline.candidatePass, total: baseline.candidateTotal }
      : undefined,
    perSuiteGolden: baseline
      ? Object.fromEntries(
          Object.entries(baseline.perSuite).map(([suite, scores]) => [suite, scores.golden]),
        )
      : undefined,
    audit: auditReport
      ? {
          total: auditReport.totalCalls,
          resolved: auditReport.overall.resolved,
          toolCorrect: auditReport.overall.toolCorrect,
          hallucinationSafe: auditReport.overall.hallucinationSafe,
          byBucket: Object.fromEntries(
            Object.entries(auditReport.byBucket).map(([bucket, summary]) => [
              bucket,
              {
                total: summary.total,
                resolved: summary.resolved,
                avgTurns: summary.avgTurns,
              },
            ]),
          ),
        }
      : undefined,
    prompt: {
      runbookChars: runbook.length,
      runbookLines: runbook.split("\n").length,
    },
    winner: winner
      ? {
          status: winner.status,
          promoted: winner.status === "winner_found",
          hypothesis:
            winner.status === "winner_found"
              ? winner.candidates?.find?.((entry) => entry.workspace === winner.winner)?.reason
              : undefined,
        }
      : undefined,
  };

  ensureDir(OUTPUT_DIR);
  appendFileSync(HISTORY_PATH, `${JSON.stringify(row)}\n`, "utf-8");
  console.log(`Appended row to ${HISTORY_PATH}`);
  console.log(JSON.stringify(row, null, 2));
}

main();
