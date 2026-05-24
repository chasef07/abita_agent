import { readFileSync } from "fs";
import { join } from "path";
import { getOfficeConfig, type OfficeKey } from "./customer/profile.js";

const WORKSPACE = join(import.meta.dirname, "..", "workspace");

export type InsuranceCoverageType = "medical" | "routine_vision";

export type InsuranceMatchStatus =
  | "accepted"
  | "not_accepted"
  | "needs_clarification";

export interface InsuranceAliasRule {
  aliases: string[];
  status: InsuranceMatchStatus;
  family?: string;
  callerPlan?: string;
  clarificationNeeded?: string;
  callerMessage?: string;
  canProceed: boolean;
  needsExactPlanName: boolean;
}

export interface InsuranceReference {
  officeLabel: string;
  aliasRules: InsuranceAliasRule[];
  acceptedPlans: string[];
  notAcceptedPlans: string[];
}

export interface InsuranceLookupResult {
  status: InsuranceMatchStatus;
  query: string;
  matchedPlan: string | null;
  matchedAlias: string | null;
  matchedFamily: string | null;
  canProceed: boolean;
  needsExactPlanName: boolean;
  clarificationNeeded: string | null;
  callerMessage: string;
}

export interface InsuranceToolResponse {
  status: InsuranceMatchStatus;
  canProceed: boolean;
  canonicalPlan: string | null;
  clarificationNeeded: string | null;
  callerMessage: string;
  acceptedAtAlternateOffice?: string;
  alternateCanonicalPlan?: string;
  routeTool?: string;
}

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
  const parsed = JSON.parse(raw) as InsuranceReference;
  referenceCache.set(file, parsed);
  return parsed;
}

export function normalizeCoverageType(
  coverageType?: string | null,
): InsuranceCoverageType {
  return coverageType === "routine_vision" ? "routine_vision" : "medical";
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

function findExactPlan(
  plans: string[],
  normalizedQuery: string,
): string | null {
  for (const plan of plans) {
    if (normalizeInsuranceText(plan) === normalizedQuery) return plan;
  }
  return null;
}

function buildAcceptedCallerMessage(plan: string): string {
  return `yeah we take ${plan}.`;
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
  return {
    status: result.status,
    canProceed: result.canProceed,
    canonicalPlan: canonicalInsurancePlan(result),
    clarificationNeeded: result.clarificationNeeded,
    callerMessage: result.callerMessage,
  };
}

export function matchInsurancePlan(
  reference: InsuranceReference,
  query: string,
): InsuranceLookupResult {
  const normalizedQuery = normalizeInsuranceText(query);
  const exactAccepted = findExactPlan(reference.acceptedPlans, normalizedQuery);
  if (exactAccepted) {
    return {
      status: "accepted",
      query,
      matchedPlan: exactAccepted,
      matchedAlias: null,
      matchedFamily: exactAccepted,
      canProceed: true,
      needsExactPlanName: false,
      clarificationNeeded: null,
      callerMessage: buildAcceptedCallerMessage(exactAccepted),
    };
  }

  const exactRejected = findExactPlan(
    reference.notAcceptedPlans,
    normalizedQuery,
  );
  if (exactRejected) {
    return {
      status: "not_accepted",
      query,
      matchedPlan: exactRejected,
      matchedAlias: null,
      matchedFamily: exactRejected,
      canProceed: false,
      needsExactPlanName: false,
      clarificationNeeded: null,
      callerMessage: `we don't accept ${exactRejected}.`,
    };
  }

  let bestAliasMatch: {
    rule: InsuranceAliasRule;
    alias: string;
    normalizedAlias: string;
  } | null = null;

  for (const rule of reference.aliasRules) {
    for (const alias of rule.aliases) {
      const normalizedAlias = normalizeInsuranceText(alias);
      if (!normalizedAlias || !normalizedQuery.includes(normalizedAlias)) {
        continue;
      }
      if (
        !bestAliasMatch ||
        normalizedAlias.length > bestAliasMatch.normalizedAlias.length
      ) {
        bestAliasMatch = { rule, alias, normalizedAlias };
      }
    }
  }

  if (bestAliasMatch) {
    const { rule, alias: matchedAlias } = bestAliasMatch;
    const rejectedAliasMatch = findRejectedAliasMatch(
      reference.aliasRules,
      normalizedQuery,
    );
    if (
      rejectedAliasMatch &&
      bestAliasMatch.rule.status !== "not_accepted" &&
      normalizeInsuranceText(rejectedAliasMatch.alias).length > 0
    ) {
      return buildAliasMatchResult(query, rejectedAliasMatch);
    }
    if (rule.status === "needs_clarification") {
      const clarificationNeeded =
        rule.clarificationNeeded ??
        "the exact plan name from the insurance card";
      return {
        status: "needs_clarification",
        query,
        matchedPlan: null,
        matchedAlias,
        matchedFamily: null,
        canProceed: rule.canProceed,
        needsExactPlanName: rule.needsExactPlanName,
        clarificationNeeded,
        callerMessage:
          rule.callerMessage ??
          `I can check that, but I need to know ${clarificationNeeded.toLowerCase()}.`,
      };
    }

    return buildAliasMatchResult(query, bestAliasMatch);
  }

  return {
    status: "needs_clarification",
    query,
    matchedPlan: null,
    matchedAlias: null,
    matchedFamily: null,
    canProceed: false,
    needsExactPlanName: false,
    clarificationNeeded: "the exact plan name from the insurance card",
    callerMessage:
      "I can't confirm that plan from the shorthand alone. If you have the insurance card, I can check the exact plan name.",
  };
}

function findRejectedAliasMatch(
  rules: InsuranceAliasRule[],
  normalizedQuery: string,
): { rule: InsuranceAliasRule; alias: string; normalizedAlias: string } | null {
  let rejectedMatch: {
    rule: InsuranceAliasRule;
    alias: string;
    normalizedAlias: string;
  } | null = null;

  for (const rule of rules) {
    if (rule.status !== "not_accepted") continue;
    for (const alias of rule.aliases) {
      const normalizedAlias = normalizeInsuranceText(alias);
      if (!normalizedAlias || !normalizedQuery.includes(normalizedAlias)) {
        continue;
      }
      if (
        !rejectedMatch ||
        normalizedAlias.length > rejectedMatch.normalizedAlias.length
      ) {
        rejectedMatch = { rule, alias, normalizedAlias };
      }
    }
  }

  return rejectedMatch;
}

function buildAliasMatchResult(
  query: string,
  match: { rule: InsuranceAliasRule; alias: string },
): InsuranceLookupResult {
  const { rule, alias: matchedAlias } = match;
  const callerPlan = rule.callerPlan ?? rule.family ?? matchedAlias;
  return {
    status: rule.status,
    query,
    matchedPlan: null,
    matchedAlias,
    matchedFamily: rule.family ?? null,
    canProceed: rule.canProceed,
    needsExactPlanName: rule.needsExactPlanName,
    clarificationNeeded: null,
    callerMessage:
      rule.callerMessage ??
      (rule.status === "accepted"
        ? buildAcceptedCallerMessage(callerPlan)
        : `we don't accept ${callerPlan}.`),
  };
}

export function matchInsurancePlanForOffice(
  officeKey: OfficeKey,
  query: string,
  coverageType: InsuranceCoverageType = "medical",
): InsuranceLookupResult {
  const file = insuranceFileForCoverage(officeKey, coverageType);
  const reference = loadInsuranceReference(file);
  return matchInsurancePlan(reference, query);
}
