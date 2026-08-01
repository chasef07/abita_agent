import { resolveOfficeKnowledge } from "../office-knowledge.js";

const ITERATIONS = 500;
const CPU_BUDGET_MS = 250;

resolveOfficeKnowledge("spring-hill", "What are your office hours?");
const startedAt = process.cpuUsage();

for (let index = 0; index < ITERATIONS; index += 1) {
  resolveOfficeKnowledge("spring-hill", "¿Cuál es su horario?");
}

const elapsed = process.cpuUsage(startedAt);
const elapsedMs = (elapsed.user + elapsed.system) / 1_000;

if (elapsedMs >= CPU_BUDGET_MS) {
  throw new Error(
    `Office Knowledge used ${elapsedMs.toFixed(2)} ms of CPU for ${ITERATIONS} cached resolutions; budget is ${CPU_BUDGET_MS} ms.`,
  );
}

console.log(
  `Office Knowledge cached CPU: ${elapsedMs.toFixed(2)} ms / ${CPU_BUDGET_MS} ms (${ITERATIONS} resolutions)`,
);
