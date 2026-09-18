import {
  decisionMatches,
  registrationBlockedAnswer,
} from "../clients/insurance-decision.js";
import { activeOfficeKey } from "../state/call-lifecycle.js";
import { tool } from "@livekit/agents";
import { z } from "zod";
import type {
  OwnedMiddleware,
  UpdateInsuranceInput,
  UpdateInsuranceResult,
} from "../clients/owned-middleware.js";
import { normalizeInsuranceText } from "../insurance-rules.js";
import {
  activePatientDob,
  activePatientId,
  patientBackendRefs,
  setActivePatientBackendRefs,
} from "../state/call-state.js";
import { domainOutcomesForTool } from "../state/observability.js";
import {
  blockPatientWrites,
  insuranceOnFile,
  insuranceSnapshot,
  setInsuranceOnFile,
  setLastInsuranceEligibilityCheck,
  setRoutingContext,
} from "../scheduling/state.js";
import { clearAvailabilitySelection } from "../scheduling/availability.js";
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

      const blocked = state.identity.schedulingWriteBlocks?.[patientId];
      if (blocked) return blocked;
      if (state.identity.schedulingWritePending)
        return "A patient change is still in progress. Wait for its result before making another change.";
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

      if (
        coverageType === "medical" &&
        !activeOfficeKey(state).endsWith("-demo")
      ) {
        const decision = checkedInsurance.decision;
        if (
          !decision ||
          !decisionMatches(
            decision,
            activeOfficeKey(state),
            coverageType,
            insurance,
          )
        )
          return "Check insurance again for this office before updating it.";
        if (!decision.canRegister) return registrationBlockedAnswer(decision);
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
      clearAvailabilitySelection(state, { invalidateReads: true });
      const pending = { ...checkedInsurance, accepted: false };
      const office = activeOfficeKey(state);
      setLastInsuranceEligibilityCheck(state, pending);
      const revision = state.identity.transitionVersion;
      const uncertainMessage =
        "The insurance update could not be verified. Ask staff to check the chart before any further changes; do not repeat the update.";
      let result: UpdateInsuranceResult;
      state.identity.schedulingWritePending = true;
      try {
        result = await middleware.updateInsurance({
          office: getAmdOfficeForToolCall(state),
          update: payload,
        });
      } catch (error) {
        if (!checkedInsurance.decision) throw error;
        blockPatientWrites(state, patientId, uncertainMessage);
        return uncertainMessage;
      } finally {
        state.identity.schedulingWritePending = false;
      }
      if (result.status !== "updated") {
        if (checkedInsurance.decision && !result.noWrite) {
          blockPatientWrites(state, patientId, uncertainMessage);
          return uncertainMessage;
        }
        outcomes.record({
          outcome: "insurance_update_failed",
          status: "failed",
        });
        throwOwnedMiddlewareFailure(
          result,
          "I couldn't update the insurance. I can try once more or connect you with the office.",
        );
      }

      if (
        checkedInsurance.decision &&
        !decisionMatches(
          result.insuranceDecision,
          office,
          coverageType,
          insurance,
        )
      ) {
        blockPatientWrites(state, patientId, uncertainMessage);
        return uncertainMessage;
      }
      if (
        revision !== state.identity.transitionVersion ||
        activePatientId(state) !== patientId ||
        activeOfficeKey(state) !== office ||
        state.insurance.lastEligibilityCheck !== pending
      )
        return "The patient changed while insurance was updated. Verify the current patient before continuing.";
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
          canonicalPlan:
            result.insuranceDecision?.canonicalPlan ??
            canonicalInsurance ??
            newInsurance,
          decision: result.insuranceDecision,
          currentCarrier: newInsurance,
        }),
      );
      setLastInsuranceEligibilityCheck(state, null);
      setRoutingContext(state, {
        routing: result.routing,
        preauthRequired: result.preauthRequired,
      });
      clearAvailabilitySelection(state);

      outcomes.record({ outcome: "insurance_updated", status: "success" });

      return `Updated insurance to ${newInsurance}.`;
    },
  });
}
