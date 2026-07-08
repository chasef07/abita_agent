import { readFileSync } from "fs";
import { join } from "path";
import { getOfficeConfig, type OfficeKey } from "./customers/profile.js";

const WORKSPACE = join(import.meta.dirname, "..", "workspace");

export type InsuranceCoverageType = "medical" | "routine_vision";

export type InsuranceMatchStatus =
  "accepted" | "not_accepted" | "needs_clarification" | "needs_transfer";

export interface InsurancePlanRule {
  id?: string;
  status: InsuranceMatchStatus;
  canonicalPlan?: string | null;
  displayName?: string | null;
  aliases?: string[];
  clarificationNeeded?: string;
  preauthRequired?: boolean;
  canProceed: boolean;
  needsExactPlanName: boolean;
}

export interface InsuranceReference {
  version?: number;
  officeLabel: string;
  coverageType?: InsuranceCoverageType;
  plans: InsurancePlanRule[];
}

export interface InsuranceLookupResult {
  status: InsuranceMatchStatus;
  query: string;
  matchedPlan: string | null;
  matchedAlias: string | null;
  matchedFamily: string | null;
  callerFacingPlan: string | null;
  canProceed: boolean;
  needsExactPlanName: boolean;
  clarificationNeeded: string | null;
  preauthRequired: boolean;
}

export type InsuranceToolResponse =
  | {
      status: "accepted";
      plan: string;
    }
  | {
      status: "not_accepted";
      plan: string;
    }
  | {
      status: "needs_clarification";
      clarificationNeeded: string;
    }
  | {
      status: "needs_transfer";
      plan: string;
      preauthRequired: true;
      message: string;
    };

const referenceCache = new Map<string, InsuranceReference>();

