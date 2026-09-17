import type { OwnedMiddleware } from "../clients/owned-middleware.js";
import { decisionMatches } from "../clients/insurance-decision.js";
import { activePatientDob } from "../state/call-state.js";
import { clearAvailabilitySelection } from "../scheduling/availability.js";
import { getAmdOfficeForToolCall } from "../scheduling/routing.js";
import { tool } from "@livekit/agents";
import { z } from "zod";
import {
  buildInsuranceToolResponse,
  canonicalInsurancePlan,
  matchInsurancePlanForOffice,
} from "../insurance-rules.js";
import { activeOfficeKey } from "../state/call-lifecycle.js";
import { recordUnregisteredPatientInsuranceCheck } from "../state/call-state.js";
import {
  setLastInsuranceEligibilityCheck,
  setRoutingContext,
} from "../scheduling/state.js";
import { getState } from "./session.js";

// Local catalog is retained for routine vision and the isolated demo.
export const check_insurance = tool({
  name: "check_insurance",
  description:
    "Check whether the active office accepts a plan after the caller provides the plan name and visit type. " +
    "Use before new-patient creation and for participation questions. " +
    "If staff follow-up is needed, get caller permission and create a normal staff task. Transfer only if task creation is unavailable, fails, or the caller declines.",
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

export function createCheckInsuranceTool(middleware: OwnedMiddleware) {
  return tool({
    ...check_insurance,
    execute: async (args, options): Promise<string> => {
      const state = getState(options.ctx);
      const office = activeOfficeKey(state);
      if (args.coverageType !== "medical" || office.endsWith("-demo"))
        return check_insurance.execute(args, options);
      options.ctx.disallowInterruptions();
      const revision = state.identity.transitionVersion;
      const pending = {
        plan: args.plan,
        canonicalPlan: null,
        coverageType: args.coverageType,
        currentCarrier: null,
        accepted: false,
      };
      setLastInsuranceEligibilityCheck(state, pending);
      clearAvailabilitySelection(state, { invalidateReads: true });
      const decision = await middleware.checkInsurance?.({
        office: getAmdOfficeForToolCall(state),
        plan: args.plan,
        coverageType: "medical",
        dob: activePatientDob(state) ?? undefined,
      });
      if (
        revision !== state.identity.transitionVersion ||
        office !== activeOfficeKey(state) ||
        state.insurance.lastEligibilityCheck !== pending
      )
        return "The patient or insurance changed. Check the current patient's insurance again.";
      if (!decisionMatches(decision, office, "medical"))
        return "Insurance could not be verified. Ask office staff for help; do not register or schedule using an earlier check.";
      setLastInsuranceEligibilityCheck(state, {
        plan: args.plan,
        canonicalPlan: decision!.canonicalPlan || null,
        coverageType: "medical",
        currentCarrier: decision!.canonicalPlan || null,
        accepted: decision!.canRegister,
        decision,
      });
      setRoutingContext(state, {
        routing: decision!.routing,
        preauthRequired: decision!.requirements.length > 0,
      });
      recordUnregisteredPatientInsuranceCheck(state);
      return decision!.answer;
    },
  });
}
