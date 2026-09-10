import { doubleMetaphone } from "double-metaphone";
import { fuzzy } from "fast-fuzzy";

const FUZZY_NAME_THRESHOLD = 0.85;
const PHONETIC_NAME_THRESHOLD = 0.65;

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

export function phoneCandidateFirstNameMatches(
  provided: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  const providedName = normalizeName(provided);
  const expectedName = normalizeName(expected);
  if (!providedName || !expectedName) return false;
  if (providedName === expectedName) return true;

  // Score the whole name: substring search can give unrelated names a 1.0.
  const score = fuzzy(providedName, expectedName, {
    useDamerau: true,
    useSellers: false,
  });
  if (score >= FUZZY_NAME_THRESHOLD) return true;
  if (score < PHONETIC_NAME_THRESHOLD) return false;

  const expectedCodes = doubleMetaphone(expectedName);
  return doubleMetaphone(providedName).some(
    (code) => code !== "" && expectedCodes.includes(code),
  );
}

// Only use after the phone candidate's first name and supplied DOB match.
export function phoneCandidateSurnameMatches(
  provided: string,
  expected: string,
): boolean {
  const providedName = normalizeName(provided);
  const expectedName = normalizeName(expected);
  if (!providedName || !expectedName) return false;
  if (providedName === expectedName) return true;
  if (Math.min(providedName.length, expectedName.length) < 4) return false;

  const providedParts = provided
    .split(/[\s-]+/)
    .map(normalizeName)
    .filter(Boolean);
  const expectedParts = expected
    .split(/[\s-]+/)
    .map(normalizeName)
    .filter(Boolean);
  if (
    (providedParts.length === 1 &&
      expectedParts.length > 1 &&
      [expectedParts[0], expectedParts.at(-1)].includes(providedName)) ||
    (expectedParts.length === 1 &&
      providedParts.length > 1 &&
      [providedParts[0], providedParts.at(-1)].includes(expectedName))
  ) {
    return true;
  }

  // With Sellers disabled, fast-fuzzy scores whole-name edit distance / max length.
  // Permit at most one insertion, deletion, substitution, or adjacent transposition.
  return (
    fuzzy(providedName, expectedName, {
      useDamerau: true,
      useSellers: false,
    }) >=
    1 - 1 / Math.max(providedName.length, expectedName.length)
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
