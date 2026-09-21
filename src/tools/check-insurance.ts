import type { OfficeKey } from "../customers/abita/profile.js";
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
    if (office === "rheumatology-demo") {
      return checkedInsurancePlan && result.status === "accepted"
        ? "Registration can continue with the supplied plan on this line. This sandbox registration check is not evidence of Isla participation, benefits, eligibility, or cost. Continue the confirmed registration without claiming insurance coverage."
        : "Registration is not supported with the supplied plan on this line. This is not an Isla coverage or participation decision. Ask for the exact plan name if unclear, or use another actual plan or self-pay only if the caller supplies or chooses it. Never invent coverage to continue.";
    }
    return buildInsuranceToolResponse(result);
  },
});

export function createCheckInsuranceTool(
  middleware: OwnedMiddleware,
  officeKey?: OfficeKey,
) {
  return tool({
    ...check_insurance,
    description:
      officeKey === "rheumatology-demo"
        ? "Check the caller-supplied plan for sandbox registration after medical visit triage. Use before add_patient; this is not evidence of Isla participation, benefits, eligibility, or cost. Use office knowledge for insurance FAQs. Never invent a plan or change to self-pay without the caller choosing it."
        : check_insurance.description,
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
        accepted: decision!.participation === "accepted",
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
