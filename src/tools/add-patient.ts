import { tool } from "@livekit/agents";
import { z } from "zod";
import {
  ownedMiddleware,
  type CreatePatientInput,
} from "../clients/owned-middleware.js";
import { normalizeInsuranceText } from "../insurance-rules.js";
import {
  beginPatientCreation,
  beginNewPatientRegistration,
  commitPatientCreation,
  consumeConfirmedUnregisteredPatient,
  patientRegistrationStatus,
} from "../identity/patient-identity.js";
import { runtimeCallerPhone } from "../state/call-lifecycle.js";
import { recordOwnedMiddlewareFailure } from "../state/observability.js";
import {
  applySchedulingLaneToState,
  lastInsuranceEligibilityCheck,
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
    firstName: z.string().trim().min(1).describe("Patient's first name"),
    lastName: z.string().trim().min(1).describe("Patient's last name"),
    dob: z
      .string()
      .trim()
      .min(1)
      .describe("Date of birth in MM/DD/YYYY format"),
    phone: z
      .string()
      .regex(/^\d{10}$/)
      .nullable()
      .optional()
      .describe(
        "Best callback number, 10 digits only. Pass null when the inbound caller number is confirmed as best; the tool will use the caller phone from state.",
      ),
    inboundPhoneConfirmed: z
      .literal(true)
      .nullable()
      .optional()
      .describe(
        "Set to true only after asking whether the number they are calling from is a good callback number to put on file and the caller says yes. Pass null while confirmation is pending or when a different callback number is supplied.",
      ),
    email: z
      .string()
      .email()
      .nullable()
      .optional()
      .describe(
        "Email address if the caller provides one; otherwise pass null",
      ),
    street: z.string().describe("Street address"),
    aptSuite: z
      .string()
      .nullable()
      .optional()
      .describe("Apartment or suite number, or null when there is none"),
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
      .nullable()
      .optional()
      .describe(
        "Optional caller-provided value. Exactly the last 4 digits of the patient's Social Security number for insured routine-vision registration. Request only the last four digits. Pass null for self pay or when declined or unavailable.",
      ),
    newPatientConfirmed: z
      .literal(true)
      .nullable()
      .optional()
      .describe(
        "Set to true only after the caller explicitly confirms this is the patient's first registration with the practice. Pass null until confirmed.",
      ),
    readBack: z
      .literal(true)
      .nullable()
      .optional()
      .describe(
        "Set to true only after reading back the patient's name, date of birth, sex, address, callback phone or inbound caller number, email if provided, insurance, policyholder name, and member ID; confirming any provided SSN last four was captured without repeating the digits; and the caller confirms the details are correct. Pass null until confirmed.",
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
    "For insured routine-vision registration, ask once for the patient's SSN last four. Continue without it if declined or unavailable. Request only the last four digits. Skip SSN collection for self pay. " +
    "Before using the inbound caller number, confirm it is a good callback number; if yes, omit phone and set inboundPhoneConfirmed to true. " +
    'Use "self pay" as insuranceMemberId only when the patient asks for self pay.',
  parameters: addPatientParameters,
  execute: async (params, { ctx }) => {
    const state = getState(ctx);
    ctx.disallowInterruptions();
    const patientIdentity = {
      firstName: params.firstName.trim(),
      lastName: params.lastName.trim(),
      dob: params.dob.trim(),
    };
    if (
      !patientIdentity.firstName ||
      !patientIdentity.lastName ||
      !patientIdentity.dob
    ) {
      return "Before creating a new chart, collect the patient's first name, last name, and date of birth, then call add_patient again.";
    }

    const registrationStatus = patientRegistrationStatus(
      state,
      patientIdentity,
    );
    if (registrationStatus === "created_patient") {
      const patientName =
        state.identity.activePatient?.name?.trim() ||
        `${params.firstName} ${params.lastName}`;
      if (!state.insurance.onFile) {
        return `Patient chart is already created for ${patientName}, but insurance is not attached. Do not create another chart. Connect the caller to office staff to finish registration.`;
      }
      return `Patient chart is already created for ${patientName}. Continue with scheduling.`;
    }

    if (registrationStatus === "active_patient") {
      return "The active patient already matches that identity. Continue with the loaded patient instead of creating a new chart.";
    }

    if (registrationStatus === "different_patient") {
      return "Before creating a chart for a different patient, call resolve_patient with that patient's full name and date of birth. Continue new-patient registration only after the lookup confirms no existing chart.";
    }

    if (registrationStatus === "pre_call_candidate") {
      return "Do not create a new chart yet. Ask the privacy-safe first-name question, then use the runtime-confirmed patient state or continue an existing-patient lookup.";
    }

    if (!params.newPatientConfirmed) {
      return "Before creating a new chart, ask the caller to confirm that the patient has never registered with or been added to the practice. Call add_patient again with newPatientConfirmed set to true only after the caller confirms.";
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

    const confirmedUnregisteredPatient =
      registrationStatus === "confirmed_new_patient" &&
      consumeConfirmedUnregisteredPatient(state, patientIdentity);
    if (
      registrationStatus === "confirmed_new_patient" &&
      !confirmedUnregisteredPatient
    ) {
      return "Run check_insurance for accepted medical or routine-vision coverage before creating a patient chart.";
    }
    beginNewPatientRegistration(state, patientIdentity, {
      preserveEligibilityCheck: confirmedUnregisteredPatient,
    });

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
            ...(!selfPay && params.ssnLast4 ? { ssn: params.ssnLast4 } : {}),
          }
        : {}),
      ...(params.email?.trim() ? { email: params.email.trim() } : {}),
    };

    const creation = beginPatientCreation(state);
    if (!creation) {
      throw new Error("Patient registration is incomplete before creation.");
    }
    const result = await ownedMiddleware().createPatient({
      office: getAmdOfficeForToolCall(state),
      patient: payload,
    });
    if (result.status === "error") {
      recordOwnedMiddlewareFailure(state, "createPatient", result);
    }
    const commit = commitPatientCreation(state, creation, result);
    if (commit.outcome === "superseded") {
      if (commit.result.status === "error") {
        return "I couldn't create the patient chart, and the active patient changed. Continue with the current patient and do not retry this request.";
      }
      const patientName =
        commit.result.name?.trim() || `${params.firstName} ${params.lastName}`;
      if (commit.result.status === "partial") {
        return `Created a patient chart for ${patientName}, but insurance was not attached. Do not create another chart. Connect the caller to office staff to finish registration. The active patient changed before the result returned. Continue with the current patient's state.`;
      }
      return `Created a patient chart for ${patientName}, but the active patient changed before the result returned. Do not create another chart. Continue with the current patient's state.`;
    }
    if (commit.outcome === "failed") {
      throwOwnedMiddlewareFailure(
        commit.failure,
        "I couldn't create the patient chart. I can try once more or connect you with the office.",
      );
    }
    if (commit.outcome === "invalid_receipt") {
      if (commit.result) {
        return "A patient chart was created, but its identity receipt did not match the current registration. Do not create another chart. Connect the caller to office staff to verify the chart.";
      }
      throw new Error(
        "Owned Middleware returned an invalid patient creation receipt.",
      );
    }
    const receipt = commit.receipt;
    const patientName =
      receipt.name?.trim() || `${params.firstName} ${params.lastName}`;
    if (receipt.status === "partial") {
      return `Created a patient chart for ${patientName}, but insurance was not attached. Do not create another chart. Connect the caller to office staff to finish registration.`;
    }
    return `Created a patient chart for ${patientName}. Continue with scheduling.`;
  },
});
