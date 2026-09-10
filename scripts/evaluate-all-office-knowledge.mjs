// Real embeddings of fixed non-patient source/evaluation data. No DB mutations.
import { execFileSync } from "node:child_process";
import { selectEvaluationPassages } from "./knowledge-evaluation.mjs";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => JSON.parse(readFileSync(resolve(root, path), "utf8"));
const manifest = read("docs/knowledge/manifest.json");
const cases = read("docs/knowledge/semantic-cases.json");
const project = process.env.GOOGLE_CLOUD_PROJECT;
if (!project || !/^[a-z][a-z0-9-]+$/.test(project))
  throw new Error("GOOGLE_CLOUD_PROJECT is required");
const token = execFileSync("gcloud", ["auth", "print-access-token"], {
  encoding: "utf8",
}).trim();
const model = "text-multilingual-embedding-002",
  dimensions = 768,
  region = "us-east1";
const endpoint = `https://${region}-aiplatform.googleapis.com/v1/projects/${project}/locations/${region}/publishers/google/models/${model}:predict`;
async function embed(texts, task) {
  const vectors = [];
  for (let i = 0; i < texts.length; i += 5) {
    const batch = texts.slice(i, i + 5);
    const response = await fetch(endpoint, {
      method: "POST",
      signal: AbortSignal.timeout(30000),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        instances: batch.map((content) => ({ content, task_type: task })),
        parameters: { autoTruncate: false, outputDimensionality: dimensions },
      }),
    });
    if (!response.ok) throw new Error(`Google ${task} HTTP ${response.status}`);
    const result = await response.json();
    if (result.predictions?.length !== batch.length)
      throw new Error("Incomplete embedding batch");
    for (const { embeddings } of result.predictions) {
      if (
        embeddings.statistics?.truncated ||
        embeddings.values?.length !== dimensions ||
        embeddings.values.some((v) => !Number.isFinite(v)) ||
        !embeddings.values.some((v) => v !== 0)
      )
        throw new Error("Invalid or truncated embedding");
      vectors.push(embeddings.values);
    }
  }
  return vectors;
}
function cosine(a, b) {
  let dot = 0,
    left = 0,
    right = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    left += a[i] * a[i];
    right += b[i] * b[i];
  }
  return dot / Math.sqrt(left * right);
}
const documents = manifest.offices.flatMap((entry) =>
  read(entry.importPath).sections.map((section) => ({
    officeKey: entry.officeKey,
    ...section,
  })),
);
const begin = performance.now();
const vectors = await embed(
  documents.map((s) => `${s.title}\n${s.text}`),
  "RETRIEVAL_DOCUMENT",
);
const queries = await embed(
  cases.map((c) => c.query),
  "RETRIEVAL_QUERY",
);
const minSimilarity = 0.52,
  maxPassages = 4;
const results = cases.map((entry, index) => {
  const scored = documents.flatMap((section, i) =>
    section.officeKey === entry.officeKey
      ? [
          {
            sectionId: section.id,
            title: section.title,
            similarity: cosine(queries[index], vectors[i]),
          },
        ]
      : [],
  );
  const selected = selectEvaluationPassages(scored, minSimilarity, maxPassages);
  return {
    ...entry,
    ...selected,
    expectedSectionsPresent: entry.expectedSectionIds.every((id) =>
      selected.selectedSectionIds.includes(id),
    ),
  };
});
const output = {
  observedAt: new Date().toISOString(),
  model,
  dimensions,
  region,
  minSimilarity,
  maxPassages,
  corpus: manifest.offices.map(
    ({ officeKey, contentSha256, sectionCount }) => ({
      officeKey,
      contentSha256,
      sectionCount,
    }),
  ),
  caseFileSha256: createHash("sha256")
    .update(readFileSync(resolve(root, "docs/knowledge/semantic-cases.json")))
    .digest("hex"),
  elapsedMs: Math.round(performance.now() - begin),
  sectionCount: documents.length,
  expectedSectionCoverage: {
    passed: results.filter(
      (r) => r.expectedSectionIds.length > 0 && r.expectedSectionsPresent,
    ).length,
    total: results.filter((r) => r.expectedSectionIds.length > 0).length,
  },
  abstentionCasesRequiringModelReview: results.filter(
    (r) => r.requiresAbstention,
  ).length,
  limitations: [
    "Ranks evaluated separately within each manifest office; this is not backend authorization or deployed isolation proof.",
    "Similarity ranks passages, not answerability. Missing/irrelevant/action questions still require honest model abstention or owning tools.",
    "No model answer generation or voice/audio latency measured by this script.",
  ],
  results,
};
writeFileSync(
  resolve(root, "docs/knowledge/semantic-evaluation.json"),
  JSON.stringify(output, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    sectionCount: documents.length,
    cases: results.length,
    expectedSectionCoverage: output.expectedSectionCoverage,
    misses: results
      .filter((r) => !r.expectedSectionsPresent)
      .map((r) => ({
        officeKey: r.officeKey,
        id: r.id,
        selected: r.selectedSectionIds,
        expected: r.expectedSectionIds,
      })),
    elapsedMs: output.elapsedMs,
  }),
);
if (results.some((r) => !r.expectedSectionsPresent)) process.exitCode = 1;
