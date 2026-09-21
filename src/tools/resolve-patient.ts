import { tool, ToolError, type ToolOptions } from "@livekit/agents";
import { z } from "zod";
import type { OwnedMiddleware } from "../clients/owned-middleware.js";
import {
  resolveExistingPatient,
  type PatientIdentityResolution,
  type PatientResolveLookup,
} from "../identity/patient-identity.js";
import type { OfficeKey } from "../customers/abita/profile.js";
import { activeOfficeKey } from "../state/call-lifecycle.js";
import { domainOutcomesForTool } from "../state/observability.js";
import { getState } from "./session.js";

const resolvePatientParameters = z
  .object({
    firstName: z
      .string()
      .trim()
      .min(1)
      .nullable()
      .describe(
        "Caller-provided first name of the patient receiving care; null if unknown.",
      ),
    dob: z
      .string()
      .trim()
      .nullable()
      .describe("Caller-provided DOB in MM/DD/YYYY; null if unknown."),
  })
  .strict();

type ResolvePatientArgs = z.infer<typeof resolvePatientParameters>;

export function createResolvePatientTool(
  middleware: OwnedMiddleware,
  officeKey?: OfficeKey,
) {
  const lookup: PatientResolveLookup = (office, identity) =>
    middleware.resolvePatient({ office, identity });
  return tool({
    name: "resolve_patient",
    onDuplicate: "reject",
    description:
      officeKey === "rheumatology-demo"
        ? "For existing/unsure patients, use supplied firstName and DOB (otherwise dob:null). Require DOB for same-name patient switches. If unresolved, clarify DOB and first-name spelling and follow the result. Use caller-provided identity only. Acknowledge success without appointment references. Confirmed first registrations use add_patient prerequisites directly; lookup failure never confirms new-patient status."
        : "Call immediately with the patient's supplied firstName. Include supplied DOB without confirmation; otherwise pass dob:null and follow the returned next step. " +
          "Require DOB for same-name patient switches. " +
          "If unresolved, add DOB and retry; if still unresolved, clarify DOB and first-name spelling and retry before offering staff. " +
          "After success, say the acknowledgment, never internal appointment references. Use caller-provided identity only. Use add_patient for registration.",
    parameters: resolvePatientParameters,
    execute: async (
      identity: ResolvePatientArgs,
      { ctx, toolCallId }: ToolOptions,
    ): Promise<string> => {
      const state = getState(ctx);
      ctx.disallowInterruptions();
      const outcomes = domainOutcomesForTool(
        state,
        toolCallId,
        "resolve_patient",
      );
      const suppliedIdentity = {
        firstName: identity.firstName ?? undefined,
        dob: identity.dob ?? undefined,
      };
      let resolution: PatientIdentityResolution;
      try {
        resolution = await resolveExistingPatient(
          state,
          suppliedIdentity,
          lookup,
        );
      } catch (error) {
        outcomes.record({
          outcome: "patient_lookup_failed",
          status: "failed",
        });
        throw error;
      }
      outcomes.record(patientResolutionDomainOutcome(resolution.outcome));
      if (resolution.outcome === "lookup_failed") {
        if (activeOfficeKey(state) === "rheumatology-demo") {
          return "The patient lookup could not be verified; this does not mean the patient is new. Ask whether this is their first registration unless they already explicitly confirmed it. Only after that confirmation, follow the existing check_insurance and add_patient prerequisites, including callback confirmation and full read-back. Do not create a chart for an existing or unsure patient. If identity remains unresolved, explain that you cannot complete the appointment right now; do not promise a transfer or staff follow-up.";
        }
        throw new ToolError(resolution.reply);
      }
      if (
        state.identity.activePatient?.dob?.trim() &&
        (resolution.outcome === "verified" || resolution.outcome === "switched")
      ) {
        return `${resolution.reply}\nDOB is on file. Do not ask for DOB.`;
      }
      return resolution.reply;
    },
  });
}

function patientResolutionDomainOutcome(
  outcome: PatientIdentityResolution["outcome"],
) {
  switch (outcome) {
    case "verified":
      return {
        outcome: "patient_verified" as const,
        status: "success" as const,
      };
    case "switched":
      return {
        outcome: "patient_switched" as const,
        status: "success" as const,
      };
    case "new":
      return { outcome: "patient_new" as const, status: "success" as const };
    case "not_found":
      return {
        outcome: "patient_not_found" as const,
        status: "success" as const,
      };
    case "multiple_matches":
      return {
        outcome: "patient_lookup_returned_multiple" as const,
        status: "blocked" as const,
      };
    case "needs_identity":
      return {
        outcome: "patient_lookup_needs_identity" as const,
        status: "blocked" as const,
      };
    case "lookup_failed":
      return {
        outcome: "patient_lookup_failed" as const,
        status: "failed" as const,
      };
    case "superseded":
      return {
        outcome: "patient_lookup_ambiguous" as const,
        status: "ambiguous" as const,
      };
  }
}
