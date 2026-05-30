import { llm } from "@livekit/agents";
import { z } from "zod";
import {
  buildInsuranceToolResponse,
  canonicalInsurancePlan,
  matchInsurancePlanForOffice,
  normalizeCoverageType,
  type InsuranceToolResponse,
} from "../insurance-rules.js";
import { activeOfficeKey } from "../state/call-state.js";
import { getState } from "./session.js";

export const check_insurance = llm.tool({
  description:
    "Check whether the active office accepts the caller's insurance plan. " +
    "Provide the plan name exactly as the caller gave it. " +
    "Include coverageType only when the visit is clearly medical or routine vision. " +
    "Returns callerMessage, clarificationNeeded, routeTool, canProceed, and canonicalPlan.",
  parameters: z.object({
    plan: z.string().describe("The insurance plan name the caller mentioned"),
    coverageType: z
      .enum(["medical", "routine_vision"])
      .optional()
      .describe(
        "medical for ophthalmology coverage; routine_vision for routine eye exam/glasses/contact lens prescription coverage.",
      ),
  }),
  execute: async ({ plan, coverageType }, { ctx }) => {
    const state = getState(ctx);
    const normalizedCoverageType = normalizeCoverageType(coverageType);
    const result = matchInsurancePlanForOffice(
      activeOfficeKey(state),
      plan,
      normalizedCoverageType,
    );
    const checkedInsurancePlan = canonicalInsurancePlan(result);
    const checkedInsuranceCoverageType = checkedInsurancePlan
      ? normalizedCoverageType
      : null;
    state.checkedInsurance = {
      plan,
      canonicalPlan: checkedInsurancePlan,
      coverageType: checkedInsuranceCoverageType,
      currentCarrier: checkedInsurancePlan,
    };
    state.scheduling.coverageType = checkedInsuranceCoverageType;
    const response = buildInsuranceToolResponse(result);
    if (
      activeOfficeKey(state) === "crystal-river" &&
      result.status === "not_accepted"
    ) {
      const springHillResult = matchInsurancePlanForOffice("spring-hill", plan);
      const springHillPlan = canonicalInsurancePlan(springHillResult);
      if (springHillResult.status === "accepted" && springHillPlan) {
        return normalizeInsuranceOutcome({
          ...response,
          acceptedAtAlternateOffice: "Spring Hill",
          alternateCanonicalPlan: springHillPlan,
          routeTool: "route_to_spring_hill",
          callerMessage: `${response.callerMessage} Spring Hill accepts ${springHillPlan}. Ask if they'd like to schedule there, then route to Spring Hill if they agree.`,
        });
      }
    }
    return normalizeInsuranceOutcome(response);
  },
});

function normalizeInsuranceOutcome(response: InsuranceToolResponse) {
  const routeRequired = Boolean(response.routeTool);
  const routeTool =
    response.routeTool ?? (routeRequired ? "route_to_spring_hill" : undefined);
  const outcome = routeRequired
    ? "route_required"
    : response.status === "accepted" && response.canProceed
      ? "success"
      : response.status === "needs_clarification"
        ? "needs_clarification"
        : "not_allowed";
  return {
    ...response,
    ...(routeTool ? { routeTool } : {}),
    outcome,
    speak: response.callerMessage,
    facts: {
      status: response.status,
      canProceed: response.canProceed,
      canonicalPlan: response.canonicalPlan,
      clarificationNeeded: response.clarificationNeeded,
      acceptedAtAlternateOffice: response.acceptedAtAlternateOffice,
      alternateCanonicalPlan: response.alternateCanonicalPlan,
      routeTool,
    },
    retryable: outcome !== "success",
  };
}
