import { describe, expect, it } from "vitest";

const ASSERTION_MODULE_PATH = new URL("../../evals/promptfoo/assertions/decision-point.mjs", import.meta.url).href;

describe("decision-point assertion", () => {
  it("passes when required phrases and tool constraints are satisfied", async () => {
    const { default: decisionPointAssertion } = (await import(ASSERTION_MODULE_PATH)) as {
      default: (output: unknown, context: { vars: { casePath: string } }) => {
        pass: boolean;
        score: number;
      };
    };

    const result = decisionPointAssertion(
      {
        finalText: "ok, I see a few patients associated with this number, can I get the patient's first name?",
        toolCalls: [],
      },
      {
        vars: {
          casePath: "evals/cases/golden/multiple-match-first-name-only.json",
        },
      },
    );

    expect(result.pass).toBe(true);
    expect(result.score).toBe(1);
  });

  it("fails when a required tool is missing", async () => {
    const { default: decisionPointAssertion } = (await import(ASSERTION_MODULE_PATH)) as {
      default: (output: unknown, context: { vars: { casePath: string } }) => {
        pass: boolean;
        score: number;
      };
    };

    const result = decisionPointAssertion(
      {
        finalText: "ok, has your son been seen here before at Abita Eye Group?",
        toolCalls: [],
      },
      {
        vars: {
          casePath: "evals/cases/golden/crystal-river-peds-routing.json",
        },
      },
    );

    expect(result.pass).toBe(false);
    expect(result.score).toBeLessThan(1);
  });
});
