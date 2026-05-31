import { llm } from "@livekit/agents";
import { z } from "zod";
import { callApi } from "../clients/advancedmd-client.js";
import { normalizeInsuranceText } from "../insurance-rules.js";
import {
  activePatientDob,
  activePatientId,
  clearAvailabilitySelection,
  normalizeSchedulingRouting,
  patientBackendRefs,
  setPatientBackendRefs,
} from "../state/call-state.js";
import { getAmdOfficeForToolCall } from "./scheduling.js";
import { getState } from "./session.js";

export const update_insurance = llm.tool({
  description:
    "Update insurance for a verified existing patient. " +
    "Call this only after confirm_patient_identity and after check_insurance accepts medical coverage for the new plan. ",
  parameters: z.object({
    subscriberNum: z
      .string()
      .trim()
      .optional()
      .describe("Member ID from the insurance card. Omit for self-pay."),
  }),
  execute: async ({ subscriberNum }, { ctx }) => {
    const state = getState(ctx);
    ctx.speechHandle.allowInterruptions = false;

    const patientId = activePatientId(state);
    if (!patientId) {
      throw new llm.ToolError("Verify the patient before updating insurance.");
    }

    const checkedInsurance = state.checkedInsurance;
    const insurance = checkedInsurance.canonicalPlan ?? checkedInsurance.plan;
    if (!insurance || checkedInsurance.coverageType !== "medical") {
      throw new llm.ToolError(
        "Run check_insurance for accepted medical coverage before updating insurance.",
      );
    }

    const selfPay = normalizeInsuranceText(insurance) === "self pay";
    const memberId = selfPay ? "self pay" : subscriberNum?.trim();
    if (!memberId) {
      throw new llm.ToolError(
        "Collect the member ID before updating insurance.",
      );
    }

    const backendRefs = patientBackendRefs(state);
    const oldInsurance =
      state.patient.insurance?.currentCarrier ??
      state.patient.insurance?.canonicalPlan ??
      state.patient.insurance?.plan ??
      "";
    const payload: Record<string, unknown> = {
      patientId,
      ...(activePatientDob(state) ? { dob: activePatientDob(state) } : {}),
      insPlanId: backendRefs.insPlanId ?? "",
      respPartyId: backendRefs.respPartyId ?? "",
      oldInsurance,
      insurance,
      coverageType: "medical",
      subscriberNum: memberId,
    };
    const result = (await callApi(
      "/api/patient/update-insurance",
      payload,
      getAmdOfficeForToolCall(state),
    )) as UpdateInsuranceResult;

    if (result?.status !== "updated") {
      return result?.message ?? "Insurance was not updated.";
    }

    const newInsurance = result.newInsurance?.trim() || insurance;
    setPatientBackendRefs(state, {
      insPlanId: null,
      respPartyId: backendRefs.respPartyId ?? null,
    });
    state.patient.insurance = {
      plan: newInsurance,
      coverageType: "medical",
      canonicalPlan: newInsurance,
      currentCarrier: newInsurance,
    };
    state.checkedInsurance = state.patient.insurance;
    state.scheduling.coverageType = "medical";
    state.scheduling.routing = normalizeSchedulingRouting(result.routing);
    state.scheduling.allowedProviders = result.allowedProviders ?? [];
    state.scheduling.routingAmbiguous = result.routingAmbiguous ?? false;
    state.scheduling.preauthRequired = result.preauthRequired ?? false;
    clearAvailabilitySelection(state);

    return `Updated insurance to ${newInsurance}.`;
  },
});

type UpdateInsuranceResult = {
  status?: string;
  message?: string;
  newInsurance?: string;
  routing?: string | null;
  allowedProviders?: string[];
  routingAmbiguous?: boolean;
  preauthRequired?: boolean;
};
