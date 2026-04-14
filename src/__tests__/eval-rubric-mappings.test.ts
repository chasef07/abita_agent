import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const GOLDEN_CASES_DIR = join(import.meta.dirname, "..", "..", "evals", "cases", "golden");
const RUBRIC_MODULE_PATH = join(import.meta.dirname, "..", "..", "evals", "promptfoo", "rubric-mappings.mjs");

interface GoldenCase {
  id: string;
  expectations: {
    policyFlags?: string[];
    styleFlags?: string[];
  };
}

function loadGoldenCases(): GoldenCase[] {
  return readdirSync(GOLDEN_CASES_DIR)
    .filter((file) => file.endsWith(".json"))
    .map((file) => JSON.parse(readFileSync(join(GOLDEN_CASES_DIR, file), "utf-8")) as GoldenCase);
}

describe("rubric mappings", () => {
  it("maps every flag used by every golden case", async () => {
    const { listMappedFlags } = (await import(RUBRIC_MODULE_PATH)) as {
      listMappedFlags: () => { policy: string[]; style: string[] };
    };

    const mapped = listMappedFlags();
    const mappedPolicy = new Set(mapped.policy);
    const mappedStyle = new Set(mapped.style);

    const missing: string[] = [];
    for (const testCase of loadGoldenCases()) {
      for (const flag of testCase.expectations.policyFlags ?? []) {
        if (!mappedPolicy.has(flag)) missing.push(`policy:${flag} (${testCase.id})`);
      }
      for (const flag of testCase.expectations.styleFlags ?? []) {
        if (!mappedStyle.has(flag)) missing.push(`style:${flag} (${testCase.id})`);
      }
    }

    expect(missing).toEqual([]);
  });

  it("builds a non-empty rubric for cases with policy or style flags", async () => {
    const { buildRubricForCase } = (await import(RUBRIC_MODULE_PATH)) as {
      buildRubricForCase: (testCase: GoldenCase) => string | null;
    };

    const sample: GoldenCase = {
      id: "sample",
      expectations: {
        policyFlags: ["never_give_medical_advice"],
        styleFlags: ["concise"],
      },
    };

    const rubric = buildRubricForCase(sample);
    expect(rubric).not.toBeNull();
    expect(rubric).toContain("medical advice");
    expect(rubric).toContain("concise");
    expect(rubric).toContain("finalText");
  });

  it("returns null for cases with no flags", async () => {
    const { buildRubricForCase } = (await import(RUBRIC_MODULE_PATH)) as {
      buildRubricForCase: (testCase: GoldenCase) => string | null;
    };

    const empty: GoldenCase = { id: "empty", expectations: {} };
    expect(buildRubricForCase(empty)).toBeNull();
  });
});
