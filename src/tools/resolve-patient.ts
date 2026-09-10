import { tool, ToolError, type ToolOptions } from "@livekit/agents";
import { z } from "zod";
import type { OwnedMiddleware } from "../clients/owned-middleware.js";
import {
  resolveExistingPatient,
  type PatientIdentityResolution,
  type PatientResolveLookup,
} from "../identity/patient-identity.js";
import { domainOutcomesForTool } from "../state/observability.js";
import { getState } from "./session.js";

const resolvePatientParameters = z
  .object({
    patientContext: z
      .enum(["correction", "different_patient"])
      .nullable()
      .describe(
        "different_patient when starting another person's task, even with the same first name; correction when correcting the same person's details; null to continue.",
      ),
    firstName: z
      .string()
      .trim()
      .min(1)
      .nullable()
      .describe(
        "Caller-provided first name of the patient receiving care; null if unknown.",
      ),
    lastName: z
      .string()
      .trim()
      .nullable()
      .describe("Caller-provided patient surname; null if unknown."),
    dob: z
      .string()
      .trim()
      .nullable()
      .describe(
        "Caller-provided date of birth in MM/DD/YYYY, after read-back confirmation; null if not supplied.",
      ),
  })
  .strict();

type ResolvePatientArgs = z.infer<typeof resolvePatientParameters>;

export function createResolvePatientTool(middleware: OwnedMiddleware) {
  const lookup: PatientResolveLookup = (office, identity) =>
    middleware.resolvePatient({ office, identity });
  return tool({
    name: "resolve_patient",
    onDuplicate: "reject",
    description:
      "Activate or look up an existing patient. Try their supplied first name against phone matches; surname cannot block a unique match. " +
      "Use only caller-provided identity; leave unknown fields null. Null preserves pending details. " +
      "Ask for spelled first name and confirmed DOB if unresolved. Mark corrections or a different patient with patientContext; follow the result. " +
      "Use add_patient for new-patient chart creation.",
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
        patientContext: identity.patientContext ?? undefined,
        firstName: identity.firstName ?? undefined,
        lastName: identity.lastName ?? undefined,
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
        throw new ToolError(resolution.reply);
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
