#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_LIMIT = 25;
const DEFAULT_OUT_DIR = "evals/cases/extracted";

function parseArgs(argv) {
  const args = {
    limit: DEFAULT_LIMIT,
    outDir: DEFAULT_OUT_DIR,
    issue: "",
    includePassed: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--limit") {
      args.limit = Number(argv[++index] ?? DEFAULT_LIMIT);
    } else if (arg === "--out-dir") {
      args.outDir = argv[++index] ?? DEFAULT_OUT_DIR;
    } else if (arg === "--issue") {
      args.issue = argv[++index] ?? "";
    } else if (arg === "--include-passed") {
      args.includePassed = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 500) {
    throw new Error("--limit must be an integer from one to five hundred.");
  }

  return args;
}

function printHelp() {
  console.log(`Usage:
  pnpm extract:transcript-evals [--limit 25] [--issue transfer] [--include-passed]

Reads DATABASE_URL from the environment or .env.local, pulls reviewed calls
from CallEvent/CallReview, redacts obvious PII, and writes JSON cases under
${DEFAULT_OUT_DIR}/. That directory is gitignored.`);
}

function readDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envPath = join(process.cwd(), ".env.local");
  if (!existsSync(envPath)) return "";

  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^DATABASE_URL=(.*)$/);
    if (match) return match[1]?.trim() ?? "";
  }
  return "";
}

function buildPgEnv(databaseUrl) {
  const parsed = new URL(databaseUrl);
  return {
    ...process.env,
    PGHOST: parsed.hostname,
    PGPORT: parsed.port || "5432",
    PGDATABASE: parsed.pathname.replace(/^\//, "") || "postgres",
    PGUSER: decodeURIComponent(parsed.username),
    PGPASSWORD: decodeURIComponent(parsed.password),
    PGSSLMODE: parsed.searchParams.get("sslmode") ?? "require",
  };
}

function sqlLiteral(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

function buildQuery({ limit, issue, includePassed }) {
  const issueFilter = issue
    ? `and (
        r.result->>'topIssue' ilike ${sqlLiteral(`%${issue}%`)}
        or exists (
          select 1
          from jsonb_array_elements(coalesce(r.result->'findings', '[]'::jsonb)) finding
          where finding->>'title' ilike ${sqlLiteral(`%${issue}%`)}
             or finding->>'type' ilike ${sqlLiteral(`%${issue}%`)}
             or finding->>'whyItMatters' ilike ${sqlLiteral(`%${issue}%`)}
        )
      )`
    : "";

  const passFilter = includePassed
    ? ""
    : "and coalesce((r.result->>'passed')::boolean, false) = false";

  return `
with reviewed as (
  select
    e."callId",
    e."startedAt",
    e."durationSec",
    e."totalTurns",
    e."toolCalls",
    e."toolErrors",
    e."officePhone",
    e.data->'turns' as turns,
    r.result->>'outcome' as outcome,
    r.result->>'topIssue' as "topIssue",
    r.result->'labels' as labels,
    r.result->'scores' as scores,
    coalesce(r.result->'findings', '[]'::jsonb) as findings,
    coalesce(r.result->'nearMisses', '[]'::jsonb) as "nearMisses",
    coalesce(r.result->'recommendedActions', '[]'::jsonb) as "recommendedActions"
  from public."CallEvent" e
  join public."CallReview" r
    on r."callEventId" = e.id
  where r.status = 'completed'
    and jsonb_typeof(e.data->'turns') = 'array'
    ${passFilter}
    ${issueFilter}
  order by e."createdAt" desc
  limit ${limit}
)
select coalesce(jsonb_agg(to_jsonb(reviewed)), '[]'::jsonb)::text
from reviewed;`;
}

function runPsql(databaseUrl, query) {
  const result = spawnSync("psql", ["-X", "-q", "-t", "-A", "-c", query], {
    env: buildPgEnv(databaseUrl),
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });

  if (result.status !== 0) {
    throw new Error(
      `psql failed: ${(result.stderr || result.stdout).trim() || "unknown error"}`,
    );
  }

  return JSON.parse(result.stdout.trim() || "[]");
}

function redactText(value) {
  if (typeof value !== "string") return value;
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/\+?1?[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, "[phone]")
    .replace(/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g, "[date]")
    .replace(
      /\b\d{3,6}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,4}\s+(?:street|st|avenue|ave|road|rd|drive|dr|lane|ln|court|ct|boulevard|blvd)\b/gi,
      "[address]",
    )
    .replace(/\b[A-Z]{1,4}[- ]?\d{4,}\b/g, "[member-id]");
}

function redactJson(value) {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redactJson);
  if (!value || typeof value !== "object") return value;

  const redacted = {};
  for (const [key, child] of Object.entries(value)) {
    if (
      [
        "callerPhone",
        "officePhone",
        "audioBase64",
        "audioData",
        "patientId",
        "memberId",
        "subscriberNum",
      ].includes(key)
    ) {
      redacted[key] = "[redacted]";
    } else {
      redacted[key] = redactJson(child);
    }
  }
  return redacted;
}

function toEvalCase(row) {
  const turns = Array.isArray(row.turns)
    ? row.turns.map((turn) => ({
        turn: turn.turn,
        callerText: redactText(turn.callerText ?? ""),
        agentText: redactText(turn.agentText ?? ""),
        toolCalls: Array.isArray(turn.toolCalls)
          ? turn.toolCalls.map((toolCall) => ({
              name: toolCall.name,
              isError: Boolean(toolCall.isError),
            }))
          : [],
      }))
    : [];

  return {
    id: row.callId,
    source: "call-database",
    metadata: {
      startedAt: row.startedAt,
      durationSec: row.durationSec,
      totalTurns: row.totalTurns,
      toolCalls: row.toolCalls,
      toolErrors: row.toolErrors,
      officePhone: "[redacted]",
    },
    review: {
      outcome: row.outcome,
      topIssue: row.topIssue,
      labels: redactJson(row.labels),
      scores: redactJson(row.scores),
      findings: redactJson(row.findings),
      nearMisses: redactJson(row.nearMisses),
      recommendedActions: redactJson(row.recommendedActions),
    },
    turns,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const databaseUrl = readDatabaseUrl();
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is not set. Add it to your environment or .env.local.",
    );
  }

  const rows = runPsql(databaseUrl, buildQuery(args));
  const cases = rows.map(toEvalCase);
  mkdirSync(args.outDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const issueSlug = args.issue
    ? `-${args.issue.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`
    : "";
  const outPath = join(
    args.outDir,
    `transcript-evals${issueSlug}-${timestamp}.json`,
  );

  writeFileSync(
    outPath,
    `${JSON.stringify({ generatedAt: new Date().toISOString(), cases }, null, 2)}\n`,
  );

  console.log(
    `Wrote ${cases.length} redacted transcript eval cases to ${outPath}`,
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
