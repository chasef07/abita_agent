/**
 * Orchestrates the full self-improvement loop:
 *   1. Sync recent calls into evals/cases/candidates/
 *   2. Audit each recent call into the six business buckets + quality dimensions
 *   3. Promote repeated audit failures into promptfoo candidate cases
 *   4. Run the eval against the current workspace (baseline)
 *   5. Propose N prompt variants using audit + eval context → workspace-vN/
 *   6. Run the eval against each variant (tournament)
 *   7. Select the winner (or "no change") with optional --promote
 *   8. Append a metrics row to evals/output/history.jsonl
 *   9. Render evals/output/audit-report.html
 *  10. Render evals/output/tool-recommendations.md
 *
 * Usage:
 *   npx tsx evals/scripts/optimize-nightly.ts [--variants 3] [--hours 24] [--promote]
 *
 * Environment:
 *   DATABASE_URL       required for sync + audit
 *   OPENAI_API_KEY or ANTHROPIC_API_KEY required for proposer + audit judge + LLM rubric grader
 */

import "dotenv/config";
import { execSync } from "node:child_process";
import { readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");

interface Args {
  variants: number;
  hours: number;
  promote: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { variants: 3, hours: 24, promote: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--variants" && argv[i + 1])
      args.variants = Number.parseInt(argv[i + 1], 10);
    if (argv[i] === "--hours" && argv[i + 1])
      args.hours = Number.parseFloat(argv[i + 1]);
    if (argv[i] === "--promote") args.promote = true;
  }
  return args;
}

function step(label: string, fn: () => void) {
  console.log(`\n========= ${label} =========`);
  const start = Date.now();
  fn();
  console.log(`(${label} took ${Math.round((Date.now() - start) / 1000)}s)`);
}

function runShell(command: string) {
  console.log(`$ ${command}`);
  execSync(command, { cwd: REPO_ROOT, stdio: "inherit", env: process.env });
}

function cleanupOldVariantWorkspaces() {
  for (const entry of readdirSync(REPO_ROOT)) {
    if (
      (entry.startsWith("workspace-v") ||
        entry.startsWith("workspace-candidate")) &&
      statSync(join(REPO_ROOT, entry)).isDirectory()
    ) {
      rmSync(join(REPO_ROOT, entry), { recursive: true });
      console.log(`Removed stale ${entry}`);
    }
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY or ANTHROPIC_API_KEY is required.");
    process.exit(1);
  }

  step("1. Sync recent calls", () => {
    runShell(`npx tsx evals/scripts/sync-real-calls.ts --hours ${args.hours}`);
  });

  step("2. Audit recent calls", () => {
    runShell(`npx tsx evals/scripts/audit-calls.ts --hours ${args.hours}`);
  });

  step("3. Sync audit-driven candidate cases", () => {
    runShell(`npx tsx evals/scripts/sync-audit-candidates.ts`);
  });

  step("4. Baseline eval (golden + candidates)", () => {
    runShell(
      `NODE_OPTIONS='--import tsx' EVAL_INCLUDE_CANDIDATES=1 npx promptfoo eval -c evals/promptfoo/promptfooconfig.mjs --no-progress-bar --description "optimize:baseline"`,
    );
  });

  step("5. Propose variants", () => {
    cleanupOldVariantWorkspaces();
    runShell(
      `npx tsx evals/scripts/propose-variants.ts --variants ${args.variants}`,
    );
  });

  step("6. Tournament", () => {
    runShell(`npx tsx evals/scripts/tournament.ts --include-candidates`);
  });

  step("7. Select winner", () => {
    const promoteFlag = args.promote ? "--promote" : "";
    runShell(`npx tsx evals/scripts/select-winner.ts ${promoteFlag}`.trim());
  });

  step("8. Log metrics", () => {
    runShell(`npx tsx evals/scripts/log-metrics.ts`);
  });

  step("9. Generate audit dashboard", () => {
    runShell(`npx tsx evals/scripts/generate-audit-report.ts`);
  });

  step("10. Generate tool-layer recommendations", () => {
    runShell(`npx tsx evals/scripts/generate-tool-recommendations.ts`);
  });

  console.log(
    `\nDone. Open evals/output/audit-report.html for the quick-scan dashboard.`,
  );
  if (!args.promote) {
    console.log(
      `(Workspace untouched — pass --promote to overwrite RUNBOOK.md when a winner is found.)`,
    );
  }
}

main();
