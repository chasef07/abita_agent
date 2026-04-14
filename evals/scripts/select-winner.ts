/**
 * Reads the latest tournament report and applies gates to pick a winning
 * variant — or "no change" if no variant clears the bar. Optionally promotes
 * the winning variant by overwriting workspace/.
 *
 * Usage:
 *   npx tsx evals/scripts/select-winner.ts [--promote] [--report <path>]
 *
 * Gates (must all hold for a variant to win):
 *   1. Variant golden pass count ≥ baseline golden pass count + 1
 *   2. No suite regresses by more than 5 percentage points on golden
 *   3. Candidate overall pass rate does not regress by more than 2 percentage points
 *   4. Candidate suite pass rate does not regress by more than 10 percentage points
 *      for any suite with at least 3 candidate cases in the baseline
 *
 * Output:
 *   - evals/output/winner-{timestamp}.json (verdict + diff summary)
 *   - if --promote and a winner exists, copies workspace-vN/ → workspace/
 */

import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const OUTPUT_DIR = resolve(REPO_ROOT, "evals", "output");

interface SuiteScore { pass: number; total: number; }
interface VariantScore {
  workspace: string;
  evalId: string;
  totalPass: number;
  totalCount: number;
  goldenPass: number;
  goldenTotal: number;
  candidatePass: number;
  candidateTotal: number;
  perSuite: Record<string, { golden: SuiteScore; candidates: SuiteScore }>;
}

interface Verdict {
  status: "winner_found" | "no_change";
  winner?: string;
  reason: string;
  baseline: VariantScore;
  candidates: Array<{ workspace: string; verdict: "win" | "tie" | "lose"; reason: string; score: VariantScore }>;
}

const REGRESSION_THRESHOLD_PP = 5;
const CANDIDATE_REGRESSION_THRESHOLD_PP = 2;
const CANDIDATE_SUITE_REGRESSION_THRESHOLD_PP = 10;
const MIN_CANDIDATE_SUITE_CASES = 3;

function parseArgs(argv: string[]) {
  let report: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--report" && argv[i + 1]) report = argv[i + 1];
  }
  return { promote: argv.includes("--promote"), report };
}

function findLatestTournamentReport(): string {
  const files = readdirSync(OUTPUT_DIR)
    .filter((entry) => entry.startsWith("tournament-") && entry.endsWith(".json"))
    .sort();
  if (files.length === 0) throw new Error("No tournament report found in evals/output/");
  return join(OUTPUT_DIR, files[files.length - 1]);
}

function pct(part: number, total: number) {
  return total === 0 ? 0 : (part / total) * 100;
}

function evaluateVariant(baseline: VariantScore, variant: VariantScore): { verdict: "win" | "tie" | "lose"; reason: string } {
  if (variant.goldenPass < baseline.goldenPass) {
    return {
      verdict: "lose",
      reason: `golden regressed: ${variant.goldenPass}/${variant.goldenTotal} vs baseline ${baseline.goldenPass}/${baseline.goldenTotal}`,
    };
  }
  for (const [suite, scores] of Object.entries(variant.perSuite)) {
    const baseSuite = baseline.perSuite[suite]?.golden ?? { pass: 0, total: 0 };
    if (baseSuite.total === 0) continue;
    const baselinePct = pct(baseSuite.pass, baseSuite.total);
    const variantPct = pct(scores.golden.pass, scores.golden.total || baseSuite.total);
    if (baselinePct - variantPct > REGRESSION_THRESHOLD_PP) {
      return {
        verdict: "lose",
        reason: `suite "${suite}" regressed by ${(baselinePct - variantPct).toFixed(1)}pp on golden`,
      };
    }
  }
  if (baseline.candidateTotal > 0 && variant.candidateTotal > 0) {
    const baselineCandidatePct = pct(baseline.candidatePass, baseline.candidateTotal);
    const variantCandidatePct = pct(variant.candidatePass, variant.candidateTotal);
    if (baselineCandidatePct - variantCandidatePct > CANDIDATE_REGRESSION_THRESHOLD_PP) {
      return {
        verdict: "lose",
        reason: `candidate overall regressed by ${(baselineCandidatePct - variantCandidatePct).toFixed(1)}pp`,
      };
    }
    for (const [suite, scores] of Object.entries(variant.perSuite)) {
      const baseSuite = baseline.perSuite[suite]?.candidates ?? { pass: 0, total: 0 };
      if (baseSuite.total < MIN_CANDIDATE_SUITE_CASES) continue;
      const baselinePct = pct(baseSuite.pass, baseSuite.total);
      const variantPct = pct(scores.candidates.pass, scores.candidates.total || baseSuite.total);
      if (baselinePct - variantPct > CANDIDATE_SUITE_REGRESSION_THRESHOLD_PP) {
        return {
          verdict: "lose",
          reason: `candidate suite "${suite}" regressed by ${(baselinePct - variantPct).toFixed(1)}pp`,
        };
      }
    }
  }
  if (variant.goldenPass === baseline.goldenPass) {
    return { verdict: "tie", reason: "golden pass count tied with baseline" };
  }
  return {
    verdict: "win",
    reason: `golden ${variant.goldenPass}/${variant.goldenTotal} > baseline ${baseline.goldenPass}/${baseline.goldenTotal}`,
  };
}

