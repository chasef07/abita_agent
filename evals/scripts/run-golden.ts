import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { runDecisionPointCase } from "../lib/run-decision-point-case.js";

type PromptfooTestCase = {
  description: string;
  vars: {
    caseId: string;
    casePath: string;
  };
  metadata: {
    suite: string;
    tags: string[];
    caseFile: string;
  };
};

type AssertionResult = {
  pass: boolean;
  score: number;
  reason: string;
  componentResults?: Array<{
    pass: boolean;
    score: number;
    reason: string;
  }>;
};

async function main() {
  const outputPath = process.argv[2] ?? "evals/output/golden-latest.json";
  const model = process.argv[3];

  const [{ loadPromptfooTests }, { default: decisionPointAssertion }] = await Promise.all([
    import("../promptfoo/tests.mjs"),
    import("../promptfoo/assertions/decision-point.mjs"),
  ]);

  const tests = loadPromptfooTests() as PromptfooTestCase[];
  const results = [];

  for (const testCase of tests) {
    const output = await runDecisionPointCase(testCase.vars.casePath, model);
    const assertion = decisionPointAssertion(output, { vars: testCase.vars }) as AssertionResult;
    results.push({
      id: testCase.vars.caseId,
      casePath: testCase.vars.casePath,
      description: testCase.description,
      suite: testCase.metadata.suite,
      tags: testCase.metadata.tags,
      pass: assertion.pass,
      score: assertion.score,
      reason: assertion.reason,
      componentResults: assertion.componentResults ?? [],
      output,
    });
  }

  const passed = results.filter((result) => result.pass).length;
  const summary = {
    total: results.length,
    passed,
    failed: results.length - passed,
    passRate: results.length === 0 ? 0 : passed / results.length,
  };

  const absoluteOutputPath = resolve(process.cwd(), outputPath);
  mkdirSync(dirname(absoluteOutputPath), { recursive: true });
  writeFileSync(
    absoluteOutputPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        model: model ?? null,
        summary,
        results,
      },
      null,
      2,
    ),
  );

  console.log(`Golden evals: ${summary.passed}/${summary.total} passed`);
  console.log(`Wrote report to ${absoluteOutputPath}`);

  if (summary.failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
