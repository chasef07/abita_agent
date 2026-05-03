import { readFileSync } from "fs";
import { join } from "path";
import { getOfficeConfig, type OfficeKey } from "./offices.js";

const WORKSPACE = join(import.meta.dirname, "..", "workspace");

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

  for (const rule of reference.aliasRules) {
    const matchedAlias = rule.aliases.find((alias) =>
      normalizedQuery.includes(normalizeInsuranceText(alias)),
    );
    if (!matchedAlias) continue;
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

export function matchInsurancePlanForOffice(
  officeKey: OfficeKey,
  query: string,
): InsuranceLookupResult {
  const file = getOfficeConfig(officeKey).insuranceFile;
  const reference = loadInsuranceReference(file);
  return matchInsurancePlan(reference, query);
}
