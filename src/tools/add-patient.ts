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
import { getState } from "./session.js";

export const add_patient = llm.tool({
  description:
    "Creates a chart for a new patient. " +
    "Call this when the user has not registered in the system before. " +
    "Don't call it until triaging medical vs vision and checking insurance eligibility with check_insurance. " +
    "Before calling, read back the important registration details and get caller confirmation. " +
    "If the caller confirms the inbound caller number is the best callback number, omit phone and move on; do not ask them to repeat that number. ",
  parameters: z.object({
    firstName: z.string().describe("Patient's first name"),
    lastName: z.string().describe("Patient's last name"),
    dob: z.string().describe("Date of birth in MM/DD/YYYY format"),
    phone: z
      .string()
      .optional()
      .describe(
        "Best callback number, 10 digits only. Omit when the inbound caller number is confirmed as best; the tool will use the caller phone from state.",
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
    readBack: z
      .boolean()
      .optional()
      .describe(
        "Set to true only after reading back the patient's name, date of birth, sex, address, callback phone or inbound caller number, email if provided, insurance, policyholder name, and member ID, and the caller confirms they are correct.",
      ),
  }),
  execute: async (params, { ctx }) => {
    const state = getState(ctx);

    const checkedInsurance = activeInsuranceContext(state);
    const insurance = checkedInsurance.canonicalPlan ?? params.insurance;
    const selfPay = normalizeInsuranceText(insurance) === "self pay";
    const phone = params.phone?.trim() || runtimeCallerPhone(state).trim();

    if (!params.readBack) {
      return (
        "Read back the new patient details first: patient name, date of birth, sex, address, " +
        "callback phone, email if provided, insurance plan, policyholder name, and member ID. " +
        "Call add_patient again only after the caller confirms the details are correct."
      );
    }

    if (!phone) {
      throw new llm.ToolError(
        "A callback phone number is required before creating a chart. Ask whether the inbound number is best, or collect a callback number.",
      );
    }

    ctx.speechHandle.allowInterruptions = false;
    ensureRoutineVisionOffice(state);
    const payload = {
      firstName: params.firstName,
      lastName: params.lastName,
      dob: params.dob,
      street: params.street,
      aptSuite: params.aptSuite,
      city: params.city,
      state: params.state,
      zip: params.zip,
      sex: params.sex,
      insurance,
      phone,
      subscriberName: selfPay
        ? params.subscriberName || `${params.firstName} ${params.lastName}`
        : params.subscriberName,
      subscriberNum: selfPay ? "self pay" : params.subscriberNum,
      ...(checkedInsurance.coverageType === "routine_vision"
        ? { coverageType: "routine_vision" }
        : {}),
      ...(params.email?.trim() ? { email: params.email.trim() } : {}),
    };

    const result = (await callApi(
      "/api/add-patient",
      payload,
      getAmdOfficeForToolCall(state),
    )) as AddPatientResult;
    if (!result.patientId) {
      return (
        result.message ??
        "The patient chart was not created. Confirm the registration details and try again."
      );
    }

    applyPatientResult(state, result);
    const patientName =
      result.name?.trim() || `${params.firstName} ${params.lastName}`;
    return `Created a patient chart for ${patientName}. Continue with scheduling.`;
  },
});

type AddPatientResult = {
  patientId?: string | null;
  name?: string | null;
  message?: string | null;
  status?: string | null;
  phone?: string | null;
  insuranceCarrier?: string | null;
  insPlanId?: string | null;
  respPartyId?: string | null;
  routing?: string | null;
  allowedProviders?: string[];
  routingAmbiguous?: boolean;
  preauthRequired?: boolean;
};
