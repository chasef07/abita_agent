import "dotenv/config";
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const DATABASE_URL = process.env.DATABASE_URL;

function usage(): never {
  console.error("Usage: tsx evals/scripts/export-call-events.ts <output.json> [limit]");
  process.exit(1);
}

function query(sql: string): unknown[] {
  if (!DATABASE_URL) {
    console.error("DATABASE_URL not set");
    process.exit(1);
  }

  const oneLine = sql.replace(/\s+/g, " ").trim();
  const result = execSync(
    `psql "${DATABASE_URL}" -t -A -c ${JSON.stringify(oneLine)}`,
    { encoding: "utf-8", timeout: 15_000 },
  ).trim();

  if (!result) return [];
  return JSON.parse(result) as unknown[];
}

function main() {
  const output = process.argv[2];
  const limitArg = process.argv[3];
  const limit = limitArg ? Number.parseInt(limitArg, 10) : 50;

  if (!output) usage();

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
      ORDER BY "startedAt" DESC
      LIMIT ${Number.isFinite(limit) ? limit : 50}
    ) ce
  `;

  const rows = query(sql);
  const outputPath = resolve(process.cwd(), output);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(rows, null, 2)}\n`, "utf-8");
  console.log(`Exported ${rows.length} call event(s) to ${outputPath}`);
}

main();
