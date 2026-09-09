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
import { domainOutcomesForTool } from "../state/observability.js";
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
    email: z.string().nullable().describe("Caller-provided email, or null."),
    street: z.string().describe("Street address"),
    aptSuite: z.string().nullable().describe("Apartment or suite, or null."),
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
        "Optional SSN last four for insured routine vision. Request only four digits. Pass null for self-pay, declined, or unavailable.",
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

type AddPatientParameters = z.infer<typeof addPatientParameters>;

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
        return "What is the patient's full name and date of birth?";
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
          return `The patient chart for ${patientName} already exists, but insurance is not attached. Office staff needs to finish the registration.`;
        }
        recordPatientCreationOutcome(outcomes, "success");
        return `The patient chart for ${patientName} already exists. We can continue with scheduling.`;
      }

      if (registrationStatus === "active_patient") {
        return "That patient is already active, so I won't create another chart.";
      }

      if (registrationStatus === "different_patient") {
        return "I need to check whether this patient already has a chart before creating a new one.";
      }

      if (registrationStatus === "pre_call_candidate") {
        return "I need to confirm the patient's first name before creating a new chart. Could you spell it for me?";
      }

      if (!params.newPatientConfirmed) {
        return "Has the patient ever registered with or been added to the practice?";
      }

      const checkedInsurance = lastInsuranceEligibilityCheck(state);
      const insurance =
        checkedInsurance?.canonicalPlan?.trim() ||
        checkedInsurance?.currentCarrier?.trim() ||
        checkedInsurance?.plan?.trim();
      const coverageType = checkedInsurance?.coverageType;
      if (!checkedInsurance?.accepted || !insurance || !coverageType) {
        return "I need to confirm accepted medical or routine vision coverage before creating the chart.";
      }

      const confirmedUnregisteredPatient =
        registrationStatus === "confirmed_new_patient" &&
        consumeConfirmedUnregisteredPatient(state, patientIdentity);
      if (
        registrationStatus === "confirmed_new_patient" &&
        !confirmedUnregisteredPatient
      ) {
        return "I need to confirm accepted medical or routine vision coverage before creating the chart.";
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
        return "Is the number you're calling from a good callback number to put on file?";
      }

      if (!phone) {
        return "What is the best callback number for the patient chart?";
      }

      if (!params.readBack) {
        return registrationReadBack(params, {
          coverageType,
          insurance,
          phone,
          selfPay,
        });
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
      const commit = commitPatientCreation(state, creation, result);
      if (commit.outcome === "superseded") {
        if (commit.result.status === "error") {
          recordPatientCreationOutcome(outcomes, "failed");
          return "I couldn't create the patient chart, and the patient changed while I was working.";
        }
        const patientName =
          commit.result.name?.trim() ||
          `${params.firstName} ${params.lastName}`;
        if (commit.result.status === "partial") {
          recordPatientCreationOutcome(outcomes, "partial", true);
          return `I created a patient chart for ${patientName}, but insurance was not attached. Office staff needs to finish the registration. The patient also changed while I was working.`;
        }
        recordPatientCreationOutcome(outcomes, "success", true);
        return `I created a patient chart for ${patientName}. The patient changed while I was working.`;
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
          return "I created a patient chart, but I couldn't verify the registration details. Office staff needs to check it.";
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
        return `I created a patient chart for ${patientName}, but insurance was not attached. Office staff needs to finish the registration.`;
      }
      recordPatientCreationOutcome(outcomes, "success");
      return `I created a patient chart for ${patientName}. We can continue with scheduling.`;
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

function registrationReadBack(
  params: AddPatientParameters,
  input: {
    coverageType: "medical" | "routine_vision";
    insurance: string;
    phone: string;
    selfPay: boolean;
  },
): string {
  const patientName = `${params.firstName.trim()} ${params.lastName.trim()}`;
  const region = [params.state?.trim(), params.zip?.trim()]
    .filter(Boolean)
    .join(" ");
  const locality = [params.city?.trim(), region].filter(Boolean).join(", ");
  const address = [params.street?.trim(), params.aptSuite?.trim(), locality]
    .filter(Boolean)
    .join(", ");
  const email = params.email?.trim();
  const policyholder = params.subscriberName?.trim();
  const memberId = params.insuranceMemberId?.trim();
  const coverage = input.selfPay
    ? "The patient will use self-pay."
    : policyholder && memberId
      ? `The insurance is ${input.insurance}, with ${policyholder} as the policyholder and member ID ${memberId}.`
      : `The insurance is ${input.insurance}.`;

  return [
    `Let me confirm the registration for ${patientName}, date of birth ${params.dob.trim()}, ${params.sex}.`,
    address ? `The address is ${address}.` : "",
    `The callback number is ${spokenPhoneNumber(input.phone)}.`,
    email ? `The email is ${email}.` : "",
    coverage,
    input.coverageType === "routine_vision" && !input.selfPay && params.ssnLast4
      ? "I also recorded the requested last four digits without reading them aloud."
      : "",
    "Is all of that correct?",
  ]
    .filter(Boolean)
    .join(" ");
}

function spokenPhoneNumber(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  const local =
    digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (local.length !== 10) return phone.trim();
  return `${local.slice(0, 3)}-${local.slice(3, 6)}-${local.slice(6)}`;
}
