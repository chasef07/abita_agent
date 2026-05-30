import { llm } from "@livekit/agents";
import { z } from "zod";
import { callApi } from "../clients/advancedmd-client.js";
import { normalizeInsuranceText } from "../insurance-rules.js";
import {
  activeInsuranceContext,
  activePatientDob,
  activePatientId,
  clearAvailabilitySelection,
  normalizeSchedulingRouting,
  patientBackendRefs,
  setPatientBackendRefs,
} from "../state/call-state.js";
import { getAmdOfficeForToolCall } from "./scheduling.js";
import { disableInterruptionsForWrite, getState } from "./session.js";

export const update_insurance = llm.tool({
  description:
    "Update insurance for a verified patient. " +
    "Call verify_patient first, then check_insurance for medical coverage. " +
    'Use the latest canonicalPlan; for self-pay use subscriberNum "self pay". ' +
    "Do not use this just to schedule routine vision for an existing patient. " +
    "Returns updated insurance, routing, and preauth context.",
  parameters: z.object({
    insurance: z
      .string()
      .describe("Canonical insurance plan from check_insurance"),
    subscriberName: z
      .string()
      .describe("Name on the insurance card; for self-pay, use patient name"),
    subscriberNum: z
      .string()
      .describe('Member ID; for self-pay, use "self pay"'),
  }),
  execute: async ({ insurance, subscriberName, subscriberNum }, { ctx }) => {
    const state = getState(ctx);
    const speechReady = disableInterruptionsForWrite(ctx);
    if (!speechReady) {
      return {
        outcome: "not_allowed",
        speak:
          "Insurance update was interrupted before it could be submitted. Please confirm the insurance details again.",
        facts: { reason: "speech_interrupted" },
        retryable: true,
      };
    }
    const patientId = activePatientId(state);
    if (!patientId) {
      return {
        outcome: "not_allowed",
        speak: "Verify the patient before updating insurance.",
        facts: { reason: "update_insurance_requires_verified_patient" },
        retryable: true,
      };
    }
    const currentInsurance = activeInsuranceContext(state);
    const backendRefs = patientBackendRefs(state);
    const insuranceForMiddleware =
      currentInsurance.coverageType === "medical"
        ? (currentInsurance.canonicalPlan ?? insurance)
        : insurance;
    const subscriberNumForMiddleware =
      normalizeInsuranceText(insuranceForMiddleware) === "self pay"
        ? "self pay"
        : subscriberNum;
    const payload: Record<string, unknown> = {
      patientId,
      ...(activePatientDob(state) ? { dob: activePatientDob(state) } : {}),
      insPlanId: backendRefs.insPlanId ?? "",
      respPartyId: backendRefs.respPartyId ?? "",
      oldInsurance:
        currentInsurance.currentCarrier ?? currentInsurance.plan ?? "",
      insurance: insuranceForMiddleware,
      subscriberName,
      subscriberNum: subscriberNumForMiddleware,
    };
    const result = (await callApi(
      "/api/patient/update-insurance",
      payload,
      getAmdOfficeForToolCall(state),
    )) as any;
    if (result?.status === "updated") {
      setPatientBackendRefs(state, {
        insPlanId: result.insPlanId ?? null,
        respPartyId: result.respPartyId ?? null,
      });
      const newInsurance =
        result.newInsurance ?? currentInsurance.canonicalPlan ?? insurance;
      state.patient.insurance = {
        plan: newInsurance,
        coverageType: currentInsurance.coverageType,
        canonicalPlan: newInsurance,
        currentCarrier: newInsurance,
      };
      state.checkedInsurance = state.patient.insurance;
      state.scheduling.routing = normalizeSchedulingRouting(result.routing);
      state.scheduling.allowedProviders = result.allowedProviders ?? [];
      state.scheduling.routingAmbiguous = result.routingAmbiguous ?? false;
      state.scheduling.preauthRequired = result.preauthRequired ?? false;
      clearAvailabilitySelection(state);
      return result;
    }
    return result;
  },
});
