import { llm } from "@livekit/agents";
import { z } from "zod";
import { callApi } from "../clients/advancedmd-client.js";
import { normalizeInsuranceText } from "../insurance-rules.js";
import {
  activeInsuranceContext,
  runtimeCallerPhone,
} from "../state/call-state.js";
import { applyPatientResult } from "./patient-state.js";
import {
  ensureRoutineVisionOffice,
  getAmdOfficeForToolCall,
} from "./scheduling.js";
import { disableInterruptionsForWrite, getState } from "./session.js";

export const add_patient = llm.tool({
  description:
    "Create a new patient after no-match verification or caller-confirmed registration. " +
    "Call only after collecting real caller-provided registration facts and checking insurance. " +
    'Use the latest check_insurance canonicalPlan; for self-pay use subscriberNum "self pay". ' +
    "Omit phone only when the caller confirms the inbound number is best. " +
    "Returns the created patient, routing, preauth, and scheduling context. " +
    "Do not infer age from Bach-only routing.",
  parameters: z.object({
    firstName: z.string().describe("Patient's first name"),
    lastName: z.string().describe("Patient's last name"),
    dob: z.string().describe("Date of birth in MM/DD/YYYY format"),
    phone: z
      .string()
      .optional()
      .describe(
        "Best callback number, 10 digits only. Omit when the inbound caller number is confirmed as best.",
      ),
    email: z
      .string()
      .optional()
      .describe("Email address, if the caller provides one"),
    street: z.string().describe("Street address"),
    aptSuite: z
      .string()
      .default("")
      .describe("Apartment or suite number, or empty string if none"),
    city: z.string().describe("City"),
    state: z.string().describe("State, 2-letter abbreviation"),
    zip: z.string().describe("Zip code"),
    sex: z.enum(["male", "female"]).describe("Patient's sex"),
    insurance: z
      .string()
      .describe("Canonical insurance plan from check_insurance"),
    subscriberName: z
      .string()
      .describe("Name on the insurance policy; for self-pay, use patient name"),
    subscriberNum: z
      .string()
      .describe('Member ID; for self-pay, use "self pay"'),
  }),
  execute: async (params, { ctx }) => {
    const state = getState(ctx);
    const speechReady = disableInterruptionsForWrite(ctx);
    if (!speechReady) {
      return {
        outcome: "not_allowed",
        speak:
          "Registration was interrupted before it could be submitted. Please confirm the patient details again.",
        facts: { reason: "speech_interrupted" },
        retryable: true,
      };
    }
    const checkedInsurance = activeInsuranceContext(state);
    const insurance = checkedInsurance.canonicalPlan ?? params.insurance;
    const selfPay = normalizeInsuranceText(insurance) === "self pay";
    const phone = params.phone ?? runtimeCallerPhone(state);
    if (!phone) {
      return {
        outcome: "needs_clarification",
        speak:
          "Ask whether the number they're calling from is good; if not, collect the best phone number.",
        facts: { reason: "registration_requires_phone" },
        retryable: true,
      };
    }
    ensureRoutineVisionOffice(state);
    const payload: Record<string, unknown> = { ...params, insurance, phone };
    if (selfPay) {
      payload.subscriberNum = "self pay";
      payload.subscriberName =
        params.subscriberName || `${params.firstName} ${params.lastName}`;
    }
    if (checkedInsurance.coverageType === "routine_vision") {
      payload.coverageType = "routine_vision";
    }
    if (typeof params.email === "string" && params.email.trim()) {
      payload.email = params.email.trim();
    } else {
      delete payload.email;
    }
    const result = (await callApi(
      "/api/add-patient",
      payload,
      getAmdOfficeForToolCall(state),
    )) as any;
    if (result?.patientId) {
      applyPatientResult(state, result);
      return result;
    }
    return result;
  },
});
