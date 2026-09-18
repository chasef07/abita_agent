import { z } from "zod";

const insuranceDecisionSchema = z
  .object({
    outcome: z.enum([
      "accepted",
      "not_accepted",
      "needs_clarification",
      "needs_staff_task",
    ]),
    participation: z.enum(["accepted", "not_accepted", "unknown"]),
    canonicalPlan: z.string().default(""),
    coverageType: z.enum(["medical", "routine_vision"]),
    officeId: z.string(),
    carrierCode: z.string().default(""),
    routing: z.string().default(""),
    allowedProviders: z.array(z.string()),
    requirements: z.array(
      z.object({
        kind: z.string(),
        channel: z.string().optional(),
        verification: z.literal("unverified"),
      }),
    ),
    eligibility: z.literal("not_checked"),
    canRegister: z.boolean(),
    canSchedule: z.boolean(),
    selfPay: z.boolean(),
    answer: z.string(),
  })
  .refine(
    (d) =>
      !(d.canRegister || d.canSchedule) ||
      (d.participation === "accepted" && !!d.canonicalPlan),
  )
  .refine(
    (d) =>
      !d.canSchedule ||
      (d.canRegister &&
        d.requirements.length === 0 &&
        d.allowedProviders.length > 0),
  );

export type InsuranceDecision = z.infer<typeof insuranceDecisionSchema>;
export function parseInsuranceDecision(
  value: unknown,
): InsuranceDecision | undefined {
  const result = insuranceDecisionSchema.safeParse(value);
  return result.success ? result.data : undefined;
}
export function decisionMatches(
  decision: InsuranceDecision | undefined,
  office: string,
  coverage: string,
  plan?: string,
): boolean {
  return (
    !!decision &&
    decision.officeId.replaceAll("_", "-") === office &&
    decision.coverageType === coverage &&
    (plan === undefined ||
      normalizePlan(decision.canonicalPlan) === normalizePlan(plan))
  );
}
function normalizePlan(plan: string): string {
  return plan
    .toLowerCase()
    .replaceAll("&", " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Participation answers cannot describe a refused write or booking as success.
export function registrationBlockedAnswer(decision: InsuranceDecision): string {
  return decision.outcome === "accepted"
    ? "This plan is accepted, but staff must verify its billing setup before creating or updating the chart."
    : decision.answer;
}

export function schedulingBlockedAnswer(decision: InsuranceDecision): string {
  return decision.outcome === "accepted"
    ? "This plan is accepted, but staff must verify the insurance setup before scheduling."
    : decision.answer ||
        "Resolve medical insurance requirements before scheduling.";
}
