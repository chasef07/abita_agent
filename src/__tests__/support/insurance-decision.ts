import type { InsuranceDecision } from "../../clients/insurance-decision.js";
export function medicalDecision(
  overrides: Partial<InsuranceDecision> = {},
): InsuranceDecision {
  return {
    outcome: "accepted",
    participation: "accepted",
    canonicalPlan: "Self Pay",
    carrierCode: "SELF",
    coverageType: "medical",
    officeId: "spring_hill",
    routing: "all_three",
    allowedProviders: ["Dr. Bach"],
    requirements: [],
    eligibility: "not_checked",
    canRegister: true,
    canSchedule: true,
    selfPay: true,
    answer: "success: This office participates with Self Pay.",
    ...overrides,
  };
}
