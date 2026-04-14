/**
 * Runs the eval suite against the baseline workspace plus every workspace-vN/
 * variant directory, capturing per-suite pass rates into a single JSON report.
 *
 * Usage:
 *   npx tsx evals/scripts/tournament.ts [--include-candidates]
 *
 * Inputs:
 *   - workspace          (baseline directory)
 *   - workspace-v* dirs  (variants written by propose-variants.ts)
 *
 * Output:
 *   - evals/output/tournament-(timestamp).json
 */

import "dotenv/config";
import { execSync } from "node:child_process";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const OUTPUT_DIR = resolve(REPO_ROOT, "evals", "output");

interface SuiteScore {
  pass: number;
  total: number;
}

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

function parseArgs(argv: string[]) {
  return {
    includeCandidates: argv.includes("--include-candidates"),
  };
}

function listVariantWorkspaces(): string[] {
  return readdirSync(REPO_ROOT)
    .filter(
      (entry) =>
        entry.startsWith("workspace-v") ||
        entry.startsWith("workspace-candidate"),
    )
    .filter((entry) => statSync(join(REPO_ROOT, entry)).isDirectory())
    .sort();
}

function runEvalForWorkspace(
  workspace: string,
  includeCandidates: boolean,
): string {
  const description = `tournament:${workspace}`;
  // Always pass the literal workspace name (not empty string) so prompt.ts
  // and the rubric mapping read from the right directory. Empty string
  // would resolve to the repo root and silently fail.
  // NODE_OPTIONS=--import tsx lets the in-process provider import TypeScript
  // directly (saves ~2s subprocess boot per case).
  const existingNodeOptions = process.env.NODE_OPTIONS ?? "";
  const env = {
    ...process.env,
    PROMPT_WORKSPACE: workspace,
    EVAL_INCLUDE_CANDIDATES: includeCandidates ? "1" : "",
    NODE_OPTIONS: existingNodeOptions.includes("--import tsx")
      ? existingNodeOptions
      : `${existingNodeOptions} --import tsx`.trim(),
  } as NodeJS.ProcessEnv;
  console.log(`Running eval for ${workspace}...`);
  try {
    execSync(
      `npx promptfoo eval -c evals/promptfoo/promptfooconfig.mjs --no-progress-bar --description "${description}"`,
      { cwd: REPO_ROOT, env, stdio: "inherit", maxBuffer: 64 * 1024 * 1024 },
    );
  } catch (error: unknown) {
    // promptfoo exits with code 100 when any test fails — we still want the eval id
    const status = (error as { status?: number }).status;
    if (status !== 100) throw error;
  }
  // Pull the latest eval id back out by listing
  const stdout = execSync("npx promptfoo list evals 2>/dev/null", {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    maxBuffer: 8 * 1024 * 1024,
  });
  const matches = stdout.match(/eval-[A-Za-z0-9]+-\d{4}-\d{2}-\d{2}T[\d:.]+/g);
  if (!matches || matches.length === 0)
    throw new Error("No eval id found after run");
  return matches[matches.length - 1];
}

function scoreEval(evalId: string, workspace: string): VariantScore {
  const tmpFile = `/tmp/tournament-${workspace.replace(/\//g, "-")}.json`;
  execSync(`npx promptfoo export eval ${evalId} -o ${tmpFile}`, {
    cwd: REPO_ROOT,
  });
  const data = JSON.parse(readFileSync(tmpFile, "utf-8"));
  const score: VariantScore = {
    workspace,
    evalId,
    totalPass: 0,
    totalCount: 0,
    goldenPass: 0,
    goldenTotal: 0,
    candidatePass: 0,
    candidateTotal: 0,
    perSuite: {},
  };
  for (const result of data.results?.results ?? []) {
    const casePath = result.testCase?.vars?.casePath ?? "";
    const source: "golden" | "candidates" = casePath.startsWith(
      "evals/cases/golden/",
    )
      ? "golden"
      : "candidates";
    const suite = result.testCase?.metadata?.suite ?? "?";
    const passed = result.success === true ? 1 : 0;
    score.totalCount += 1;
    score.totalPass += passed;
    if (source === "golden") {
      score.goldenTotal += 1;
      score.goldenPass += passed;
    } else {
      score.candidateTotal += 1;
      score.candidatePass += passed;
    }
    if (!score.perSuite[suite]) {
      score.perSuite[suite] = {
        golden: { pass: 0, total: 0 },
        candidates: { pass: 0, total: 0 },
      };
    }
    score.perSuite[suite][source].pass += passed;
    score.perSuite[suite][source].total += 1;
  }
  return score;
}

function pct(part: number, total: number): number {
  return total === 0 ? 0 : Math.round((part / total) * 1000) / 10;
}

function summarize(score: VariantScore): string {
  return `${score.workspace.padEnd(20)} golden=${score.goldenPass}/${score.goldenTotal} (${pct(score.goldenPass, score.goldenTotal)}%) | candidates=${score.candidatePass}/${score.candidateTotal} (${pct(score.candidatePass, score.candidateTotal)}%) | total=${score.totalPass}/${score.totalCount} (${pct(score.totalPass, score.totalCount)}%)`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const variantWorkspaces = listVariantWorkspaces();
  const workspaces = ["workspace", ...variantWorkspaces];

  if (variantWorkspaces.length === 0) {
    console.log(
      "No workspace-v*/ directories found. Run propose-variants first.",
    );
  }

  console.log(
    `Tournament: ${workspaces.length} workspaces, includeCandidates=${args.includeCandidates}`,
  );

  const scores: VariantScore[] = [];
  for (const workspace of workspaces) {
    const evalId = runEvalForWorkspace(workspace, args.includeCandidates);
    const score = scoreEval(evalId, workspace);
    scores.push(score);
    console.log(summarize(score));
  }

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const reportPath = join(
    OUTPUT_DIR,
    `tournament-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  );
  writeFileSync(
    reportPath,
    `${JSON.stringify({ scores }, null, 2)}\n`,
    "utf-8",
  );
  console.log(`\nReport: ${reportPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
