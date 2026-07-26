import { ToolError, tool } from "@livekit/agents";
import { z } from "zod";
import {
  ownedMiddleware,
  type CreatePatientInput,
} from "../clients/owned-middleware.js";
import { normalizeInsuranceText } from "../insurance-rules.js";
import {
  applyPatientResult,
  beginPatientIdentityOperation,
  currentPatientIdentityTransitionVersion,
  patientIdentityOperationIsCurrent,
  patientIdentityTransitionIsCurrent,
  preCallCandidateMatchesIdentity,
  setPendingRegistrationIdentity,
} from "../identity/promotion.js";
import type { CallState } from "../state/call-state.js";
import { runtimeCallerPhone } from "../state/call-lifecycle.js";
import { recordOwnedMiddlewareFailure } from "../state/observability.js";
import {
  applySchedulingLaneToState,
  insuranceSnapshot,
  lastInsuranceEligibilityCheck,
  setInsuranceOnFile,
  setLastInsuranceEligibilityCheck,
} from "../scheduling/state.js";
import {
  getAmdOfficeForToolCall,
  medicalSchedulingUnavailable,
  routineVisionSchedulingUnavailable,
} from "../scheduling/routing.js";
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
      .optional()
      .describe("Apartment or suite number, if any"),
    city: z.string().describe("City"),
    state: z.string().describe("State, 2-letter abbreviation"),
    zip: z.string().describe("Zip code"),
    sex: z.enum(["male", "female"]).describe("Patient's sex"),
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
        "Last 4 digits of the patient's Social Security number. Collect for routine-vision registration; do not ask for the full SSN.",
      ),
    readBack: z
      .boolean()
      .optional()
      .describe(
        "Set to true only after reading back the patient's name, date of birth, sex, address, callback phone or inbound caller number, email if provided, insurance, policyholder name, member ID, and SSN last 4 for routine vision, and the caller confirms they are correct.",
      ),
  })
  .strict();

