import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { extractDecisionPointCases } from "../lib/extract-decision-points.js";
import { normalizeCallEvents } from "../lib/normalize-call-events.js";
import type { NormalizedCallEvent } from "../lib/types.js";

function readInput(path: string): NormalizedCallEvent[] {
  const content = JSON.parse(readFileSync(path, "utf-8")) as unknown;
  return normalizeCallEvents(content);
}

function main() {
  const input = process.argv[2];
  const outputDir = process.argv[3] ?? "evals/cases/extracted";

  if (!input) {
    console.error("Usage: tsx evals/scripts/extract-cases.ts <input.json> [output-dir]");
    process.exit(1);
  }

  const inputPath = resolve(process.cwd(), input);
  const outPath = resolve(process.cwd(), outputDir);
  const records = readInput(inputPath);
  const extractedCases = records.flatMap(extractDecisionPointCases);

  mkdirSync(outPath, { recursive: true });

  for (const testCase of extractedCases) {
    const filePath = join(outPath, `${testCase.id}.json`);
    writeFileSync(filePath, `${JSON.stringify(testCase, null, 2)}\n`, "utf-8");
  }

  console.log(
    `Extracted ${extractedCases.length} decision-point case(s) from ${basename(inputPath)} into ${outPath}`,
  );
}

main();
