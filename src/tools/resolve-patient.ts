import { tool, type ToolOptions } from "@livekit/agents";
import { z } from "zod";
import { ownedMiddleware } from "../clients/owned-middleware.js";
import {
  resolvePatientIdentity,
  type PatientResolveLookup,
} from "../identity/promotion.js";
import { getState } from "./session.js";

const resolvePatientParameters = z.object({
  firstName: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Caller-provided patient first name. Use this alone when matching a preloaded patient from the phone lookup.",
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
  registrationStatus: z
    .enum(["registered_before", "not_registered", "unsure"])
    .optional()
    .describe(
      "Set when the caller answers whether the patient has already registered with the practice.",
    ),
});

const defaultPatientResolveLookup: PatientResolveLookup = (
  officePhone,
  identity,
) =>
  ownedMiddleware().resolvePatient({
    office: officePhone,
    identity,
  });

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
      "Resolve who the patient is before patient-specific work. " +
      "Use only identity details the caller has provided. " +
      "For phone lookup matches, pass the caller-provided firstName and this tool will deterministically match or switch the active preloaded patient. " +
      "For existing patients not resolved from phone lookup, collect firstName, lastName, and DOB before calling. " +
      "When the caller says the patient has not registered with us before, call with registrationStatus not_registered before add_patient. " +
      "If the correct patient is already active, do not call this tool again. Use this tool to switch to a different patient using caller-provided identity details.",
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
