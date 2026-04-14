/**
 * Generates a quick-scan markdown summary of golden and candidate case coverage.
 *
 * Output:
 *   evals/output/case-coverage.md
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OUTPUT_DIR, REPO_ROOT, ensureDir, writeText } from "../lib/io.js";

type CaseSource = "golden" | "candidates";

interface DecisionPointCase {
  id: string;
  suite: string;
  source?: string;
  tags?: string[];
  expectations?: {
    policyFlags?: string[];
    styleFlags?: string[];
  };
}

interface CoverageStats {
  total: number;
  bySuite: Record<string, number>;
  bySource: Record<string, number>;
  byTag: Record<string, number>;
  byPolicyFlag: Record<string, number>;
  byStyleFlag: Record<string, number>;
  byCallId: Record<string, number>;
}

const CASE_DIRS: Record<CaseSource, string> = {
  golden: join(REPO_ROOT, "evals", "cases", "golden"),
  candidates: join(REPO_ROOT, "evals", "cases", "candidates"),
};

const OUTPUT_PATH = join(OUTPUT_DIR, "case-coverage.md");

function readCases(source: CaseSource): DecisionPointCase[] {
  return readdirSync(CASE_DIRS[source])
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => JSON.parse(readFileSync(join(CASE_DIRS[source], file), "utf-8")) as DecisionPointCase);
}

function increment(map: Record<string, number>, key: string | undefined) {
  if (!key) return;
  map[key] = (map[key] ?? 0) + 1;
}

function topEntries(map: Record<string, number>, limit: number): Array<[string, number]> {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit);
}

function inferCandidateCallId(id: string): string {
  const match = id.match(/^(SCL_[^-]+)/);
  return match?.[1] ?? id;
}

function buildStats(cases: DecisionPointCase[], source: CaseSource): CoverageStats {
  const stats: CoverageStats = {
    total: cases.length,
    bySuite: {},
    bySource: {},
    byTag: {},
    byPolicyFlag: {},
    byStyleFlag: {},
    byCallId: {},
  };

  for (const testCase of cases) {
    increment(stats.bySuite, testCase.suite);
    increment(stats.bySource, testCase.source ?? "unknown");
    for (const tag of testCase.tags ?? []) increment(stats.byTag, tag);
    for (const flag of testCase.expectations?.policyFlags ?? []) increment(stats.byPolicyFlag, flag);
    for (const flag of testCase.expectations?.styleFlags ?? []) increment(stats.byStyleFlag, flag);
    if (source === "candidates") increment(stats.byCallId, inferCandidateCallId(testCase.id));
  }

  return stats;
}

function fmtTable(rows: string[][]): string {
  if (rows.length === 0) return "_none_";
  const [header, ...body] = rows;
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...body.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function main() {
  const goldenCases = readCases("golden");
  const candidateCases = readCases("candidates");
  const golden = buildStats(goldenCases, "golden");
  const candidates = buildStats(candidateCases, "candidates");

  const allSuites = Array.from(new Set([
    ...Object.keys(golden.bySuite),
    ...Object.keys(candidates.bySuite),
  ])).sort();

  const goldenOnlySuites = allSuites.filter((suite) => (golden.bySuite[suite] ?? 0) > 0 && (candidates.bySuite[suite] ?? 0) === 0);
  const candidateOnlySuites = allSuites.filter((suite) => (candidates.bySuite[suite] ?? 0) > 0 && (golden.bySuite[suite] ?? 0) === 0);

  const sections = [
    "# Case Coverage",
    "",
    `Golden cases: ${golden.total}`,
    `Candidate cases: ${candidates.total}`,
    "",
    "## Coverage by suite",
    "",
    fmtTable([
      ["Suite", "Golden", "Candidates"],
      ...allSuites.map((suite) => [
        suite,
        String(golden.bySuite[suite] ?? 0),
        String(candidates.bySuite[suite] ?? 0),
      ]),
    ]),
    "",
    "## Golden composition",
    "",
    fmtTable([
      ["Source", "Count"],
      ...topEntries(golden.bySource, 20).map(([key, value]) => [key, String(value)]),
    ]),
    "",
    "Top policy flags:",
    "",
    fmtTable([
      ["Policy flag", "Count"],
      ...topEntries(golden.byPolicyFlag, 20).map(([key, value]) => [key, String(value)]),
    ]),
    "",
    "Top style flags:",
    "",
    fmtTable([
      ["Style flag", "Count"],
      ...topEntries(golden.byStyleFlag, 20).map(([key, value]) => [key, String(value)]),
    ]),
    "",
    "## Candidate composition",
    "",
    fmtTable([
      ["Tag", "Count"],
      ...topEntries(candidates.byTag, 20).map(([key, value]) => [key, String(value)]),
    ]),
    "",
    "Most repeated candidate callIds:",
    "",
    fmtTable([
      ["Call ID", "Candidate cases"],
      ...topEntries(candidates.byCallId, 15).map(([key, value]) => [key, String(value)]),
    ]),
    "",
    "## Coverage gaps",
    "",
    `Golden-only suites: ${goldenOnlySuites.length > 0 ? goldenOnlySuites.join(", ") : "(none)"}`,
    "",
    `Candidate-only suites: ${candidateOnlySuites.length > 0 ? candidateOnlySuites.join(", ") : "(none)"}`,
  ];

  ensureDir(OUTPUT_DIR);
  writeText(OUTPUT_PATH, `${sections.join("\n")}\n`);
  console.log(`Wrote ${OUTPUT_PATH}`);
}

main();
