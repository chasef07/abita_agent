import { tool } from "@livekit/agents";
import { z } from "zod";
import type { OwnedMiddleware } from "../clients/owned-middleware.js";
import {
  buildInsuranceToolResponse,
  canonicalInsurancePlan,
  matchInsurancePlanForOffice,
} from "../insurance-rules.js";
import { activeOfficeKey } from "../state/call-lifecycle.js";
import { recordUnregisteredPatientInsuranceCheck } from "../state/call-state.js";
import { getAmdOfficeForToolCall } from "../scheduling/routing.js";
import { setLastInsuranceEligibilityCheck } from "../scheduling/state.js";
import { getState } from "./session.js";

type InsuranceChecker = Pick<OwnedMiddleware, "checkInsurance">;

export function createCheckInsuranceTool(middleware: InsuranceChecker) {
  return tool({
    name: "check_insurance",
    description:
      "Check whether the active office accepts a plan after the caller provides the plan name and visit type. " +
      "Use before new-patient creation and for participation questions. " +
      "A result requiring staff follow-up needs caller permission, then a normal referrals task; transfer only if task creation is unavailable, fails, or the caller declines.",
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
      let result;
      if (office.endsWith("-demo")) {
        result = matchInsurancePlanForOffice(office, plan, coverageType);
      } else {
        const middlewareResult = await middleware.checkInsurance({
          office: getAmdOfficeForToolCall(state),
          plan,
          coverageType,
        });
        result =
          middlewareResult.status === "error" || middlewareResult.authoritative
            ? middlewareResult
            : matchInsurancePlanForOffice(office, plan, coverageType);
      }
      if (result.status === "error") {
        setLastInsuranceEligibilityCheck(state, {
          plan,
          canonicalPlan: null,
          coverageType,
          currentCarrier: null,
          accepted: false,
        });
        recordUnregisteredPatientInsuranceCheck(state);
        return "I couldn't verify this insurance plan right now. I can try once more or connect you with the office.";
      }

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
}
