// Offline-corpus calibration using real Google embeddings and fixed PHI-free questions.
// GOOGLE_CLOUD_PROJECT=... pnpm exec tsx scripts/evaluate-portal-knowledge.ts
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const corpus = JSON.parse(
  readFileSync(
    new URL(
      "../docs/evidence/spring-hill-knowledge-import.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { sections: { title: string; text: string }[] };
const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../docs/evidence/office-knowledge-google-evaluation.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { cases: { id: string; query: string; expectedSections: string[] }[] };
const project = process.env.GOOGLE_CLOUD_PROJECT;
if (!project) throw new Error("GOOGLE_CLOUD_PROJECT is required");
const token = execFileSync("gcloud", ["auth", "print-access-token"], {
  encoding: "utf8",
}).trim();
const endpoint = `https://us-east1-aiplatform.googleapis.com/v1/projects/${encodeURIComponent(project)}/locations/us-east1/publishers/google/models/text-multilingual-embedding-002:predict`;
async function embed(
  content: string[],
  task: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY",
) {
  const values: number[][] = [];
  for (let start = 0; start < content.length; start += 5) {
    const response = await fetch(endpoint, {
      method: "POST",
      signal: AbortSignal.timeout(30000),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        instances: content
          .slice(start, start + 5)
          .map((content) => ({ content, task_type: task })),
        parameters: { autoTruncate: false, outputDimensionality: 768 },
      }),
    });
    if (!response.ok)
      throw new Error(
        `Google embedding request failed: HTTP ${response.status}`,
      );
    const result = (await response.json()) as {
      predictions: {
        embeddings: { values: number[]; statistics: { truncated: boolean } };
      }[];
    };
    for (const { embeddings } of result.predictions) {
      if (embeddings.statistics.truncated || embeddings.values.length !== 768)
        throw new Error("Embedding contract violation");
      values.push(embeddings.values);
    }
  }
  if (values.length !== content.length) throw new Error("Missing embeddings");
  return values;
}
function cosine(left: number[], right: number[]) {
  const dot = left.reduce(
    (sum, value, index) => sum + value * right[index]!,
    0,
  );
  return (
    dot /
    Math.sqrt(
      left.reduce((sum, v) => sum + v * v, 0) *
        right.reduce((sum, v) => sum + v * v, 0),
    )
  );
}
const sections = await embed(
  corpus.sections.map((s) => `${s.title}\n${s.text}`),
  "RETRIEVAL_DOCUMENT",
);
const queries = await embed(
  fixture.cases.map((c) => c.query),
  "RETRIEVAL_QUERY",
);
console.log(
  JSON.stringify(
    fixture.cases.map((entry, index) => ({
      id: entry.id,
      expectedSections: entry.expectedSections,
      ranked: corpus.sections
        .map((section, sectionIndex) => ({
          title: section.title,
          score: Number(
            cosine(queries[index]!, sections[sectionIndex]!).toFixed(4),
          ),
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 5),
    })),
    null,
    2,
  ),
);