function pickWinner(baseline: VariantScore, variants: VariantScore[]) {
  const evaluated = variants.map((variant) => ({
    workspace: variant.workspace,
    score: variant.goldenPass,
    candidatePass: variant.candidatePass,
    full: variant,
    ...evaluateVariant(baseline, variant),
  }));
  const winners = evaluated.filter((entry) => entry.verdict === "win");
  if (winners.length === 0) return { winner: undefined as string | undefined, evaluated };
  // Prefer the variant with the most golden wins; tiebreak on candidate pass count.
  winners.sort((a, b) => b.score - a.score || b.candidatePass - a.candidatePass);
  return { winner: winners[0].workspace, evaluated };
}

function promoteWinner(workspace: string) {
  const sourceDir = resolve(REPO_ROOT, workspace);
  const targetDir = resolve(REPO_ROOT, "workspace");
  if (!existsSync(sourceDir)) throw new Error(`Cannot promote: ${sourceDir} missing`);
  // Promote any file in the variant workspace whose contents differ from the
  // baseline — this matches the proposer's expanded scope (RUNBOOK, VOICE,
  // SOUL, etc.) without hardcoding which files it touched.
  const promoted: string[] = [];
  for (const entry of readdirSync(sourceDir)) {
    const sourcePath = join(sourceDir, entry);
    const targetPath = join(targetDir, entry);
    if (!existsSync(targetPath)) continue;
    const sourceContent = readFileSync(sourcePath, "utf-8");
    const targetContent = readFileSync(targetPath, "utf-8");
    if (sourceContent === targetContent) continue;
    copyFileSync(sourcePath, targetPath);
    promoted.push(entry);
  }
  if (promoted.length === 0) {
    console.log(`Promotion no-op: ${workspace} matches baseline workspace.`);
  } else {
    console.log(`Promoted ${promoted.length} file(s) from ${workspace}/ → workspace/: ${promoted.join(", ")}`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const reportPath = args.report ?? findLatestTournamentReport();
  const report = JSON.parse(readFileSync(reportPath, "utf-8")) as { scores: VariantScore[] };

  const baseline = report.scores.find((entry) => entry.workspace === "workspace");
  if (!baseline) throw new Error("Tournament report missing baseline workspace score");
  const variants = report.scores.filter((entry) => entry.workspace !== "workspace");

  const { winner, evaluated } = pickWinner(baseline, variants);

  console.log(`Baseline: golden ${baseline.goldenPass}/${baseline.goldenTotal}`);
  for (const entry of evaluated) {
    console.log(`  ${entry.workspace}: ${entry.verdict} | ${entry.reason}`);
  }

  const verdict: Verdict = winner
    ? {
        status: "winner_found",
        winner,
        reason: evaluated.find((entry) => entry.workspace === winner)!.reason,
        baseline,
        candidates: evaluated.map((entry) => ({
          workspace: entry.workspace,
          verdict: entry.verdict,
          reason: entry.reason,
          score: entry.full,
        })),
      }
    : {
        status: "no_change",
        reason: "no variant met the win criteria",
        baseline,
        candidates: evaluated.map((entry) => ({
          workspace: entry.workspace,
          verdict: entry.verdict,
          reason: entry.reason,
          score: entry.full,
        })),
      };

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const verdictPath = join(OUTPUT_DIR, `winner-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(verdictPath, `${JSON.stringify(verdict, null, 2)}\n`, "utf-8");
  console.log(`\nVerdict: ${verdict.status}${winner ? ` → ${winner}` : ""}`);
  console.log(`Wrote ${verdictPath}`);

  if (winner && args.promote) promoteWinner(winner);
}

main();
