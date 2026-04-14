import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const GOLDEN_CASES_DIR = join(import.meta.dirname, "..", "..", "evals", "cases", "golden");
const TESTS_MODULE_PATH = join(import.meta.dirname, "..", "..", "evals", "promptfoo", "tests.mjs");
const ASSERTION_MODULE_FILE_URL = `file://${join(
  import.meta.dirname,
  "..",
  "..",
  "evals",
  "promptfoo",
  "assertions",
  "decision-point.mjs",
)}`;

describe("promptfoo eval wiring", () => {
  it("creates one Promptfoo test per golden case", async () => {
    const goldenCaseFiles = readdirSync(GOLDEN_CASES_DIR)
      .filter((file) => file.endsWith(".json"))
      .sort();

    const testsModule = (await import(TESTS_MODULE_PATH)) as {
      loadPromptfooTests: () => Array<{
        description: string;
        vars: { caseId: string; casePath: string };
        metadata: { suite: string; tags: string[]; caseFile: string };
        assert: Array<{ type: string; value: string }>;
      }>;
    };

    const promptfooTests = testsModule.loadPromptfooTests();

    expect(promptfooTests).toHaveLength(goldenCaseFiles.length);

    for (const testCase of promptfooTests) {
      expect(testCase.description).toBeTruthy();
      expect(testCase.vars.caseId).toBeTruthy();
      expect(testCase.vars.casePath).toMatch(/^evals\/cases\/golden\/.+\.json$/);
      expect(testCase.metadata.suite).toBeTruthy();
      expect(testCase.metadata.tags.length).toBeGreaterThan(0);

      expect(testCase.assert[0]).toEqual({
        type: "javascript",
        value: ASSERTION_MODULE_FILE_URL,
      });

      const rubricAssertion = testCase.assert.find((entry) => entry.type === "llm-rubric");
      if (rubricAssertion) {
        expect(rubricAssertion.value).toContain("finalText");
        expect(rubricAssertion.value).toContain("toolCalls");
      }
    }
  });

  it("uses strict assertions only for opt-in candidate cases", async () => {
    const testsModule = (await import(TESTS_MODULE_PATH)) as {
      loadPromptfooTests: () => Array<{
        description: string;
        vars: { caseId: string; casePath: string };
        metadata: { source: string; suite: string; tags: string[]; caseFile: string };
        assert: Array<{ type: string; value: string }>;
      }>;
    };

    process.env.EVAL_INCLUDE_CANDIDATES = "1";
    const promptfooTests = testsModule.loadPromptfooTests();
    delete process.env.EVAL_INCLUDE_CANDIDATES;

    const strictCandidate = promptfooTests.find(
      (testCase) => testCase.metadata.source === "candidates"
        && testCase.vars.casePath.endsWith("SCL_XWWGTzkhEAWF-transfer-turn-3.json"),
    );
    const runbookOnlyCandidate = promptfooTests.find(
      (testCase) => testCase.metadata.source === "candidates"
        && testCase.vars.casePath.endsWith("SCL_nu6wr8TtYVoJ-confirm-turn-3.json"),
    );

    expect(strictCandidate).toBeTruthy();
    expect(runbookOnlyCandidate).toBeTruthy();

    expect(strictCandidate!.assert[0]).toEqual({
      type: "javascript",
      value: ASSERTION_MODULE_FILE_URL,
    });
    expect(strictCandidate!.assert.some((entry) => entry.type === "llm-rubric")).toBe(true);

    expect(runbookOnlyCandidate!.assert).toEqual([
      expect.objectContaining({
        type: "llm-rubric",
      }),
    ]);
  });
});
