import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const GOLDEN_CASES_DIR = join(
  import.meta.dirname,
  "..",
  "..",
  "evals",
  "cases",
  "golden",
);

type DecisionPointCase = {
  id: string;
  suite: string;
  tags: string[];
  context: {
    trunkPhone: string;
    phoneLookupStatus: "verified" | "multiple_matches" | "no_match" | "unknown";
    notes?: string;
  };
  conversation: Array<{
    role: "user" | "assistant";
    content: string;
  }>;
  expectations: {
    mustCallTools: string[];
    mustNotCallTools: string[];
    mustSay?: string[];
    mustNotSay?: string[];
    policyFlags?: string[];
    styleFlags?: string[];
  };
};

function loadGoldenCases(): DecisionPointCase[] {
  return readdirSync(GOLDEN_CASES_DIR)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map(
      (file) =>
        JSON.parse(
          readFileSync(join(GOLDEN_CASES_DIR, file), "utf-8"),
        ) as DecisionPointCase,
    );
}

describe("golden eval cases", () => {
  it("include at least one seed case", () => {
    expect(loadGoldenCases().length).toBeGreaterThan(0);
  });

  it("have the required decision-point structure", () => {
    for (const testCase of loadGoldenCases()) {
      expect(testCase.id).toBeTruthy();
      expect(testCase.suite).toBeTruthy();
      expect(testCase.tags.length).toBeGreaterThan(0);
      expect(testCase.context.trunkPhone).toMatch(/^\+\d{11}$/);
      expect(["verified", "multiple_matches", "no_match", "unknown"]).toContain(
        testCase.context.phoneLookupStatus,
      );
      expect(testCase.conversation.length).toBeGreaterThan(0);
      expect(Array.isArray(testCase.expectations.mustCallTools)).toBe(true);
      expect(Array.isArray(testCase.expectations.mustNotCallTools)).toBe(true);
      for (const turn of testCase.conversation) {
        expect(["user", "assistant"]).toContain(turn.role);
        expect(turn.content).toBeTruthy();
      }
    }
  });
});
