import { tool, type ToolOptions } from "@livekit/agents";
import { z } from "zod";
import { resolvePatientWithOwnedMiddleware } from "../clients/owned-middleware.js";
import {
  resolvePatientIdentityResult,
  type PatientIdentityResolution,
  type PatientResolveLookup,
} from "../identity/promotion.js";
import { throwOwnedMiddlewareFailure } from "../runtime/middleware-tool-failure.js";
import { recordPatientIdentityOutcome } from "../state/call-state.js";
import { getState } from "./session.js";

const resolvePatientParameters = z
  .object({
    firstName: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        "Caller-provided patient first name. Use this alone only when switching to another preloaded patient from the phone lookup.",
      ),
    lastName: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        "Caller-provided patient last name. Include with DOB for existing-patient lookup.",
      ),
    dob: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        "Caller-provided date of birth in MM/DD/YYYY format. Include with first and last name for existing-patient lookup.",
      ),
  })
  .strict();

const defaultPatientResolveLookup: PatientResolveLookup =
  resolvePatientWithOwnedMiddleware;

type ResolvePatientArgs = z.infer<typeof resolvePatientParameters>;

export function createResolvePatientTool(
  lookup: PatientResolveLookup = defaultPatientResolveLookup,
) {
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
    execute: async (identity: ResolvePatientArgs, { ctx }: ToolOptions) => {
      const state = getState(ctx);
      ctx.disallowInterruptions();
      const outcomeCount = state.runtime.patientIdentityOutcomes.length;
      let resolution: PatientIdentityResolution;
      try {
        resolution = await resolvePatientIdentityResult(
          state,
          identity,
          lookup,
        );
      } catch (error) {
        if (state.runtime.patientIdentityOutcomes.length === outcomeCount) {
          recordPatientIdentityOutcome(state, "lookup_failed");
        }
        throw error;
      }
      if (resolution.outcome === "lookup_failed" && resolution.failure) {
        throwOwnedMiddlewareFailure(resolution.failure, resolution.reply);
      }
      return resolution.reply;
    },
  };
}

export const resolve_patient = tool(
  resolvePatientToolOptions(defaultPatientResolveLookup),
);
