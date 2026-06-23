import { llm } from "@livekit/agents";
import { z } from "zod";
import {
  buildInsuranceToolResponse,
  canonicalInsurancePlan,
  matchInsurancePlanForOffice,
} from "../insurance-rules.js";
import {
  activeOfficeKey,
  setLastInsuranceEligibilityCheck,
} from "../state/call-state.js";
import { getState } from "./session.js";

export const check_insurance = llm.tool({
  description:
    "Check whether the active office accepts the caller's insurance. " +
    "Call this before adding a new patient, after you know the plan name and whether the visit is medical or glasses/contacts routine vision. " +
    "Also call for quick insurance acceptance questions. ",
  parameters: z.object({
    plan: z
      .string()
      .trim()
      .min(1)
      .describe("Plan name exactly as the caller says it or the card shows it"),
    coverageType: z
      .enum(["medical", "routine_vision"])
      .describe(
        "medical for symptom-driven eye care, ophthalmology visits, or any eye problem; routine_vision only for glasses, contacts, prescription updates, contact lens fittings, or routine eye exams with no active eye problem.",
      ),
  }),
  execute: async ({ plan, coverageType }, { ctx }) => {
    const state = getState(ctx);
    const office = activeOfficeKey(state);
    const result = matchInsurancePlanForOffice(office, plan, coverageType);
    const response = buildInsuranceToolResponse(result);
    const checkedInsurancePlan = canonicalInsurancePlan(result);
    const checkedInsuranceCoverageType = checkedInsurancePlan
      ? coverageType
      : null;

    setLastInsuranceEligibilityCheck(state, {
      plan,
      canonicalPlan: checkedInsurancePlan,
      coverageType: checkedInsuranceCoverageType ?? coverageType,
      currentCarrier: result.callerFacingPlan ?? checkedInsurancePlan,
      accepted: Boolean(checkedInsurancePlan && result.status === "accepted"),
    });

    if (office === "crystal-river" && result.status === "not_accepted") {
      const springHillResult = matchInsurancePlanForOffice(
        "spring-hill",
        plan,
        coverageType,
      );
      const springHillPlan = canonicalInsurancePlan(springHillResult);
      if (springHillResult.status === "accepted" && springHillPlan) {
        const springHillCallerPlan =
          springHillResult.callerFacingPlan ?? springHillPlan;
        return {
          ...response,
          acceptedAtAlternateOffice: "Spring Hill",
          alternatePlan: springHillCallerPlan,
          routeTool: "route_to_spring_hill",
        };
      }
    }
    return response;
  },
});
