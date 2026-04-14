import { runDecisionPointCase } from "../lib/run-decision-point-case.js";

async function main() {
  const casePath = process.argv[2];
  const model = process.argv[3];

  if (!casePath) {
    console.error("Usage: tsx evals/promptfoo/run-case.ts <case-path> [model]");
    process.exit(1);
  }

  const result = await runDecisionPointCase(casePath, model);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
