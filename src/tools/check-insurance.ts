import { tool } from "@livekit/agents";
import { z } from "zod";
import {
  buildInsuranceToolResponse,
  canonicalInsurancePlan,
  matchInsurancePlanForOffice,
} from "../insurance-rules.js";
import { activeOfficeKey } from "../state/call-lifecycle.js";
import { setLastInsuranceEligibilityCheck } from "../state/scheduling.js";
import { getState } from "./session.js";

export const check_insurance = tool({
  name: "check_insurance",
  description:
    "Check whether the active office accepts the caller's insurance. " +
    "Call this before adding a new patient, after you know the plan name and whether the visit is medical or glasses/contacts routine vision. " +
    "Also call for quick insurance acceptance questions. " +
    "If the result says needs_clarification, ask the caller for the requested detail and do not call check_insurance again until the caller gives a more specific plan or coverage type. " +
    "If the result says needs_transfer, transfer the caller to staff before scheduling.",
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
    ctx.disallowInterruptions();
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
    return response;
  },
});
