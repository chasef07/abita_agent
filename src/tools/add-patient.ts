import { tool } from "@livekit/agents";
import { z } from "zod";
import {
  ownedMiddleware,
  type CreatePatientInput,
} from "../clients/owned-middleware.js";
import { normalizeInsuranceText } from "../insurance-rules.js";
import {
  activatePatientFromReceipt,
  beginNewPatientRegistration,
  beginPatientIdentityOperation,
  currentPatientIdentityTransitionVersion,
  patientRegistrationConflict,
  patientIdentityOperationIsCurrent,
  patientIdentityTransitionIsCurrent,
} from "../identity/patient-identity.js";
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
import { throwOwnedMiddlewareFailure } from "../runtime/middleware-tool-failure.js";

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
        "Exactly the last 4 digits of the patient's Social Security number, collected for routine-vision registration.",
      ),
    newPatientConfirmed: z
      .boolean()
      .optional()
      .describe(
        "Set to true only after the caller explicitly confirms this is the patient's first registration with the practice.",
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
    "Create a chart after the caller explicitly confirms this is the patient's first registration with the practice, visit triage, and an accepted check_insurance result. " +
    "After that confirmation, call add_patient directly with newPatientConfirmed true. " +
    "Read back the registration details and get caller confirmation first. " +
    "For routine-vision registration, collect only the patient's SSN last four. " +
    "Before using the inbound caller number, confirm it is a good callback number; if yes, omit phone and set inboundPhoneConfirmed to true. " +
    'Use "self pay" as insuranceMemberId only when the patient asks for self pay.',
  parameters: addPatientParameters,
  execute: async (params, { ctx }) => {
    const state = getState(ctx);
    ctx.disallowInterruptions();

    const registrationConflict = patientRegistrationConflict(state, params);
    if (registrationConflict === "created_patient") {
      const patientName =
        state.identity.activePatient?.name?.trim() ||
        `${params.firstName} ${params.lastName}`;
      if (!state.insurance.onFile) {
        return `Patient chart is already created for ${patientName}, but insurance is not attached. Do not create another chart. Connect the caller to office staff to finish registration.`;
      }
      return `Patient chart is already created for ${patientName}. Continue with scheduling.`;
    }

    if (registrationConflict === "active_patient") {
      return "The active patient already matches that identity. Continue with the loaded patient instead of creating a new chart.";
    }

    if (registrationConflict === "pre_call_candidate") {
      return "Do not create a new chart yet. Ask the privacy-safe first-name question, then use the runtime-confirmed patient state or continue an existing-patient lookup.";
    }

    if (!params.newPatientConfirmed) {
      return "Before creating a new chart, ask the caller to confirm that the patient has never registered with or been added to the practice. Call add_patient again with newPatientConfirmed set to true only after the caller confirms.";
    }

    beginNewPatientRegistration(state, params);

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

    if (coverageType === "routine_vision" && !params.ssnLast4) {
      return "Collect the patient's SSN last four before creating a routine-vision chart.";
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
      return "A callback phone number is required before creating a chart. Ask whether the inbound number is best, or collect a callback number.";
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
        return "I couldn't create the patient chart, and the active patient changed. Continue with the current patient and do not retry this request.";
      }
      const patientName =
        result.name?.trim() || `${params.firstName} ${params.lastName}`;
      if (result.status === "partial") {
        return `Created a patient chart for ${patientName}, but insurance was not attached. Do not create another chart. Connect the caller to office staff to finish registration. The active patient changed before the result returned. Continue with the current patient's state.`;
      }
      return `Created a patient chart for ${patientName}, but the active patient changed before the result returned. Do not create another chart. Continue with the current patient's state.`;
    }
    if (result.status === "error") {
      throwOwnedMiddlewareFailure(
        result,
        "I couldn't create the patient chart. I can try once more or connect you with the office.",
      );
    }

    if (!activatePatientFromReceipt(state, result)) {
      throw new Error(
        "Owned Middleware returned an invalid patient creation receipt.",
      );
    }
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
