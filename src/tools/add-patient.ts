import { ToolError, tool } from "@livekit/agents";
import { z } from "zod";
import {
  ownedMiddleware,
  type CreatePatientInput,
} from "../clients/owned-middleware.js";
import {
  canonicalInsurancePlan,
  matchInsurancePlanForOffice,
  normalizeInsuranceText,
  type InsuranceCoverageType,
} from "../insurance-rules.js";
import { dobMatches, namesMatch } from "../identity/name-matcher.js";
import {
  type CallState,
  type InsuranceEligibilityCheck,
} from "../state/call-state.js";
import { runtimeCallerPhone } from "../state/call-lifecycle.js";
import {
  applySchedulingLaneToState,
  insuranceSnapshot,
  lastInsuranceEligibilityCheck,
  setInsuranceOnFile,
  setLastInsuranceEligibilityCheck,
} from "../state/scheduling.js";
import { applyPatientResult } from "./patient-state.js";
import {
  getAmdOfficeForToolCall,
  medicalSchedulingUnavailable,
  routineVisionSchedulingUnavailable,
} from "./scheduling.js";
import { getState } from "./session.js";

const addPatientParameters = z
  .object({
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
    appointmentLane: z
      .enum(["medical_md", "routine_od"])
      .describe(
        "Required scheduling lane. Use medical_md for symptom-driven eye care or any eye problem; use routine_od only for glasses, contacts, prescription updates, contact lens fittings, or routine eye exams with no active eye problem.",
      ),
    subscriberName: z.string().describe("Name on the insurance policy"),
    insuranceMemberId: z
      .string()
      .trim()
      .min(1)
      .describe("Member ID from the insurance card."),
    ssnLast4: z
      .string()
      .trim()
      .regex(/^\d{4}$/)
      .optional()
      .describe(
        "Last 4 digits of the patient's Social Security number. Collect when appointmentLane is routine_od; do not ask for the full SSN.",
      ),
    readBack: z
      .boolean()
      .optional()
      .describe(
        "Set to true only after reading back the patient's name, date of birth, sex, address, callback phone or inbound caller number, email if provided, insurance, policyholder name, member ID, and patient SSN last 4 for routine_od, and the caller confirms they are correct.",
      ),
  })
  .strict();

