import type { DecisionPointCase } from "./types.js";

function normalizeTags(tags: string[]): string[] {
  return tags.filter((tag) => tag !== "needs-review").sort();
}

function parseTurn(id: string): number {
  const match = id.match(/-turn-(\d+)$/);
  return match ? Number.parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER;
}

function signature(testCase: DecisionPointCase): string {
  return JSON.stringify({
    traceId: testCase.traceId ?? testCase.id,
    suite: testCase.suite,
    tags: normalizeTags(testCase.tags),
    notes: testCase.context.notes ?? "",
    phoneLookupStatus: testCase.context.phoneLookupStatus,
    mustCallTools: [...testCase.expectations.mustCallTools].sort(),
    mustNotCallTools: [...testCase.expectations.mustNotCallTools].sort(),
    mustSay: [...(testCase.expectations.mustSay ?? [])].sort(),
    mustNotSay: [...(testCase.expectations.mustNotSay ?? [])].sort(),
    policyFlags: [...(testCase.expectations.policyFlags ?? [])].sort(),
    styleFlags: [...(testCase.expectations.styleFlags ?? [])].sort(),
  });
}

function compareCases(a: DecisionPointCase, b: DecisionPointCase): number {
  const turnDelta = parseTurn(a.id) - parseTurn(b.id);
  if (turnDelta !== 0) return turnDelta;
  return a.conversation.length - b.conversation.length;
}

export function curateDecisionPointCases(cases: DecisionPointCase[]): {
  curated: DecisionPointCase[];
  removed: DecisionPointCase[];
} {
  const keptBySignature = new Map<string, DecisionPointCase>();
  const removed: DecisionPointCase[] = [];

  for (const testCase of cases) {
    const key = signature(testCase);
    const current = keptBySignature.get(key);
    if (!current) {
      keptBySignature.set(key, testCase);
      continue;
    }

    if (compareCases(testCase, current) < 0) {
      removed.push(current);
      keptBySignature.set(key, testCase);
    } else {
      removed.push(testCase);
    }
  }

  const curated = Array.from(keptBySignature.values()).sort(compareCases);
  return { curated, removed };
}
