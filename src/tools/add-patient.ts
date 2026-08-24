import { tool } from "@livekit/agents";
import { z } from "zod";
import type {
  CreatePatientInput,
  CreatePatientResult,
  OwnedMiddleware,
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
import {
  domainOutcomesForTool,
  recordOwnedMiddlewareFailure,
} from "../state/observability.js";
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
      .nullable()
      .describe(
        "Different callback number, 10 digits. Pass null when inboundPhoneConfirmed is true.",
      ),
    inboundPhoneConfirmed: z
      .literal(true)
      .nullable()
      .describe(
        "True only after the caller confirms the inbound number is a good callback number.",
      ),
    email: z
      .string()
      .nullable()
      .describe("Caller-provided email, or null."),
    street: z.string().describe("Street address"),
    aptSuite: z
      .string()
      .nullable()
      .describe("Apartment or suite, or null."),
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
      .describe(
        "Optional SSN last four for insured routine vision. Request only four digits; pass null for self-pay, declined, or unavailable.",
      ),
    newPatientConfirmed: z
      .literal(true)
      .nullable()
      .describe(
        "True only after the caller confirms this is the patient's first registration; otherwise null.",
      ),
    readBack: z
      .literal(true)
      .nullable()
      .describe(
        "True only after the caller confirms the full identity, contact, address, and insurance read-back. Acknowledge captured SSN last four without repeating it; otherwise null.",
      ),
  })
  .strict();

export function createAddPatientTool(middleware: OwnedMiddleware) {
  return tool({
    name: "add_patient",
    onDuplicate: "reject",
    description:
      "Create a new patient chart only after first-registration confirmation, appointment triage, accepted insurance, callback-number confirmation, and a confirmed full read-back. " +
      "For insured routine vision, request only SSN last four once and continue if unavailable; skip it for self-pay. " +
      "Success requires this tool's creation receipt; never retry after full or partial chart creation.",
    parameters: addPatientParameters,
    execute: async (params, { ctx, toolCallId }): Promise<string> => {
      const state = getState(ctx);
      ctx.disallowInterruptions();
      const outcomes = domainOutcomesForTool(state, toolCallId, "add_patient");
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
          recordPatientCreationOutcome(outcomes, "partial");
          return `Patient chart is already created for ${patientName}, but insurance is not attached. Do not create another chart. Connect the caller to office staff to finish registration.`;
        }
        recordPatientCreationOutcome(outcomes, "success");
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
        recordPatientCreationOutcome(outcomes, "failed");
        throw new Error("Patient registration is incomplete before creation.");
      }
      let result: CreatePatientResult;
      try {
        result = await middleware.createPatient({
          office: getAmdOfficeForToolCall(state),
          patient: payload,
        });
      } catch (error) {
        recordPatientCreationOutcome(outcomes, "failed");
        throw error;
      }
      if (result.status === "error") {
        recordOwnedMiddlewareFailure(state, "createPatient", result);
      }
      const commit = commitPatientCreation(state, creation, result);
      if (commit.outcome === "superseded") {
        if (commit.result.status === "error") {
          recordPatientCreationOutcome(outcomes, "failed");
          return "I couldn't create the patient chart, and the active patient changed. Continue with the current patient and do not retry this request.";
        }
        const patientName =
          commit.result.name?.trim() ||
          `${params.firstName} ${params.lastName}`;
        if (commit.result.status === "partial") {
          recordPatientCreationOutcome(outcomes, "partial", true);
          return `Created a patient chart for ${patientName}, but insurance was not attached. Do not create another chart. Connect the caller to office staff to finish registration. The active patient changed before the result returned. Continue with the current patient's state.`;
        }
        recordPatientCreationOutcome(outcomes, "success", true);
        return `Created a patient chart for ${patientName}, but the active patient changed before the result returned. Do not create another chart. Continue with the current patient's state.`;
      }
      if (commit.outcome === "failed") {
        recordPatientCreationOutcome(outcomes, "failed");
        throwOwnedMiddlewareFailure(
          commit.failure,
          "I couldn't create the patient chart. I can try once more or connect you with the office.",
        );
      }
      if (commit.outcome === "invalid_receipt") {
        if (commit.result) {
          recordPatientCreationOutcome(outcomes, "ambiguous");
          return "A patient chart was created, but its identity receipt did not match the current registration. Do not create another chart. Connect the caller to office staff to verify the chart.";
        }
        recordPatientCreationOutcome(outcomes, "failed");
        throw new Error(
          "Owned Middleware returned an invalid patient creation receipt.",
        );
      }
      const receipt = commit.receipt;
      const patientName =
        receipt.name?.trim() || `${params.firstName} ${params.lastName}`;
      if (receipt.status === "partial") {
        recordPatientCreationOutcome(outcomes, "partial");
        return `Created a patient chart for ${patientName}, but insurance was not attached. Do not create another chart. Connect the caller to office staff to finish registration.`;
      }
      recordPatientCreationOutcome(outcomes, "success");
      return `Created a patient chart for ${patientName}. Continue with scheduling.`;
    },
  });
}

function recordPatientCreationOutcome(
  outcomes: ReturnType<typeof domainOutcomesForTool>,
  status: "success" | "partial" | "ambiguous" | "failed",
  superseded = false,
): void {
  outcomes.record({
    outcome:
      status === "success"
        ? "patient_created"
        : status === "partial"
          ? "patient_creation_partial"
          : status === "ambiguous"
            ? "patient_creation_ambiguous"
            : "patient_creation_failed",
    status,
    ...(superseded ? { evidence: { superseded: true } } : {}),
  });
}
