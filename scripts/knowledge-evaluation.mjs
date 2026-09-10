// Selection policy for the offline evaluator; runtime authority remains Product.
export function selectEvaluationPassages(scored, minSimilarity, maxPassages) {
  const ranked = [...scored].sort((a, b) => b.similarity - a.similarity);
  return {
    selectedSectionIds: ranked
      .filter((section) => section.similarity >= minSimilarity)
      .slice(0, maxPassages)
      .map((section) => section.sectionId),
    // Display precision must not affect membership or order.
    ranked: ranked.slice(0, 5).map((section) => ({
      ...section,
      similarity: Number(section.similarity.toFixed(4)),
    })),
  };
}
