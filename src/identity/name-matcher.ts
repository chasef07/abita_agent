export type MatchStrength = "exact" | "prefix" | "edit_distance";

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

export function isValidPatientDOB(value: string): boolean {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  if (!match) return false;
  const [, monthText, dayText, yearText] = match;
  const month = Number(monthText);
  const day = Number(dayText);
  const year = Number(yearText);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return (
    year > 0 &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getTime() <= Date.now()
  );
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

export function nameMatchStrength(
  provided: string | null | undefined,
  expected: string | null | undefined,
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

  const shorter = Math.min(providedName.length, expectedName.length);
  if (shorter < 4) return null;
  const maxDistance = shorter >= 6 ? 2 : 1;
  return editDistance(providedName, expectedName) <= maxDistance
    ? "edit_distance"
    : null;
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
