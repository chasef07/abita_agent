import { tool } from "@livekit/agents";
import { z } from "zod";
import type {
  OwnedMiddleware,
  UpdateInsuranceInput,
} from "../clients/owned-middleware.js";
import { normalizeInsuranceText } from "../insurance-rules.js";
import {
  activePatientDob,
  activePatientId,
  patientBackendRefs,
  setActivePatientBackendRefs,
} from "../state/call-state.js";
import {
  domainOutcomesForTool,
  recordOwnedMiddlewareFailure,
} from "../state/observability.js";
import {
  clearAvailabilitySelection,
  insuranceOnFile,
  insuranceSnapshot,
  setInsuranceOnFile,
  setLastInsuranceEligibilityCheck,
  setRoutingContext,
} from "../scheduling/state.js";
import { getAmdOfficeForToolCall } from "../scheduling/routing.js";
import { getState } from "./session.js";
import { throwOwnedMiddlewareFailure } from "../runtime/middleware-tool-failure.js";

export function createUpdateInsuranceTool(middleware: OwnedMiddleware) {
  return tool({
    name: "update_insurance",
    description:
      "Update insurance for a verified existing patient. " +
      "Use when the verified patient explicitly says they want to update the insurance on file. " +
      "Use add_patient for new-patient registration flows. " +
      "Call this only after check_insurance accepts the new plan for the correct medical or routine-vision coverage type.",
    parameters: z
      .object({
        insuranceMemberId: z
          .string()
          .trim()
          .min(1)
          .describe(
            'Member ID from the insurance card. Use "self pay" only when check_insurance accepted Self Pay.',
          ),
      })
      .strict(),
    execute: async ({ insuranceMemberId }, { ctx, toolCallId }) => {
      const state = getState(ctx);
      ctx.disallowInterruptions();
      const outcomes = domainOutcomesForTool(
        state,
        toolCallId,
        "update_insurance",
      );
      const blocked = (reply: string) =>
        outcomes.reply(
          { outcome: "insurance_update_blocked", status: "blocked" },
          reply,
        );
      const patientId = activePatientId(state);
      if (!patientId) {
        return blocked("Verify the patient before updating insurance.");
      }

      const checkedInsurance = state.insurance.lastEligibilityCheck;
      if (!checkedInsurance?.accepted) {
        return blocked(
          "Run check_insurance for accepted coverage before updating insurance.",
        );
      }
      const insurance =
        checkedInsurance.canonicalPlan?.trim() ||
        checkedInsurance.currentCarrier?.trim() ||
        checkedInsurance.plan?.trim();
      const canonicalInsurance = checkedInsurance.canonicalPlan?.trim() || null;
      const coverageType = checkedInsurance.coverageType;
      if (!insurance || !coverageType) {
        return blocked(
          "Run check_insurance for accepted coverage before updating insurance.",
        );
      }

      const selfPay =
        normalizeInsuranceText(insurance) === "self pay" ||
        normalizeInsuranceText(canonicalInsurance ?? "") === "self pay";
      const memberId = selfPay ? "self pay" : insuranceMemberId.trim();
      if (!memberId) {
        return blocked("Collect the member ID before updating insurance.");
      }

      const backendRefs = patientBackendRefs(state);
      const currentInsurance = insuranceOnFile(state);
      const dob = activePatientDob(state);
      const oldInsurance =
        currentInsurance?.currentCarrier ??
        currentInsurance?.canonicalPlan ??
        currentInsurance?.plan ??
        "";
      const payload: UpdateInsuranceInput = {
        patientId,
        ...(dob ? { dob } : {}),
        insPlanId: backendRefs.insPlanId ?? "",
        respPartyId: backendRefs.respPartyId ?? "",
        oldInsurance,
        insurance,
        coverageType,
        subscriberNum: memberId,
      };
      const result = await middleware.updateInsurance({
        office: getAmdOfficeForToolCall(state),
        update: payload,
      });

      if (result.status !== "updated") {
        recordOwnedMiddlewareFailure(state, "updateInsurance", result);
        outcomes.record({
          outcome: "insurance_update_failed",
          status: "failed",
        });
        throwOwnedMiddlewareFailure(
          result,
          "I couldn't update the insurance. I can try once more or connect you with the office.",
        );
      }

      const newInsurance = result.newInsurance?.trim() || insurance;
      setActivePatientBackendRefs(state, {
        insPlanId: null,
        respPartyId: backendRefs.respPartyId ?? null,
      });
      setInsuranceOnFile(
        state,
        insuranceSnapshot({
          plan: newInsurance,
          coverageType,
          canonicalPlan: canonicalInsurance ?? newInsurance,
          currentCarrier: newInsurance,
        }),
      );
      setLastInsuranceEligibilityCheck(state, null);
      setRoutingContext(state, {
        routing: result.routing,
        allowedProviders: result.allowedProviders,
        routingAmbiguous: result.routingAmbiguous,
        preauthRequired: result.preauthRequired,
      });
      clearAvailabilitySelection(state);

      outcomes.record({ outcome: "insurance_updated", status: "success" });

      return `Updated insurance to ${newInsurance}.`;
    },
  });
}
