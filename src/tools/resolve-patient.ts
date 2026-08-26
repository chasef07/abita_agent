import { tool, type ToolOptions } from "@livekit/agents";
import { z } from "zod";
import type { OwnedMiddleware } from "../clients/owned-middleware.js";
import {
  resolveExistingPatient,
  type PatientIdentityResolution,
  type PatientResolveLookup,
} from "../identity/patient-identity.js";
import { throwOwnedMiddlewareFailure } from "../runtime/middleware-tool-failure.js";
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
        "Caller-provided patient first name. Use this alone only when switching to another preloaded patient from the phone lookup. Pass null when the caller has not supplied it.",
      ),
    lastName: z
      .string()
      .trim()
      .min(1)
      .nullable()
      .describe(
        "Caller-provided patient last name. Include with DOB for existing-patient lookup. Pass null for first-name-only preloaded-patient activation.",
      ),
    dob: z
      .string()
      .trim()
      .min(1)
      .nullable()
      .describe(
        "Caller-provided date of birth in MM/DD/YYYY format. Include with first and last name for existing-patient lookup. Pass null for first-name-only preloaded-patient activation.",
      ),
  })
  .strict();

type ResolvePatientArgs = z.infer<typeof resolvePatientParameters>;

export function createResolvePatientTool(middleware: OwnedMiddleware) {
  const lookup: PatientResolveLookup = (office, identity) =>
    middleware.resolvePatient({ office, identity });
  return tool(resolvePatientToolOptions(lookup));
}

function resolvePatientToolOptions(lookup: PatientResolveLookup) {
  return {
    name: "resolve_patient",
    onDuplicate: "reject" as const,
    description:
      "Resolve who the patient is when an existing patient still needs activation. " +
      "Use only identity details the caller has provided. " +
      "Runtime first tries to activate a matching preloaded patient from every caller turn; continue with active patient state when runtime confirms that patient. " +
      "When runtime leaves identity unconfirmed after the supplied first name, collect firstName, lastName, and DOB and use this tool as the last resort for existing-patient lookup. " +
      "To switch to another preloaded patient, pass the caller-provided firstName. " +
      "When the correct patient is already active, continue with that state. Use this tool to switch to a different patient using caller-provided identity details. " +
      "Use add_patient for explicit new-patient confirmation and chart creation.",
    parameters: resolvePatientParameters,
    execute: async (
      identity: ResolvePatientArgs,
      { ctx, toolCallId }: ToolOptions,
    ) => {
      const state = getState(ctx);
      ctx.disallowInterruptions();
      const outcomes = domainOutcomesForTool(
        state,
        toolCallId,
        "resolve_patient",
      );
      const suppliedIdentity = {
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
      if (resolution.outcome === "lookup_failed" && resolution.failure) {
        throwOwnedMiddlewareFailure(resolution.failure, resolution.reply);
      }
      return resolution.reply;
    },
  };
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
