export type MatchStrength = "exact" | "prefix" | "edit_distance";

export type CandidateNameMatch<T> =
  | {
      status: "unique";
      candidate: T;
      strength: MatchStrength;
      otherCandidates: T[];
    }
  | { status: "ambiguous"; candidates: T[] }
  | { status: "no_match" };

type FirstNameMatchOptions = {
  allowEditDistance?: boolean;
  includeFullInput?: boolean;
};

type NameSignal = {
  value: string;
  index: number;
  source: "full" | "word" | "spelled";
};

type CandidateMention<T> = {
  candidate: T;
  index: number;
  strength: MatchStrength;
};

export function matchCandidatesByFirstName<T>(
  input: string,
  candidates: readonly T[],
  getFirstName: (candidate: T) => string | null | undefined,
  options: FirstNameMatchOptions = {},
): CandidateNameMatch<T> {
  const signals = nameSignalSpans(input, options);
  const mentions = candidates
    .map((candidate) => {
      const firstName = getFirstName(candidate);
      const matches = signals
        .map((signal) => {
          const strength = nameMatchStrength(signal.value, firstName, options);
          return strength ? { candidate, index: signal.index, strength } : null;
        })
        .filter((match): match is CandidateMention<T> => match !== null)
        .sort(compareMentions);

      return matches[0] ?? null;
    })
    .filter((mention): mention is CandidateMention<T> => mention !== null)
    .sort(compareMentions);

  const strongMentions = mentions.filter(
    (mention) => mention.strength !== "edit_distance",
  );
  const mentionsToSearch =
    strongMentions.length > 0 ? strongMentions : mentions;
  const firstMention = mentionsToSearch[0];
  if (!firstMention) return { status: "no_match" };

  const earliestMentions = mentionsToSearch.filter(
    (mention) => mention.index === firstMention.index,
  );
  const nonEditDistanceMentions = earliestMentions.filter(
    (mention) => mention.strength !== "edit_distance",
  );
  const mentionsToResolve =
    nonEditDistanceMentions.length > 0
      ? nonEditDistanceMentions
      : earliestMentions;
  const earliestCandidates = uniqueCandidates(
    mentionsToResolve.map((mention) => mention.candidate),
  );
  if (earliestCandidates.length > 1) {
    return { status: "ambiguous", candidates: earliestCandidates };
  }

  const resolvedMention = mentionsToResolve[0] ?? firstMention;
  return {
    status: "unique",
    candidate: resolvedMention.candidate,
    strength: resolvedMention.strength,
    otherCandidates: uniqueCandidates(
      mentions
        .filter((mention) => mention.strength !== "edit_distance")
        .map((mention) => mention.candidate)
        .filter((candidate) => candidate !== resolvedMention.candidate),
    ),
  };
}

export function namesMatch(
  provided: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  const providedName = normalizeName(provided);
  const expectedName = normalizeName(expected);
  if (!providedName || !expectedName) return false;
  if (providedName === expectedName) return true;
  return (
    providedName.length >= 3 &&
    expectedName.length >= 3 &&
    (providedName.startsWith(expectedName) ||
      expectedName.startsWith(providedName))
  );
}

export function dobMatches(
  provided: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  const providedDob = normalizeDob(provided);
  const expectedDob = normalizeDob(expected);
  return Boolean(providedDob && expectedDob && providedDob === expectedDob);
}

export function normalizeName(value: string | null | undefined): string {
  return collapseConsecutiveLetters(
    value
      ?.normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z]/g, "") ?? "",
  );
}

function nameSignalSpans(
  input: string,
  options: FirstNameMatchOptions,
): NameSignal[] {
  const signals: NameSignal[] = [];
  const includeFullInput = options.includeFullInput ?? true;
  const full = normalizeName(input);
  if (includeFullInput && full) {
    signals.push({ value: full, index: 0, source: "full" });
  }

  const wordMatches = input.matchAll(/[A-Za-z]+/g);
  let spelledRun = "";
  let spelledRunIndex: number | null = null;
  for (const match of wordMatches) {
    const word = match[0];
    const index = match.index ?? 0;
    const normalized = normalizeName(word);
    if (!normalized) continue;
    if (normalized.length === 1) {
      if (spelledRunIndex === null) spelledRunIndex = index;
      spelledRun += normalized;
      continue;
    }
    if (spelledRun.length >= 2) {
      signals.push({
        value: spelledRun,
        index: spelledRunIndex ?? index,
        source: "spelled",
      });
    }
    spelledRun = "";
    spelledRunIndex = null;
    signals.push({ value: normalized, index, source: "word" });
  }
  if (spelledRun.length >= 2) {
    signals.push({
      value: spelledRun,
      index: spelledRunIndex ?? 0,
      source: "spelled",
    });
  }

  return signals.filter((signal) =>
    signal.source === "full"
      ? signal.value.length > 0
      : signal.value.length >= 3,
  );
}

function nameMatchStrength(
  provided: string | null | undefined,
  expected: string | null | undefined,
  options: FirstNameMatchOptions,
): MatchStrength | null {
  const providedName = normalizeName(provided);
  const expectedName = normalizeName(expected);
  if (!providedName || !expectedName) return null;
  if (providedName === expectedName) return "exact";

  if (
    providedName.length >= 3 &&
    expectedName.length >= 3 &&
    (providedName.startsWith(expectedName) ||
      expectedName.startsWith(providedName))
  ) {
    return "prefix";
  }

  if (options.allowEditDistance === false) return null;
  const shorter = Math.min(providedName.length, expectedName.length);
  if (shorter < 4) return null;
  const maxDistance = shorter >= 6 ? 2 : 1;
  return editDistance(providedName, expectedName) <= maxDistance
    ? "edit_distance"
    : null;
}

function compareMentions<T>(
  left: CandidateMention<T>,
  right: CandidateMention<T>,
): number {
  return (
    left.index - right.index ||
    matchStrengthRank(left.strength) - matchStrengthRank(right.strength)
  );
}

function matchStrengthRank(strength: MatchStrength): number {
  switch (strength) {
    case "exact":
      return 0;
    case "prefix":
      return 1;
    case "edit_distance":
      return 2;
  }
}

function uniqueCandidates<T>(candidates: T[]): T[] {
  return candidates.filter(
    (candidate, index) => candidates.indexOf(candidate) === index,
  );
}

function normalizeDob(value: string | null | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) return "";

  const match = trimmed.match(/^(\d{1,2})\D+(\d{1,2})\D+(\d{2,4})$/);
  if (!match) return trimmed.replace(/\D/g, "");

  const [, month, day, rawYear] = match;
  const year =
    rawYear.length === 2
      ? Number(rawYear) > 30
        ? `19${rawYear}`
        : `20${rawYear}`
      : rawYear;
  return `${month.padStart(2, "0")}${day.padStart(2, "0")}${year}`;
}

function collapseConsecutiveLetters(value: string): string {
  return value.replace(/(.)\1+/g, "$1");
}

function editDistance(left: string, right: string): number {
  const previous = Array.from(
    { length: right.length + 1 },
    (_, index) => index,
  );
  const current = Array.from({ length: right.length + 1 }, () => 0);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    current[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitutionCost =
        left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        current[rightIndex - 1] + 1,
        previous[rightIndex - 1] + substitutionCost,
      );
    }
    previous.splice(0, previous.length, ...current);
  }

  return previous[right.length] ?? 0;
}