export const add_patient = tool({
  name: "add_patient",
  onDuplicate: "reject",
  description:
    "Create a chart for a confirmed new patient after visit triage and an accepted check_insurance result. " +
    "Read back the registration details and get caller confirmation first. " +
    "For routine-vision registration, collect only the patient's SSN last four. " +
    "Before using the inbound caller number, confirm it is a good callback number; if yes, omit phone and set inboundPhoneConfirmed to true. " +
    'Never offer self pay; if the patient asks for it, use "self pay" as insuranceMemberId.',
  parameters: addPatientParameters,
  execute: async (params, { ctx }) => {
    const state = getState(ctx);
    ctx.disallowInterruptions();

    if (state.identity.patient.status === "created") {
      const patientName =
        state.identity.patient.name?.trim() ||
        `${params.firstName} ${params.lastName}`;
      if (!state.insurance.onFile) {
        return `Patient chart is already created for ${patientName}, but insurance is not attached. Do not create another chart. Connect the caller to office staff to finish registration.`;
      }
      return `Patient chart is already created for ${patientName}. Continue with scheduling.`;
    }

    if (state.identity.patient.status !== "new") {
      return "Before creating a new chart, ask whether the patient is already registered with us and call resolve_patient with registrationStatus not_registered after the caller confirms they are not registered.";
    }

    const checkedInsurance = lastInsuranceEligibilityCheck(state);
    const insurance =
      checkedInsurance?.canonicalPlan?.trim() ||
      checkedInsurance?.currentCarrier?.trim() ||
      checkedInsurance?.plan?.trim();
    const coverageType = checkedInsurance?.coverageType;
    if (!checkedInsurance?.accepted || !insurance || !coverageType) {
      return "Run check_insurance for accepted medical or routine-vision coverage before creating a patient chart.";
    }

    const appointmentLane =
      coverageType === "routine_vision" ? "routine_od" : "medical_md";
    applySchedulingLaneToState(state, appointmentLane);
    const unsupportedMedicalScheduling = medicalSchedulingUnavailable(state);
    if (unsupportedMedicalScheduling) return unsupportedMedicalScheduling;
    const unsupportedRoutineVisionScheduling =
      routineVisionSchedulingUnavailable(state);
    if (unsupportedRoutineVisionScheduling)
      return unsupportedRoutineVisionScheduling;

    const selfPay = normalizeInsuranceText(insurance) === "self pay";
    const memberId = selfPay ? "self pay" : params.insuranceMemberId;
    const explicitPhone = params.phone?.trim() ?? "";
    const phone =
      explicitPhone ||
      (params.inboundPhoneConfirmed ? runtimeCallerPhone(state).trim() : "");

    if (hasMatchingPreCallPatient(state, params)) {
      return "A patient record may already exist for that last name and date of birth from the caller phone lookup. Confirm the existing patient record before creating a new chart.";
    }

    if (coverageType === "routine_vision" && !params.ssnLast4) {
      throw new ToolError(
        "Collect the patient's SSN last four before creating a routine-vision chart.",
      );
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
        "callback phone, email if provided, insurance plan, policyholder name, member ID, and patient SSN last 4 for routine vision. " +
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
      aptSuite: params.aptSuite ?? "",
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
      ...(coverageType === "routine_vision"
        ? {
            coverageType: "routine_vision",
            ssn: params.ssnLast4,
          }
        : {}),
      ...(params.email?.trim() ? { email: params.email.trim() } : {}),
    };

    setPendingRegistrationIdentity(state, params);
    const transitionVersion = currentPatientIdentityTransitionVersion(state);
    const operationVersion = beginPatientIdentityOperation(state);
    const result = await ownedMiddleware().createPatient({
      office: getAmdOfficeForToolCall(state),
      patient: payload,
    });
    if (result.status === "error") {
      recordOwnedMiddlewareFailure(state, "createPatient", result);
    }
    if (
      !patientIdentityOperationIsCurrent(state, operationVersion) &&
      !patientIdentityTransitionIsCurrent(state, transitionVersion)
    ) {
      if (result.status === "error") {
        return "The patient chart was not created. The active patient changed before the result returned. Continue with the current patient's state.";
      }
      const patientName =
        result.name?.trim() || `${params.firstName} ${params.lastName}`;
      if (result.status === "partial") {
        return `Created a patient chart for ${patientName}, but insurance was not attached. Do not create another chart. Connect the caller to office staff to finish registration. The active patient changed before the result returned. Continue with the current patient's state.`;
      }
      return `Created a patient chart for ${patientName}, but the active patient changed before the result returned. Do not create another chart. Continue with the current patient's state.`;
    }
    if (result.status === "error") {
      return "The patient chart was not created.";
    }

    applyPatientResult(state, result);
    const patientName =
      result.name?.trim() || `${params.firstName} ${params.lastName}`;
    if (result.status === "partial") {
      setInsuranceOnFile(state, null);
      setLastInsuranceEligibilityCheck(state, null);
      return `Created a patient chart for ${patientName}, but insurance was not attached. Do not create another chart. Connect the caller to office staff to finish registration.`;
    }
    setInsuranceOnFile(
      state,
      insuranceSnapshot({
        plan: result.insuranceCarrier ?? checkedInsurance.currentCarrier,
        canonicalPlan: checkedInsurance.canonicalPlan,
        coverageType,
        currentCarrier:
          result.insuranceCarrier ?? checkedInsurance.currentCarrier,
      }),
    );
    setLastInsuranceEligibilityCheck(state, null);
    return `Created a patient chart for ${patientName}. Continue with scheduling.`;
  },
});

function hasMatchingPreCallPatient(
  state: CallState,
  params: {
    lastName: string;
    dob: string;
  },
): boolean {
  const preCall = state.identity.preCall;
  if (!preCall) return false;

  return preCall.candidates.some((candidate) =>
    preCallCandidateMatchesIdentity(candidate, params),
  );
}
