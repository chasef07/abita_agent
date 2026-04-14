/**
 * Pulls recent CallEvent rows, extracts decision-point cases, and writes any
 * NEW candidates into evals/cases/candidates/ for human review.
 *
 * Usage:
 *   npx tsx evals/scripts/sync-real-calls.ts [--days 1] [--limit 100]
 *
 * Designed to be run by the sync-real-calls GitHub workflow on a nightly cron
 * with DATABASE_URL provided as a secret. Existing candidate / golden cases
 * are skipped by id so the workflow is idempotent and only adds genuinely new
 * decision points to the dataset.
 */

import "dotenv/config";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { extractDecisionPointCases } from "../lib/extract-decision-points.js";
import { normalizeCallEvents } from "../lib/normalize-call-events.js";
import type { DecisionPointCase } from "../lib/types.js";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const CANDIDATES_DIR = resolve(REPO_ROOT, "evals", "cases", "candidates");
const GOLDEN_DIR = resolve(REPO_ROOT, "evals", "cases", "golden");

interface Args {
  hours: number;
  limit: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { hours: 24, limit: 200 };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i + 1];
    if (argv[i] === "--hours" && value) args.hours = Number.parseFloat(value);
    if (argv[i] === "--days" && value)
      args.hours = Number.parseFloat(value) * 24;
    if (argv[i] === "--limit" && value) args.limit = Number.parseInt(value, 10);
  }
  return args;
}

function loadKnownCaseIds(): Set<string> {
  const ids = new Set<string>();
  for (const dir of [GOLDEN_DIR, CANDIDATES_DIR]) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      ids.add(file.replace(/\.json$/, ""));
    }
  }
  return ids;
}

function fetchRecentCallEvents({ hours, limit }: Args): unknown[] {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required");
  }
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

function writeCandidate(testCase: DecisionPointCase): string {
  mkdirSync(CANDIDATES_DIR, { recursive: true });
  const annotated: DecisionPointCase = {
    ...testCase,
    tags: Array.from(new Set([...(testCase.tags ?? []), "needs-review"])),
  };
  const filePath = join(CANDIDATES_DIR, `${testCase.id}.json`);
  writeFileSync(filePath, `${JSON.stringify(annotated, null, 2)}\n`, "utf-8");
  return filePath;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const known = loadKnownCaseIds();
  const records = normalizeCallEvents(fetchRecentCallEvents(args));
  const candidates = records.flatMap(extractDecisionPointCases);

  let added = 0;
  let skipped = 0;
  for (const testCase of candidates) {
    if (known.has(testCase.id)) {
      skipped += 1;
      continue;
    }
    writeCandidate(testCase);
    known.add(testCase.id);
    added += 1;
  }

  console.log(
    `Sync complete: scanned ${records.length} call(s), produced ${candidates.length} candidate(s), added ${added}, skipped ${skipped} duplicate(s).`,
  );
}

main();
