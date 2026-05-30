import { llm } from "@livekit/agents";
import { z } from "zod";
import {
  clearAvailabilitySelection,
  hasActivePatientIdentityChanged,
  snapshotActivePatientIdentity,
} from "../state/call-state.js";
import {
  applyResolvedPatientToState,
  buildPatientResolveRequest,
  changedKnownIdentityValue,
  clearSessionPatientRecord,
  confirmPendingPreCallCallerFromVerifyArgs,
  publicPatientResolveResult,
  resolvePatientForCall,
  restoreConfirmedPreCallCaller,
} from "./patient-state.js";
import { getState } from "./session.js";

export const verify_patient = llm.tool({
  description:
    "Verify an existing patient for patient-specific help such as scheduling, " +
    "appointment management, insurance updates, registration fallback, or private account questions. " +
    "For caller-phone lookup, provide firstName only; phone comes from session state. " +
    "Use lastName and dob only when first-name lookup is ambiguous, fails, or the caller is calling for someone else. " +
    "Follow the returned status, next, patient, and appointments fields.",
  parameters: z.object({
    firstName: z
      .string()
      .optional()
      .describe("Patient's first name as spelled by the caller when available"),
    lastName: z
      .string()
      .optional()
      .describe(
        "Patient's last name as spelled by the caller when available; only needed after first name + caller phone fails or is ambiguous",
      ),
    dob: z
      .string()
      .optional()
      .describe(
        "Patient's date of birth in MM/DD/YYYY format; only needed after first name + caller phone fails or is ambiguous",
      ),
  }),
  execute: async ({ firstName, lastName, dob }, { ctx }) => {
    const state = getState(ctx);
    restoreConfirmedPreCallCaller(state);
    confirmPendingPreCallCallerFromVerifyArgs(state, {
      firstName,
      lastName,
      dob,
    });
    restoreConfirmedPreCallCaller(state);
    const request = buildPatientResolveRequest(state, {
      firstName,
      lastName,
      dob,
    });
    if (!firstName && !request.usesFullIdentity) {
      return {
        outcome: "needs_clarification",
        speak:
          "Ask for the patient's first name before verifying them, or ask for last name and date of birth if the caller is calling for someone else.",
        facts: { reason: "patient_lookup_requires_identity" },
        retryable: true,
      };
    }
    if (!request.usesCallerPhone && !request.usesFullIdentity) {
      return {
        outcome: "needs_clarification",
        speak:
          "Ask for the patient's first name, or collect both last name and date of birth before verifying someone not tied to the caller phone.",
        facts: {
          reason: "patient_lookup_requires_caller_phone_or_full_identity",
        },
        retryable: true,
      };
    }
    const previousIdentity = snapshotActivePatientIdentity(state);
    const typedIdentityChanged =
      changedKnownIdentityValue(previousIdentity.name, firstName) ||
      changedKnownIdentityValue(previousIdentity.dob, dob);
    if (typedIdentityChanged) clearSessionPatientRecord(state);
    const identityChanged = hasActivePatientIdentityChanged(
      state,
      previousIdentity,
    );
    if (identityChanged) {
      clearAvailabilitySelection(state);
      clearSessionPatientRecord(state);
    }
    const result = await resolvePatientForCall(state, request);
    const publicResult = publicPatientResolveResult(result, request);
    if (result.status === "verified") {
      applyResolvedPatientToState(state, result);
      return publicResult;
    }
    return publicResult;
  },
});
