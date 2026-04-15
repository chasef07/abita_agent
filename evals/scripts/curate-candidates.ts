import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { curateDecisionPointCases } from "../lib/candidate-curation.js";
import type { DecisionPointCase } from "../lib/types.js";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const CANDIDATES_DIR = resolve(REPO_ROOT, "evals", "cases", "candidates");

function loadCandidates(): DecisionPointCase[] {
  return readdirSync(CANDIDATES_DIR)
    .filter((entry) => entry.endsWith(".json"))
    .map(
      (entry) =>
        JSON.parse(
          readFileSync(join(CANDIDATES_DIR, entry), "utf-8"),
        ) as DecisionPointCase,
    );
}

function main() {
  const candidates = loadCandidates();
  const { curated, removed } = curateDecisionPointCases(candidates);

  for (const testCase of removed) {
    rmSync(join(CANDIDATES_DIR, `${testCase.id}.json`));
  }

  console.log(
    `Curated candidates: kept ${curated.length}, removed ${removed.length} low-signal duplicate(s).`,
  );
  if (removed.length > 0) {
    for (const testCase of removed.slice(0, 25)) {
      console.log(`- removed ${testCase.id}`);
    }
    if (removed.length > 25) {
      console.log(`...and ${removed.length - 25} more`);
    }
  }
}

main();