export const add_patient = tool({
  name: "add_patient",
  description:
    "Creates a chart for a new patient. " +
    "Call this only after resolve_patient has confirmed the caller says the patient is not registered with us. " +
    "Don't call it until triaging medical vs vision and checking insurance eligibility with check_insurance. Pass appointmentLane as medical_md for symptom-driven eye care or any eye problem, or routine_od only for glasses, contacts, prescription updates, contact lens fittings, or routine eye exams with no active eye problem. " +
    "Before calling, read back the important registration details and get caller confirmation. " +
    "When appointmentLane is routine_od, collect ssnLast4 because plans like VSP use the last 4 digits of the patient's Social Security number as the patient's policy number. If the patient asks why, explain that vision insurance plans need it to verify coverage. Do not ask for the full SSN. " +
    "Before using the inbound caller number for the chart, ask whether the number they are calling from is a good callback number to put on file. " +
    'Never offer self pay. If the patient asks to self pay, put "self pay" in insuranceMemberId. ' +
    "If they say yes, omit phone and set inboundPhoneConfirmed to true; do not ask them to repeat that number. ",
  parameters: addPatientParameters,
  execute: async (params, { ctx }) => {
    const state = getState(ctx);
    ctx.disallowInterruptions();

    if (state.identity.patient.status === "created") {
      const patientName =
        state.identity.patient.name?.trim() ||
        `${params.firstName} ${params.lastName}`;
      return `Patient chart is already created for ${patientName}. Continue with scheduling.`;
    }

    if (state.identity.patient.status !== "new") {
      return "Before creating a new chart, ask whether the patient is already registered with us and call resolve_patient with registrationStatus not_registered after the caller confirms they are not registered.";
    }

    if (
      params.appointmentLane !== "medical_md" &&
      params.appointmentLane !== "routine_od"
    ) {
      throw new ToolError(
        "Pass appointmentLane medical_md or routine_od before creating a patient.",
      );
    }
    applySchedulingLaneToState(state, params.appointmentLane);
    const unsupportedMedicalScheduling = medicalSchedulingUnavailable(state);
    if (unsupportedMedicalScheduling) return unsupportedMedicalScheduling;
    const unsupportedRoutineVisionScheduling =
      routineVisionSchedulingUnavailable(state);
    if (unsupportedRoutineVisionScheduling)
      return unsupportedRoutineVisionScheduling;

    const laneCoverageType = coverageTypeForAppointmentLane(
      params.appointmentLane,
    );
    const checkedInsurance = acceptedInsuranceForAddPatient(
      state,
      params.insurance,
      laneCoverageType,
    );
    if (!checkedInsurance) {
      return "Check whether we accept the patient's insurance for this visit type before creating a patient chart.";
    }
    const insurance = checkedInsurance.canonicalPlan ?? params.insurance;
    if (checkedInsurance.coverageType !== laneCoverageType) {
      throw new ToolError(
        "Use appointmentLane medical_md with medical coverage, or routine_od with routine_vision coverage. Run check_insurance again for the correct coverage before creating a patient.",
      );
    }
    const selfPay = normalizeInsuranceText(insurance) === "self pay";
    const memberId = selfPay ? "self pay" : params.insuranceMemberId;
    const explicitPhone = params.phone?.trim() ?? "";
    const phone =
      explicitPhone ||
      (params.inboundPhoneConfirmed ? runtimeCallerPhone(state).trim() : "");

    if (hasMatchingPreCallPatient(state, params)) {
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
        "callback phone, email if provided, insurance plan, policyholder name, member ID, and patient SSN last 4 for routine_od. " +
        "Call add_patient again only after the caller confirms the details are correct."
      );
    }

    if (!phone) {
      throw new ToolError(
        "A callback phone number is required before creating a chart. Ask whether the inbound number is best, or collect a callback number.",
      );
    }

    const payload: CreatePatientInput = {
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
      subscriberNum: memberId,
      ...(checkedInsurance.coverageType === "routine_vision"
        ? {
            coverageType: "routine_vision",
            ...(params.ssnLast4 ? { ssn: params.ssnLast4 } : {}),
          }
        : {}),
      ...(params.email?.trim() ? { email: params.email.trim() } : {}),
    };

    const result = await ownedMiddleware().createPatient({
      office: getAmdOfficeForToolCall(state),
      patient: payload,
    });
    if (result.status === "error") return "The patient chart was not created.";

    applyPatientResult(state, result);
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

function coverageTypeForAppointmentLane(
  appointmentLane: "medical_md" | "routine_od",
): InsuranceCoverageType {
  return appointmentLane === "routine_od" ? "routine_vision" : "medical";
}

function acceptedInsuranceForAddPatient(
  state: CallState,
  insurance: string,
  coverageType: InsuranceCoverageType,
): InsuranceEligibilityCheck | null {
  const checkedInsurance = lastInsuranceEligibilityCheck(state);
  if (
    checkedInsurance?.accepted &&
    checkedInsurance.canonicalPlan &&
    insuranceMatchesCheck(insurance, checkedInsurance)
  ) {
    return checkedInsurance;
  }

  const result = matchInsurancePlanForOffice(
    state.office.activeKey,
    insurance,
    coverageType,
  );
  const canonicalPlan = canonicalInsurancePlan(result);
  if (!canonicalPlan || result.status !== "accepted") return null;

  const resolved: InsuranceEligibilityCheck = {
    plan: insurance,
    canonicalPlan,
    coverageType,
    currentCarrier: result.callerFacingPlan ?? canonicalPlan,
    accepted: true,
  };
  setLastInsuranceEligibilityCheck(state, resolved);
  return resolved;
}

function insuranceMatchesCheck(
  insurance: string,
  checkedInsurance: InsuranceEligibilityCheck,
): boolean {
  const requested = normalizeInsuranceText(insurance);
  if (!requested) return false;
  return [
    checkedInsurance.plan,
    checkedInsurance.canonicalPlan,
    checkedInsurance.currentCarrier,
  ].some((value) => normalizeInsuranceText(value ?? "") === requested);
}

function hasMatchingPreCallPatient(
  state: CallState,
  params: {
    lastName: string;
    dob: string;
  },
): boolean {
  const preCall = state.identity.preCall;
  if (!preCall) return false;

  return preCall.candidates.some(
    (candidate) =>
      Boolean(candidate.patientId) &&
      namesMatch(params.lastName, candidate.lastName) &&
      dobMatches(params.dob, candidate.dob),
  );
}
