import { tool } from "@livekit/agents";
import { z } from "zod";
import {
  buildInsuranceToolResponse,
  canonicalInsurancePlan,
  matchInsurancePlanForOffice,
} from "../insurance-rules.js";
import { activeOfficeKey } from "../state/call-lifecycle.js";
import { recordUnregisteredPatientInsuranceCheck } from "../state/call-state.js";
import { setLastInsuranceEligibilityCheck } from "../scheduling/state.js";
import { getState } from "./session.js";

export const check_insurance = tool({
  name: "check_insurance",
  description:
    "Check whether the active office accepts a plan after the caller provides the plan name and visit type. " +
    "Use before new-patient creation and for participation questions. " +
    "A prior-authorization result requires caller permission, then a normal referrals task; transfer only if task creation is unavailable, fails, or the caller declines. " +
    "For a transfer-required result, call transfer_call immediately; it speaks the announcement.",
  parameters: z.object({
    plan: z
      .string()
      .trim()
      .min(1)
      .describe("Plan name as the caller says it or the card shows it."),
    coverageType: z
      .enum(["medical", "routine_vision"])
      .describe("Triaged visit type: medical or routine_vision."),
  }),
  execute: async ({ plan, coverageType }, { ctx }): Promise<string> => {
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
    recordUnregisteredPatientInsuranceCheck(state);
    return response;
  },
});
