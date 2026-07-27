import { tool, type ToolOptions } from "@livekit/agents";
import { z } from "zod";
import { resolvePatientWithOwnedMiddleware } from "../clients/owned-middleware.js";
import {
  resolvePatientIdentity,
  type PatientResolveLookup,
} from "../identity/promotion.js";
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
      "Resolve who the patient is when an existing patient is not already active. " +
      "Use only identity details the caller has provided. " +
      "Runtime activates the initial matching preloaded patient; do not call this tool for that patient. " +
      "To switch to another preloaded patient, pass the caller-provided firstName. " +
      "For existing patients not resolved from phone lookup, collect firstName, lastName, and DOB before calling. " +
      "If the correct patient is already active, do not call this tool again. Use this tool to switch to a different patient using caller-provided identity details. " +
      "Do not use this tool to mark a patient as new; add_patient owns explicit new-patient confirmation and chart creation.",
    parameters: resolvePatientParameters,
    execute: async (identity: ResolvePatientArgs, { ctx }: ToolOptions) => {
      const state = getState(ctx);
      ctx.disallowInterruptions();
      return resolvePatientIdentity(state, identity, lookup);
    },
  };
}

export const resolve_patient = tool(
  resolvePatientToolOptions(defaultPatientResolveLookup),
);
