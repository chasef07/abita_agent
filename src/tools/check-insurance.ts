import { tool } from "@livekit/agents";
import { z } from "zod";
import {
  buildInsuranceToolResponse,
  canonicalInsurancePlan,
  matchInsurancePlanForOffice,
} from "../insurance-rules.js";
import { activeOfficeKey } from "../state/call-lifecycle.js";
import { setLastInsuranceEligibilityCheck } from "../scheduling/state.js";
import { getState } from "./session.js";

export const check_insurance = tool({
  name: "check_insurance",
  description:
    "Check whether the active office accepts the caller's insurance. " +
    "Call this before adding a new patient, after you know the plan name and visit type. " +
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
        "Visit type established by appointment triage; pass medical or routine_vision.",
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
