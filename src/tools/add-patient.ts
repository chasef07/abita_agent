import { llm } from "@livekit/agents";
import { z } from "zod";
import { callApi } from "../clients/advancedmd-client.js";
import { normalizeInsuranceText } from "../insurance-rules.js";
import {
  insuranceSnapshot,
  lastInsuranceEligibilityCheck,
  runtimeCallerPhone,
  setInsuranceOnFile,
  setLastInsuranceEligibilityCheck,
  type CallState,
} from "../state/call-state.js";
import { applyPatientResult } from "./patient-state.js";
import {
  ensureRoutineVisionOffice,
  getAmdOfficeForToolCall,
} from "./scheduling.js";
import { getState } from "./session.js";
import { ensureSchedulingTurnContext } from "./turn-context-guard.js";

export const add_patient = llm.tool({
  description:
    "Creates a chart for a new patient. " +
    "Call this when the user has not registered in the system before. " +
    "Don't call it until triaging medical vs vision and checking insurance eligibility with check_insurance. " +
    "Before calling, read back the important registration details and get caller confirmation. " +
    "Before using the inbound caller number for the chart, ask whether the number they are calling from is a good callback number to put on file. " +
    'Never offer self pay. If the patient asks to self pay, put "self pay" in subscriberNum. ' +
    "If they say yes, omit phone and set inboundPhoneConfirmed to true; do not ask them to repeat that number. ",
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
    inboundPhoneConfirmed: z
      .boolean()
      .optional()
      .describe(
        "Set to true only after asking whether the number they are calling from is a good callback number to put on file and the caller says yes.",
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
      .describe(
        "Insurance plan the caller gave after check_insurance accepts it",
      ),
    subscriberName: z.string().describe("Name on the insurance policy"),
    subscriberNum: z.string().describe("Member ID"),
    readBack: z
      .boolean()
      .optional()
      .describe(
        "Set to true only after reading back the patient's name, date of birth, sex, address, callback phone or inbound caller number, email if provided, insurance, policyholder name, and member ID, and the caller confirms they are correct.",
      ),
  }),
  execute: async (params, { ctx }) => {
    const state = getState(ctx);

    const checkedInsurance = lastInsuranceEligibilityCheck(state);
    if (
      !checkedInsurance?.accepted ||
      !checkedInsurance.canonicalPlan ||
      !checkedInsurance.coverageType
    ) {
      throw new llm.ToolError(
        "Run check_insurance for accepted coverage before creating a patient.",
      );
    }
    const insurance = checkedInsurance.canonicalPlan ?? params.insurance;
    const selfPay = normalizeInsuranceText(insurance) === "self pay";
    const explicitPhone = params.phone?.trim() ?? "";
    const phone =
      explicitPhone ||
      (params.inboundPhoneConfirmed ? runtimeCallerPhone(state).trim() : "");

    ensureSchedulingTurnContext(state, "creating a patient");

    if (hasMatchingPendingPreCallPatient(state, params)) {
      return "A patient record may already exist for that last name and date of birth from the caller phone lookup. Confirm the existing patient record before creating a new chart.";
    }

    if (!explicitPhone && !params.inboundPhoneConfirmed) {
      return (
        "Ask the caller: Is the number you are calling from a good callback number to put on file? " +
        "If yes, call add_patient again with inboundPhoneConfirmed set to true. " +
        "If not, collect the callback phone number and pass it as phone."
      );
    }

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

    applyPatientResult(state, { ...result, status: "created" });
    setInsuranceOnFile(
      state,
      insuranceSnapshot({
        plan: result.insuranceCarrier ?? checkedInsurance.currentCarrier,
        canonicalPlan: checkedInsurance.canonicalPlan,
        coverageType: checkedInsurance.coverageType,
        currentCarrier:
          result.insuranceCarrier ?? checkedInsurance.currentCarrier,
      }),
    );
    setLastInsuranceEligibilityCheck(state, null);
    const patientName =
      result.name?.trim() || `${params.firstName} ${params.lastName}`;
    return `Created a patient chart for ${patientName}. Continue with scheduling.`;
  },
});

function hasMatchingPendingPreCallPatient(
  state: CallState,
  params: {
    lastName: string;
    dob: string;
  },
): boolean {
  const preCall = state.identity.preCall;
  if (
    preCall?.status !== "single_match_pending_confirmation" &&
    preCall?.status !== "multiple_matches_pending_selection"
  ) {
    return false;
  }

  return preCall.candidates.some(
    (candidate) =>
      Boolean(candidate.patientId) &&
      namesMatch(params.lastName, candidate.lastName) &&
      dobMatches(params.dob, candidate.dob),
  );
}

function namesMatch(
  provided: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  const providedName = normalizeName(provided);
  const expectedName = normalizeName(expected);
  if (!providedName || !expectedName) return false;
  if (providedName === expectedName) return true;
  return (
    providedName.length >= 3 &&
    expectedName.length >= 3 &&
    (providedName.startsWith(expectedName) ||
      expectedName.startsWith(providedName))
  );
}

function normalizeName(value: string | null | undefined): string {
  return (
    value
      ?.trim()
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z]/g, "") ?? ""
  );
}

function dobMatches(
  provided: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  const providedDob = normalizeDob(provided);
  const expectedDob = normalizeDob(expected);
  return Boolean(providedDob && expectedDob && providedDob === expectedDob);
}

function normalizeDob(value: string | null | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) return "";

  const match = trimmed.match(/^(\d{1,2})\D+(\d{1,2})\D+(\d{2,4})$/);
  if (!match) return trimmed;

  const [, month, day, rawYear] = match;
  const year =
    rawYear.length === 2
      ? Number(rawYear) > 30
        ? `19${rawYear}`
        : `20${rawYear}`
      : rawYear;
  return `${month.padStart(2, "0")}/${day.padStart(2, "0")}/${year}`;
}

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
