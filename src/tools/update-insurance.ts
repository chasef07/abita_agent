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
      "Update coverage for the active verified patient only after the caller requests the change and check_insurance accepts the new plan for the correct visit type. " +
      "Use add_patient for new registrations. " +
      "Claim success only from this tool's updated receipt; on failure, follow the returned single-retry or transfer instruction.",
    parameters: z
      .object({
        insuranceMemberId: z
          .string()
          .trim()
          .min(1)
          .describe(
            'Card member ID; use "self pay" only after Self Pay is accepted.',
          ),
      })
      .strict(),
    execute: async (
      { insuranceMemberId },
      { ctx, toolCallId },
    ): Promise<string> => {
      const state = getState(ctx);
      ctx.disallowInterruptions();
      const outcomes = domainOutcomesForTool(
        state,
        toolCallId,
        "update_insurance",
      );
      const patientId = activePatientId(state);
      if (!patientId) {
        return "I need to verify the patient before updating insurance.";
      }

      const checkedInsurance = state.insurance.lastEligibilityCheck;
      if (!checkedInsurance?.accepted) {
        return "I need to confirm that we accept the new coverage before updating it.";
      }
      const insurance =
        checkedInsurance.canonicalPlan?.trim() ||
        checkedInsurance.currentCarrier?.trim() ||
        checkedInsurance.plan?.trim();
      const canonicalInsurance = checkedInsurance.canonicalPlan?.trim() || null;
      const coverageType = checkedInsurance.coverageType;
      if (!insurance || !coverageType) {
        return "I need to confirm that we accept the new coverage before updating it.";
      }

      const selfPay =
        normalizeInsuranceText(insurance) === "self pay" ||
        normalizeInsuranceText(canonicalInsurance ?? "") === "self pay";
      const memberId = selfPay ? "self pay" : insuranceMemberId.trim();
      if (!memberId) {
        return "What is the member ID on the insurance card?";
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
