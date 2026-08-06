import { ToolError, tool } from "@livekit/agents";
import { z } from "zod";
import {
  ownedMiddleware,
  type UpdateInsuranceInput,
} from "../clients/owned-middleware.js";
import { normalizeInsuranceText } from "../insurance-rules.js";
import {
  activePatientDob,
  activePatientId,
  patientBackendRefs,
  setPatientBackendRefs,
} from "../state/call-state.js";
import { recordOwnedMiddlewareFailure } from "../state/observability.js";
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

export const update_insurance = tool({
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
  execute: async ({ insuranceMemberId }, { ctx }) => {
    const state = getState(ctx);
    ctx.disallowInterruptions();

    const patientId = activePatientId(state);
    if (!patientId) {
      return "Verify the patient before updating insurance.";
    }

    const checkedInsurance = state.insurance.lastEligibilityCheck;
    if (!checkedInsurance?.accepted) {
      return "Run check_insurance for accepted coverage before updating insurance.";
    }
    const insurance =
      checkedInsurance.canonicalPlan?.trim() ||
      checkedInsurance.currentCarrier?.trim() ||
      checkedInsurance.plan?.trim();
    const canonicalInsurance = checkedInsurance.canonicalPlan?.trim() || null;
    const coverageType = checkedInsurance.coverageType;
    if (!insurance || !coverageType) {
      return "Run check_insurance for accepted coverage before updating insurance.";
    }

    const selfPay =
      normalizeInsuranceText(insurance) === "self pay" ||
      normalizeInsuranceText(canonicalInsurance ?? "") === "self pay";
    const memberId = selfPay ? "self pay" : insuranceMemberId.trim();
    if (!memberId) {
      return "Collect the member ID before updating insurance.";
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
    const result = await ownedMiddleware().updateInsurance({
      office: getAmdOfficeForToolCall(state),
      update: payload,
    });

    if (result.status !== "updated") {
      recordOwnedMiddlewareFailure(state, "updateInsurance", result);
      throw new ToolError(
        "I couldn't update the insurance. I can try once more or connect you with the office.",
      );
    }

    const newInsurance = result.newInsurance?.trim() || insurance;
    setPatientBackendRefs(state, {
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

    return `Updated insurance to ${newInsurance}.`;
  },
});
