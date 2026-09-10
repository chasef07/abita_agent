import assert from "node:assert/strict";
import { test } from "vitest";
import { selectEvaluationPassages } from "./knowledge-evaluation.mjs";

test("display rounding neither admits a below-threshold passage nor changes close ranking", () => {
  const sections = [
    { sectionId: "lower", title: "Lower", similarity: 0.52001 },
    { sectionId: "below", title: "Below", similarity: 0.51996 },
    { sectionId: "higher", title: "Higher", similarity: 0.52004 },
  ];
  const selected = selectEvaluationPassages(sections, 0.52, 4);
  assert.deepEqual(selected.selectedSectionIds, ["higher", "lower"]);
  assert.deepEqual(
    selected.ranked.map((section) => section.sectionId),
    ["higher", "lower", "below"],
  );
  assert.deepEqual(
    selected.ranked.map((section) => section.similarity),
    [0.52, 0.52, 0.52],
  );
  assert.deepEqual(
    selectEvaluationPassages(sections, 0.52, 1).selectedSectionIds,
    ["higher"],
  );
});