export function normalizeInsuranceText(text: string): string {
  return text
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function loadInsuranceReference(file: string): InsuranceReference {
  const cached = referenceCache.get(file);
  if (cached) return cached;
  const raw = readFileSync(join(WORKSPACE, file), "utf-8");
  const parsed = normalizeInsuranceReference(
    JSON.parse(raw) as InsuranceReference,
  );
  referenceCache.set(file, parsed);
  return parsed;
}

export function insuranceFileForCoverage(
  officeKey: OfficeKey,
  coverageType: InsuranceCoverageType = "medical",
): string {
  const office = getOfficeConfig(officeKey);
  if (coverageType === "routine_vision") {
    return (
      office.visionInsuranceFile ??
      getOfficeConfig("spring-hill").visionInsuranceFile ??
      office.insuranceFile
    );
  }
  return office.insuranceFile;
}

export function canonicalInsurancePlan(
  result: InsuranceLookupResult,
): string | null {
  if (result.status !== "accepted" || !result.canProceed) return null;
  return result.matchedPlan ?? result.matchedFamily ?? null;
}

export function buildInsuranceToolResponse(
  result: InsuranceLookupResult,
): InsuranceToolResponse {
  if (result.status === "accepted") {
    return {
      status: "accepted",
      plan: result.callerFacingPlan ?? result.matchedFamily ?? result.query,
    };
  }

  if (result.status === "not_accepted") {
    return {
      status: "not_accepted",
      plan: result.callerFacingPlan ?? result.query,
    };
  }

  if (result.status === "needs_transfer") {
    const plan =
      result.callerFacingPlan ?? result.matchedFamily ?? result.query;
    return {
      status: "needs_transfer",
      plan,
      preauthRequired: true,
      message: `Prior authorization is required for ${plan}. Transfer the caller to staff before scheduling.`,
    };
  }

  return {
    status: "needs_clarification",
    clarificationNeeded:
      result.clarificationNeeded ??
      "the exact plan name from the insurance card",
  };
}

export function matchInsurancePlan(
  reference: InsuranceReference,
  query: string,
): InsuranceLookupResult {
  const normalizedQuery = normalizeInsuranceText(query);
  const selected = selectInsuranceCandidate(
    collectInsuranceCandidates(reference.plans, normalizedQuery),
  );
  if (!selected) return buildUnknownInsuranceResult(query);
  return buildPlanMatchResult(query, selected);
}

export function matchInsurancePlanForOffice(
  officeKey: OfficeKey,
  query: string,
  coverageType: InsuranceCoverageType = "medical",
): InsuranceLookupResult {
  if (
    coverageType === "medical" &&
    !getOfficeConfig(officeKey).features.medicalScheduling
  ) {
    return buildUnsupportedInsuranceResult(query);
  }
  if (
    coverageType === "routine_vision" &&
    !getOfficeConfig(officeKey).features.routineVisionScheduling
  ) {
    return buildUnsupportedInsuranceResult(query);
  }
  const file = insuranceFileForCoverage(officeKey, coverageType);
  const reference = loadInsuranceReference(file);
  return matchInsurancePlan(reference, query);
}

type MatchTermSource = "display" | "alias";

interface InsuranceCandidate {
  rule: InsurancePlanRule;
  term: string;
  normalizedTerm: string;
  source: MatchTermSource;
  exactQuery: boolean;
}

function normalizeInsuranceReference(
  raw: InsuranceReference,
): InsuranceReference {
  return {
    version: raw.version ?? 2,
    officeLabel: raw.officeLabel,
    coverageType: raw.coverageType,
    plans: raw.plans.map(normalizePlanRule).filter((plan) => plan !== null),
  };
}

function normalizePlanRule(rule: InsurancePlanRule): InsurancePlanRule | null {
  const canonicalPlan = rule.canonicalPlan?.trim() || null;
  const displayName = rule.displayName?.trim() || canonicalPlan;
  const aliases = uniqueStrings(rule.aliases ?? []);
  if (!canonicalPlan && !displayName && aliases.length === 0) return null;

  return {
    ...rule,
    id:
      rule.id?.trim() ||
      slugInsuranceId(`${rule.status}-${canonicalPlan ?? displayName}`),
    canonicalPlan,
    displayName,
    aliases,
    preauthRequired: rule.preauthRequired === true,
    canProceed: rule.canProceed,
    needsExactPlanName: rule.needsExactPlanName,
  };
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    const normalized = normalizeInsuranceText(trimmed);
    if (!trimmed || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(trimmed);
  }
  return result;
}

function slugInsuranceId(value: string): string {
  return (
    normalizeInsuranceText(value)
      .replace(/\s+/g, "-")
      .replace(/^-+|-+$/g, "") || "insurance-plan"
  );
}

function collectInsuranceCandidates(
  plans: InsurancePlanRule[],
  normalizedQuery: string,
): InsuranceCandidate[] {
  if (!normalizedQuery) return [];

  const candidates: InsuranceCandidate[] = [];
  for (const rule of plans) {
    for (const term of matchTermsForRule(rule)) {
      const normalizedTerm = normalizeInsuranceText(term.value);
      if (
        !normalizedTerm ||
        !containsNormalizedPhrase(normalizedQuery, normalizedTerm)
      ) {
        continue;
      }
      candidates.push({
        rule,
        term: term.value,
        normalizedTerm,
        source: term.source,
        exactQuery: normalizedQuery === normalizedTerm,
      });
    }
  }
  return candidates;
}

function matchTermsForRule(
  rule: InsurancePlanRule,
): Array<{ value: string; source: MatchTermSource }> {
  return [
    ...(rule.displayName
      ? [{ value: rule.displayName, source: "display" as const }]
      : []),
    ...(rule.aliases ?? []).map((alias) => ({
      value: alias,
      source: "alias" as const,
    })),
  ];
}

function containsNormalizedPhrase(query: string, term: string): boolean {
  return (
    query === term ||
    query.startsWith(`${term} `) ||
    query.endsWith(` ${term}`) ||
    query.includes(` ${term} `)
  );
}

function selectInsuranceCandidate(
  candidates: InsuranceCandidate[],
): InsuranceCandidate | null {
  if (candidates.length === 0) return null;

  const exactCandidates = candidates.filter(
    (candidate) => candidate.exactQuery,
  );
  if (exactCandidates.length > 0)
    return bestInsuranceCandidate(exactCandidates);

  const rejectedCandidate = bestInsuranceCandidate(
    candidates.filter((candidate) => candidate.rule.status === "not_accepted"),
  );
  const acceptedCandidate = bestInsuranceCandidate(
    candidates.filter((candidate) => candidate.rule.status === "accepted"),
  );
  const clarificationCandidate = bestInsuranceCandidate(
    candidates.filter(
      (candidate) => candidate.rule.status === "needs_clarification",
    ),
  );
  const acceptedCandidateContainsRejectedAlias =
    rejectedCandidate &&
    acceptedCandidate &&
    compareInsuranceCandidates(acceptedCandidate, rejectedCandidate) > 0 &&
    containsNormalizedPhrase(
      acceptedCandidate.normalizedTerm,
      rejectedCandidate.normalizedTerm,
    );

  if (rejectedCandidate && !acceptedCandidateContainsRejectedAlias) {
    return rejectedCandidate;
  }

  if (
    acceptedCandidate &&
    (!clarificationCandidate ||
      compareInsuranceCandidates(acceptedCandidate, clarificationCandidate) > 0)
  ) {
    return acceptedCandidate;
  }

  return clarificationCandidate ?? acceptedCandidate ?? null;
}

function bestInsuranceCandidate(
  candidates: InsuranceCandidate[],
): InsuranceCandidate | null {
  return (
    [...candidates].sort((a, b) => compareInsuranceCandidates(b, a))[0] ?? null
  );
}

function compareInsuranceCandidates(
  left: InsuranceCandidate,
  right: InsuranceCandidate,
): number {
  if (left.exactQuery !== right.exactQuery) return left.exactQuery ? 1 : -1;
  if (left.normalizedTerm.length !== right.normalizedTerm.length) {
    return left.normalizedTerm.length - right.normalizedTerm.length;
  }
  return sourcePriority(left.source) - sourcePriority(right.source);
}

function sourcePriority(source: MatchTermSource): number {
  if (source === "display") return 2;
  return 1;
}

function buildPlanMatchResult(
  query: string,
  candidate: InsuranceCandidate,
): InsuranceLookupResult {
  const { rule } = candidate;
  if (rule.status === "needs_clarification") {
    const clarificationNeeded =
      rule.clarificationNeeded ?? "the exact plan name from the insurance card";
    return {
      status: "needs_clarification",
      query,
      matchedPlan: null,
      matchedAlias: candidate.term,
      matchedFamily: null,
      callerFacingPlan: null,
      canProceed: rule.canProceed,
      needsExactPlanName: rule.needsExactPlanName,
      clarificationNeeded,
      preauthRequired: rule.preauthRequired === true,
    };
  }

  const canonicalPlan =
    rule.canonicalPlan?.trim() || rule.displayName?.trim() || candidate.term;
  const callerFacingPlan = callerFacingPlanForCandidate(candidate);
  const matchedPlan = candidateMatchedCanonicalPlan(candidate)
    ? canonicalPlan
    : null;
  const preauthRequired = rule.preauthRequired === true;

  if (preauthRequired) {
    return {
      status: "needs_transfer",
      query,
      matchedPlan,
      matchedAlias: matchedPlan ? null : candidate.term,
      matchedFamily: canonicalPlan,
      callerFacingPlan,
      canProceed: false,
      needsExactPlanName: rule.needsExactPlanName,
      clarificationNeeded: null,
      preauthRequired,
    };
  }

  return {
    status: rule.status,
    query,
    matchedPlan,
    matchedAlias: matchedPlan ? null : candidate.term,
    matchedFamily: canonicalPlan,
    callerFacingPlan,
    canProceed: rule.canProceed,
    needsExactPlanName: rule.needsExactPlanName,
    clarificationNeeded: null,
    preauthRequired,
  };
}

function candidateMatchedCanonicalPlan(candidate: InsuranceCandidate): boolean {
  const canonicalPlan = candidate.rule.canonicalPlan?.trim();
  const displayName = candidate.rule.displayName?.trim();
  return Boolean(
    canonicalPlan &&
    displayName &&
    candidate.source === "display" &&
    normalizeInsuranceText(canonicalPlan) ===
      normalizeInsuranceText(displayName),
  );
}

function callerFacingPlanForCandidate(candidate: InsuranceCandidate): string {
  const canonicalPlan = candidate.rule.canonicalPlan?.trim();
  const displayName = candidate.rule.displayName?.trim();
  if (
    candidate.source === "alias" &&
    (!displayName ||
      (canonicalPlan &&
        normalizeInsuranceText(displayName) ===
          normalizeInsuranceText(canonicalPlan)))
  ) {
    return candidate.term;
  }
  return displayName || canonicalPlan || candidate.term;
}

function buildUnknownInsuranceResult(query: string): InsuranceLookupResult {
  return {
    status: "needs_clarification",
    query,
    matchedPlan: null,
    matchedAlias: null,
    matchedFamily: null,
    callerFacingPlan: null,
    canProceed: false,
    needsExactPlanName: false,
    clarificationNeeded: "the exact plan name from the insurance card",
    preauthRequired: false,
  };
}

function buildUnsupportedInsuranceResult(query: string): InsuranceLookupResult {
  return {
    status: "not_accepted",
    query,
    matchedPlan: null,
    matchedAlias: null,
    matchedFamily: null,
    callerFacingPlan: query,
    canProceed: false,
    needsExactPlanName: false,
    clarificationNeeded: null,
    preauthRequired: false,
  };
}
