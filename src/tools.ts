// tools.ts — Tool definitions for the voice agent
// Each tool makes an HTTP call to the AdvancedMD middleware on Railway.

import { llm, voice } from "@livekit/agents";
import { z } from "zod";
import {
  getOfficeConfig,
  SPRING_HILL_OFFICE_PHONE,
} from "./customer/profile.js";
import {
  buildInsuranceToolResponse,
  canonicalInsurancePlan,
  normalizeCoverageType,
  normalizeInsuranceText,
  matchInsurancePlanForOffice,
  type InsuranceToolResponse,
} from "./insurance-rules.js";
import {
  evaluateFlowToolPolicy,
  advanceWorkflow,
  classifyVisitType,
  compactWorkflowCommand,
  completeCurrentTaskAndResume,
  createPendingBookingAction,
  DEFAULT_PATIENT_REF,
  hashToolArgs,
  nextPatientFlowStep,
  normalizeSchedulingRouting,
  nextFlowEventId,
  recordAvailabilityCachedSlots,
  recordAvailabilitySearch,
  recordAvailabilitySearchRange,
  recordBookingAttempt,
  recordBookingResult,
  ensureActivePatientContext,
  hasActivePatientIdentityChanged,
  snapshotActivePatientIdentity,
  sideEffectActionTypeForTool,
  reduceFlowEvent,
  type AppointmentLoadStatus,
  type AvailabilityInvalidationReason,
  type FlowTurnAdvanceResult,
  type GuardedToolName,
  type SideEffectToolName,
  type ToolOutcome,
  turnUnderstandingSchema,
} from "./flow/index.js";
import {
  callApi,
  resolvePatientByOffice,
  type PatientResolveResult,
  type PatientResolveVerified,
} from "./tooling/advancedmd-client.js";
import { lookupOfficeKnowledge } from "./tooling/knowledge.js";
import { transferCallerToOffice } from "./tooling/handoff.js";
import {
  appointmentCancelTokenMap,
  publicCallerAppointments,
  type CallState,
  type StoredAvailabilitySlot,
  type StoredCallerAppointment,
} from "./tooling/call-state.js";
import {
  clearAvailabilitySlots,
  normalizeSlotId,
  publicAvailabilitySlots,
  removeAvailabilitySlot,
  selectedAvailabilitySlot,
  storeAvailabilitySlots,
} from "./tooling/availability-slots.js";
import {
  activeAppointmentById,
  appointmentIdFromBookingResult,
  appointmentStatusFromResult,
  cancelTokenForAppointment,
  extractAppointments,
  recordBookedAppointmentInState,
  refreshCancelTokenForAppointment,
  removeAppointmentById,
} from "./tooling/appointment-state.js";
import { refreshDynamicToolsForSession } from "./tooling/dynamic-tool-refresh.js";

export { buildCallCenterHandoffHeaders } from "./tooling/handoff.js";
export {
  getBaseUrlForOfficePhone,
  lookupByPhone,
} from "./tooling/advancedmd-client.js";
export { resolveKnowledgeFileForOffice } from "./tooling/knowledge.js";
export type {
  CallerMatch,
  CallerMultipleMatches,
  CallState,
  PhoneLookupResult,
  StoredAvailabilitySlot,
  StoredCallerAppointment,
} from "./tooling/call-state.js";

const appointmentKindSchema = z
  .enum(["medical", "routine_vision", "post_op"])
  .describe(
    "Required human-level appointment kind for the selected slot. Use post_op only for recent surgery follow-up.",
  );

type AppointmentKind = "medical" | "routine_vision" | "post_op";

const addPatientParameters = z.object({
  firstName: z.string().describe("Patient's first name"),
  lastName: z.string().describe("Patient's last name"),
  dob: z.string().describe("Date of birth in MM/DD/YYYY format"),
  phone: z
    .string()
    .optional()
    .describe(
      "Cell phone number, 10 digits only. Omit if the caller confirms the number they're calling from is the best number on file",
    ),
  email: z.string().optional().describe("Email address, if the caller has one"),
  street: z.string().describe("Street address"),
  aptSuite: z
    .string()
    .default("")
    .describe("Apartment or suite number, empty string if none"),
  city: z.string().describe("City"),
  state: z.string().describe("State, 2-letter abbreviation"),
  zip: z.string().describe("Zip code"),
  sex: z.enum(["male", "female"]).describe("Patient's sex"),
  insurance: z.string().describe("Insurance carrier name"),
  subscriberName: z
    .string()
    .describe(
      "Name of the person on the insurance policy; for self-pay, use the patient name",
    ),
  subscriberNum: z
    .string()
    .describe(
      "Insurance subscriber/member ID number; for self-pay, use self pay",
    ),
});

const updateInsuranceParameters = z.object({
  insurance: z.string().describe("New insurance plan name"),
  subscriberName: z
    .string()
    .describe("Name on the insurance card; for self-pay, use the patient name"),
  subscriberNum: z
    .string()
    .describe("Member/subscriber ID from the card; for self-pay, use self pay"),
});

// Per-call state lives on session.userData so concurrent calls don't collide
function getState(ctx: voice.RunContext): CallState {
  return ctx.session.userData as CallState;
}

function evaluatePolicyForState(
  state: CallState,
  toolName: GuardedToolName,
  args?: unknown,
  options: {
    booking?: Parameters<typeof evaluateFlowToolPolicy>[0]["booking"];
  } = {},
): ToolOutcome | null {
  if (!isFlowHarnessEnabled(state)) return null;
  syncSessionPatientFromActiveFlow(state);
  const decision = evaluateFlowToolPolicy({
    flow: state.flow,
    toolName,
    args,
    stateFacts: {
      checkedInsurancePlan: state.checkedInsurancePlan,
      checkedInsuranceCoverageType: state.checkedInsuranceCoverageType,
      patientId: state.patientId,
      lastAvailabilityRouting: state.lastAvailabilityRouting,
      officeKey: state.officeKey,
    },
    booking: options.booking,
  });
  const { observation } = decision;
  state.flowGuardObservations.push(observation);
  reduceFlowEvent(state.flow, {
    id: nextFlowEventId("tool_guard"),
    type: "tool_guard_observed",
    source: "policy",
    createdAt: Date.now(),
    toolName,
    argsHash: observation.argsHash,
    guardAllowed: decision.allowed,
  });
  if (!observation.allowed || !decision.allowed) {
    console.log(
      `[flow-policy] ${decision.allowed ? "report_only" : "blocked"} ${JSON.stringify(
        {
          toolName: observation.toolName,
          argsHash: observation.argsHash,
          reason: observation.reason,
          activeFlow: observation.activeFlow,
          activeIntent: observation.activeIntent,
          step: observation.step,
          patientStatus: observation.patientStatus,
          visitType: observation.visitType,
          officeKey: observation.officeKey,
        },
      )}`,
    );
  }
  if (!decision.outcome) return null;
  return withToolFacts(decision.outcome, state);
}

function isFlowHarnessEnabled(state: Pick<CallState, "flowHarnessEnabled">) {
  return state.flowHarnessEnabled === true;
}

function restoreConfirmedPreCallCaller(state: CallState): void {
  if (!isFlowHarnessEnabled(state)) return;
  const preCall = state.flow.preCall;
  if (
    preCall?.status !== "single_match_confirmed" &&
    preCall?.status !== "multiple_match_confirmed"
  ) {
    return;
  }
  const selectedRef = preCall.selectedCandidateRef ?? DEFAULT_PATIENT_REF;
  if (!state.flow.patients[selectedRef]?.patientId) return;

  reduceFlowEvent(state.flow, {
    id: nextFlowEventId("confirmed_pre_call"),
    type: "confirmed_pre_call_caller_restored",
    source: "system",
    createdAt: Date.now(),
  });
  syncSessionPatientFromActiveFlow(state);
}

function isSideEffectToolName(
  toolName: GuardedToolName,
): toolName is SideEffectToolName {
  return (
    toolName === "add_patient" ||
    toolName === "cancel_appt" ||
    toolName === "update_insurance" ||
    toolName === "route_to_spring_hill" ||
    toolName === "transfer_call"
  );
}

function evaluatePatientNoteGrounding(
  state: CallState,
  appointmentReason: string,
  referringDoctor: string,
): ToolOutcome | null {
  if (!isFlowHarnessEnabled(state)) return null;
  const goal = state.flow.schedulingGoal;
  if (!goal) return null;

  const expectedReason = goal.noteDraft?.appointmentReason ?? goal.visitReason;
  const expectedReferrer = goal.noteDraft?.referringDoctor;
  const referrerIsNone = normalizeNoteValue(referringDoctor) === "none";
  const reasonMatches = expectedReason
    ? noteValuesMatch(appointmentReason, expectedReason)
    : false;
  const referrerMatches = expectedReferrer
    ? noteValuesMatch(referringDoctor, expectedReferrer)
    : referrerIsNone;

  if (reasonMatches && referrerMatches) {
    return null;
  }

  return toolOutcome(
    "not_allowed",
    "collect_visit_reason",
    'Save the patient note only after the caller explicitly states the appointment reason and referring doctor. If there is no referring doctor, use "none".',
    {
      reason: "note_requires_grounded_details",
      hasExpectedReason: Boolean(expectedReason),
      hasExpectedReferrer: Boolean(expectedReferrer),
    },
    true,
  );
}

function resolveBookingNoteMetadata(
  state: CallState,
  appointmentReason: string,
  referringDoctor: string,
):
  | {
      appointmentReason: string;
      referringDoctor: string;
    }
  | ToolOutcome {
  const stateReason =
    state.flow.schedulingGoal?.noteDraft?.appointmentReason ??
    state.flow.schedulingGoal?.visitReason;
  const trimmedReason = appointmentReason.trim();
  const trimmedReferrer = referringDoctor.trim();
  const hasMeaningfulReason =
    trimmedReason.length > 0 && !isGenericBookingReason(trimmedReason);

  if (!hasMeaningfulReason && !stateReason) {
    return toolOutcome(
      "needs_clarification",
      "collect_visit_reason",
      "Ask for the appointment reason before booking.",
      {
        reason: "booking_note_metadata_missing",
        missingFacts: ["appointmentReason"],
      },
      true,
    );
  }

  if (!trimmedReferrer) {
    return toolOutcome(
      "needs_clarification",
      "collect_visit_reason",
      "Ask who referred them, or whether there is no referring doctor. Do not ask for surgery details; the appointment reason is already known.",
      {
        reason: "booking_note_metadata_missing",
        missingFacts: ["referringDoctor"],
      },
      true,
    );
  }

  return {
    appointmentReason: hasMeaningfulReason ? trimmedReason : stateReason!,
    referringDoctor: trimmedReferrer,
  };
}

function isGenericBookingReason(value: string): boolean {
  return /^(appointment|appt|visit|office visit|booking)$/i.test(value.trim());
}

function noteValuesMatch(actual: string, expected: string): boolean {
  return normalizeNoteValue(actual) === normalizeNoteValue(expected);
}

function normalizeNoteValue(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function withToolFacts(outcome: ToolOutcome, state: CallState): ToolOutcome {
  const reason = outcome.facts?.reason;
  if (
    reason === "availability_duplicate_search_signature" ||
    reason === "availability_search_budget_exhausted"
  ) {
    return {
      ...outcome,
      facts: {
        ...outcome.facts,
        cachedSlots: publicAvailabilitySlots(state.lastAvailabilitySlots),
      },
    };
  }
  return outcome;
}

function pendingSideEffectLookup(
  state: CallState,
  toolName: SideEffectToolName,
  args: unknown,
) {
  const actionType = sideEffectActionTypeForTool(toolName);
  const appointmentId =
    args && typeof args === "object" && !Array.isArray(args)
      ? (args as { appointmentId?: unknown }).appointmentId
      : undefined;
  return {
    type: actionType,
    argsHash: hashToolArgs(args ?? {}),
    patientRef: state.flow.activePatientRef,
    ...(typeof appointmentId === "number" ? { appointmentId } : {}),
  };
}

function recordSideEffectConfirmationRequestFromToolCall(
  state: CallState,
  toolName: GuardedToolName,
  args: unknown,
  policyResponse: ToolOutcome,
  toolCallId: string,
): ToolOutcome {
  if (!isSideEffectToolName(toolName)) return policyResponse;
  if (toolName !== "add_patient" && toolName !== "update_insurance") {
    return policyResponse;
  }
  const reason = policyResponse.facts?.reason;
  if (
    reason !== "side_effect_confirmation_required" &&
    reason !== "cancel_confirmation_not_tracked"
  ) {
    return policyResponse;
  }

  const sideEffectArgs = args ?? {};
  const requiredFieldsComplete = toolName === "add_patient" ? true : undefined;

  reduceFlowEvent(state.flow, {
    id: nextFlowEventId("side_effect_confirmation"),
    type: "side_effect_confirmation_requested",
    source: "tool_result",
    createdAt: Date.now(),
    toolName,
    argsHash: hashToolArgs(sideEffectArgs),
    spokenSummary: defaultSideEffectSummary(toolName),
    patientRef: state.flow.activePatientRef,
    ...(requiredFieldsComplete !== undefined ? { requiredFieldsComplete } : {}),
    toolCallId,
  });

  return {
    ...policyResponse,
    facts: {
      ...policyResponse.facts,
      confirmationRecorded: "pending",
    },
  };
}

function defaultSideEffectSummary(toolName: SideEffectToolName): string {
  switch (toolName) {
    case "add_patient":
      return "Create the confirmed patient registration.";
    case "cancel_appt":
      return "Cancel the confirmed appointment.";
    case "route_to_spring_hill":
      return "Switch the active scheduling office to Spring Hill.";
    case "transfer_call":
      return "Transfer the caller to the office.";
    case "update_insurance":
      return "Submit the confirmed insurance update.";
  }
}

function recordSideEffectToolSucceeded(
  state: CallState,
  toolName: SideEffectToolName,
  args: unknown,
  outputClass = `${toolName}_succeeded`,
  facts: Record<string, unknown> = {},
): void {
  const lookup = pendingSideEffectLookup(state, toolName, args);
  reduceFlowEvent(state.flow, {
    id: nextFlowEventId("tool_succeeded"),
    type: "tool_succeeded",
    source: "tool_result",
    createdAt: Date.now(),
    toolName,
    outputClass,
    argsHash: lookup.argsHash,
    patientRef: lookup.patientRef,
    ...(typeof lookup.appointmentId === "number"
      ? { appointmentId: lookup.appointmentId }
      : {}),
    facts,
  });
}

function apiResultLooksSuccessful(result: unknown): boolean {
  if (!isRecord(result)) return true;
  const status =
    typeof result.status === "string" ? result.status.toLowerCase() : "";
  const outcome =
    typeof result.outcome === "string" ? result.outcome.toLowerCase() : "";
  const text = `${status} ${outcome}`;
  return (
    !text.includes("error") &&
    !text.includes("fail") &&
    !text.includes("not_found") &&
    !text.includes("not found")
  );
}

function hasSuccessfulBookingForActivePatient(state: CallState): boolean {
  const activePatientRef = state.flow.activePatientRef ?? "caller";
  return state.flow.pendingActions.some(
    (action) =>
      action.type === "book_appt" &&
      action.patientRef === activePatientRef &&
      action.consumed,
  );
}

function cancellationFailureReason(result: unknown): string {
  if (!isRecord(result)) return "cancel_failed";
  const status =
    typeof result.status === "string" ? result.status.toLowerCase() : "";
  const outcome =
    typeof result.outcome === "string" ? result.outcome.toLowerCase() : "";
  const message =
    typeof result.message === "string" ? result.message.toLowerCase() : "";
  const text = `${status} ${outcome} ${message}`;
  if (text.includes("already") && text.includes("cancel")) {
    return "appointment_already_cancelled";
  }
  if (
    text.includes("not found") ||
    text.includes("not_found") ||
    text.includes("missing appointment")
  ) {
    return "appointment_not_found";
  }
  if (text.includes("canceltoken") || text.includes("cancel token")) {
    return "cancel_token_invalid";
  }
  if (status === "error") return "middleware_error";
  return "cancel_failed";
}

function toolOutcome(
  outcome: ToolOutcome["outcome"],
  nextStep: ToolOutcome["nextStep"],
  speak: string,
  facts: Record<string, unknown> = {},
  retryable = false,
): ToolOutcome {
  return {
    outcome,
    nextStep,
    speak,
    facts,
    retryable,
  };
}

export function makeCurrentSpeechUninterruptible(
  ctx: Pick<voice.RunContext, "speechHandle">,
): boolean {
  try {
    ctx.speechHandle.allowInterruptions = false;
    return true;
  } catch (err) {
    console.warn("[tools] Could not make current speech uninterruptible:", err);
    return false;
  }
}

export function getSpringHillOfficePhone(): string {
  return SPRING_HILL_OFFICE_PHONE;
}

export function getAmdOfficeForToolCall(
  state: Pick<CallState, "officeKey" | "amdOfficePhone">,
): string {
  return (
    state.amdOfficePhone || getOfficeConfig(state.officeKey).amdOfficePhone
  );
}

/** Apply patient data from an API response, resetting all patient fields so nothing stale lingers. */
function applyPatientResult(state: CallState, result: any): void {
  const extractedAppointments = extractAppointments(result);
  const appointmentsStatus = appointmentStatusFromResult(
    result,
    extractedAppointments,
  );
  applyPatientPayloadToState(state, {
    status: result.status ?? null,
    patientId: result.patientId ?? null,
    name: result.name ?? null,
    dob: result.dob ?? null,
    phone: result.phone ?? null,
    insuranceCarrier: result.insuranceCarrier ?? null,
    insPlanId: result.insPlanId ?? null,
    respPartyId: result.respPartyId ?? null,
    routing: result.routing ?? null,
    allowedProviders: Array.isArray(result.allowedProviders)
      ? result.allowedProviders
      : [],
    routingAmbiguous: result.routingAmbiguous ?? false,
    preauthRequired: result.preauthRequired ?? false,
    appointmentsStatus,
    rawAppointments: extractedAppointments ?? [],
  });
}

type PatientResolveArgs = {
  firstName?: string;
  lastName?: string;
  dob?: string;
};

type BuiltPatientResolveRequest = {
  body: Record<string, unknown>;
  callerPhone: string | null;
  usesCallerPhone: boolean;
  usesFullIdentity: boolean;
};

type AvailabilityLookupArgs = {
  date?: string;
};

type BuiltAvailabilityLookupRequest = {
  body: Record<string, unknown>;
  date: string;
  routing: string | null;
};

function confirmPendingPreCallCallerFromVerifyArgs(
  state: CallState,
  args: PatientResolveArgs,
): void {
  if (!isFlowHarnessEnabled(state) || !args.firstName) return;
  const preCall = state.flow.preCall;
  if (preCall?.status !== "single_match_pending_confirmation") return;
  if (preCall.candidates.length !== 1) return;
  const [candidate] = preCall.candidates;
  if (candidate?.ref !== DEFAULT_PATIENT_REF) return;
  if (
    identityArgConflicts(candidate.lastName, args.lastName) ||
    identityArgConflicts(candidate.dob, args.dob)
  ) {
    return;
  }

  reduceFlowEvent(state.flow, {
    id: nextFlowEventId("pre_call_identity"),
    type: "pre_call_identity_observed",
    source: "tool_result",
    createdAt: Date.now(),
    transcript: args.firstName,
  });
}

function identityArgConflicts(
  existing: string | undefined,
  next: string | undefined,
): boolean {
  if (!existing || !next) return false;
  return normalizeIdentityValue(existing) !== normalizeIdentityValue(next);
}

type PatientStatePayload = {
  status?: string | null;
  patientId?: string | null;
  name?: string | null;
  dob?: string | null;
  phone?: string | null;
  insuranceCarrier?: string | null;
  insPlanId?: string | null;
  respPartyId?: string | null;
  routing?: string | null;
  allowedProviders?: string[];
  routingAmbiguous?: boolean;
  preauthRequired?: boolean;
  appointmentsStatus?: AppointmentLoadStatus | null;
  rawAppointments?: StoredCallerAppointment[] | null;
};

function buildPatientResolveRequest(
  state: CallState,
  args: PatientResolveArgs,
): BuiltPatientResolveRequest {
  const callerPhone = state.callerPhone?.trim() || null;
  const usesFullIdentity = Boolean(args.lastName && args.dob);
  const usesCallerPhone = Boolean(
    callerPhone && args.firstName && !usesFullIdentity,
  );
  const body: Record<string, unknown> = {};
  if (args.firstName) body.firstName = args.firstName;
  if (args.lastName) body.lastName = args.lastName;
  if (args.dob) body.dob = args.dob;
  if (usesCallerPhone && callerPhone) body.phone = callerPhone;
  return { body, callerPhone, usesCallerPhone, usesFullIdentity };
}

async function resolvePatientForCall(
  state: CallState,
  request: BuiltPatientResolveRequest,
): Promise<PatientResolveResult> {
  ensureRoutineVisionOffice(state);
  return resolvePatientByOffice(getAmdOfficeForToolCall(state), request.body, {
    fallbackPhone: request.usesCallerPhone ? request.callerPhone : null,
  });
}

function applyResolvedPatientToState(
  state: CallState,
  result: PatientResolveVerified,
): void {
  applyPatientPayloadToState(state, {
    status: result.status,
    patientId: result.patientId,
    name: result.name,
    dob: result.dob,
    phone: result.phone,
    insuranceCarrier: result.insuranceCarrier,
    insPlanId: result.insPlanId,
    respPartyId: result.respPartyId,
    routing: result.routing,
    allowedProviders: result.allowedProviders,
    routingAmbiguous: result.routingAmbiguous,
    preauthRequired: result.preauthRequired,
    appointmentsStatus: result.appointmentsStatus,
    rawAppointments: result.appointments,
  });
}

function publicPatientResolveResult(
  result: PatientResolveResult,
  request?: Pick<BuiltPatientResolveRequest, "usesFullIdentity">,
) {
  if (result.status === "verified") {
    return {
      status: "verified",
      patient: {
        id: result.patientId,
        name: result.name,
        dob: result.dob,
        insuranceCarrier: result.insuranceCarrier,
        routing: result.routing,
        routingAmbiguous: result.routingAmbiguous,
        preauthRequired: result.preauthRequired,
      },
      appointments: {
        status: result.appointmentsStatus,
        ...(result.appointmentsMessage
          ? { message: result.appointmentsMessage }
          : {}),
        items: publicCallerAppointments(result.appointments),
      },
      next: "continue",
    };
  }
  if (result.status === "multiple_matches") {
    return {
      status: "multiple_matches",
      message: result.message,
      matches: result.matches.flatMap(publicMultiplePatientMatch),
      next: "ask_first_name",
    };
  }
  if (result.status === "not_found") {
    return {
      status: "not_found",
      message: result.message,
      next: request?.usesFullIdentity
        ? "ask_spelled_name_or_register"
        : "ask_last_name_and_dob",
    };
  }
  return {
    status: "error",
    message: result.message,
    next: "retry",
  };
}

function publicMultiplePatientMatch(
  match: Extract<
    PatientResolveResult,
    { status: "multiple_matches" }
  >["matches"][number],
): Array<{ firstName: string }> {
  if ("firstName" in match && match.firstName) {
    return [{ firstName: match.firstName }];
  }
  if (!("status" in match)) return [];
  const firstName = firstNameFromPatientName(match.name);
  return firstName ? [{ firstName }] : [];
}

function firstNameFromPatientName(name: string | null): string | undefined {
  if (!name) return undefined;
  const [, firstAndMiddle] = name
    .split(",", 2)
    .map((part) => part.trim())
    .filter(Boolean);
  if (firstAndMiddle) return firstAndMiddle.split(/\s+/).filter(Boolean)[0];
  return name.trim().split(/\s+/).filter(Boolean)[0];
}

function applyPatientPayloadToState(
  state: CallState,
  payload: PatientStatePayload,
): void {
  const rawAppointments = payload.rawAppointments ?? [];
  const appointments = publicCallerAppointments(rawAppointments);
  const patientRecord = reduceFlowEvent(state.flow, {
    id: nextFlowEventId("patient_recorded"),
    type: "patient_recorded",
    source: "tool_result",
    createdAt: Date.now(),
    patientId: payload.patientId ?? null,
    patientName: payload.name ?? null,
    dob: payload.dob ?? null,
    phone: payload.phone ?? null,
    appointments,
    appointmentsStatus: payload.appointmentsStatus ?? null,
  });
  const patientChange = patientRecord.patientChange;
  if (!patientChange) {
    throw new Error("patient_recorded event did not produce a patient change");
  }
  const invalidatePatientState = shouldInvalidatePatientScopedState(
    state,
    payload,
    patientChange.switchedPatient,
  );

  state.patientId = payload.patientId ?? null;
  state.patientName = payload.name ?? null;
  state.dob = payload.dob ?? null;
  state.insuranceCarrier = payload.insuranceCarrier ?? null;
  state.insPlanId = payload.insPlanId ?? null;
  state.respPartyId = payload.respPartyId ?? null;
  state.checkedInsurancePlan = payload.insuranceCarrier ?? null;
  state.checkedInsuranceCoverageType =
    payload.routing === "optical_only" ? "routine_vision" : null;
  state.routing = payload.routing ?? null;
  if (invalidatePatientState) {
    clearAvailabilitySelection(state, "patient_changed");
  }
  state.allowedProviders = payload.allowedProviders ?? [];
  state.routingAmbiguous = payload.routingAmbiguous ?? false;
  state.preauthRequired = payload.preauthRequired ?? false;
  state.appointmentsStatus = payload.appointmentsStatus ?? null;
  state.appointments = appointments;
  state.appointmentCancelTokens = appointmentCancelTokenMap(rawAppointments);
  reduceFlowEvent(state.flow, {
    id: nextFlowEventId("patient_payload"),
    type: "patient_payload_applied",
    source: "tool_result",
    createdAt: Date.now(),
    patientStatus:
      String(payload.status ?? "").toLowerCase() === "created"
        ? "created"
        : undefined,
    officeKey: state.officeKey,
    routing: normalizeSchedulingRouting(state.routing),
    coverageType: state.checkedInsuranceCoverageType ?? undefined,
    visitType:
      state.checkedInsuranceCoverageType === "routine_vision"
        ? "routine_vision"
        : undefined,
    insurance:
      state.insuranceCarrier || state.checkedInsurancePlan
        ? {
            plan: state.insuranceCarrier ?? state.checkedInsurancePlan,
            coverageType: state.checkedInsuranceCoverageType,
            canonicalPlan: state.checkedInsurancePlan ?? state.insuranceCarrier,
          }
        : undefined,
  });
}

function shouldInvalidatePatientScopedState(
  state: CallState,
  result: {
    patientId?: string | null;
    name?: string | null;
    dob?: string | null;
  },
  switchedPatient: boolean,
): boolean {
  return (
    switchedPatient ||
    changedKnownIdentityValue(state.patientId, result.patientId ?? null) ||
    changedKnownIdentityValue(state.patientName, result.name ?? null) ||
    changedKnownIdentityValue(state.dob, result.dob ?? null)
  );
}

function changedKnownIdentityValue(
  previous: string | null | undefined,
  next: string | null | undefined,
): boolean {
  const normalizedPrevious = normalizeIdentityValue(previous);
  const normalizedNext = normalizeIdentityValue(next);
  return Boolean(
    normalizedPrevious &&
    normalizedNext &&
    normalizedPrevious !== normalizedNext,
  );
}

function normalizeIdentityValue(value: string | null | undefined): string {
  return value?.trim().toLowerCase().replace(/\s+/g, " ") ?? "";
}

function formatPatientName(
  firstName: string | undefined,
  lastName: string | undefined,
): string | null {
  const fullName = [firstName, lastName]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(" ");
  return fullName || null;
}

function clearSessionPatientRecord(
  state: CallState,
  next: { patientName?: string | null; dob?: string | null } = {},
): void {
  state.patientId = null;
  state.patientName = next.patientName ?? null;
  state.dob = next.dob ?? null;
  state.insuranceCarrier = null;
  state.insPlanId = null;
  state.respPartyId = null;
  state.checkedInsurancePlan = null;
  state.checkedInsuranceCoverageType = null;
  state.routing = null;
  state.allowedProviders = [];
  state.routingAmbiguous = false;
  state.preauthRequired = false;
  state.appointmentsStatus = null;
  state.appointments = [];
  state.appointmentCancelTokens = {};
  reduceFlowEvent(state.flow, {
    id: nextFlowEventId("patient_session_cleared"),
    type: "patient_session_cleared",
    source: "system",
    createdAt: Date.now(),
  });
}

function syncSessionPatientFromActiveFlow(state: CallState): void {
  const patient = ensureActivePatientContext(state.flow);
  state.patientId = patient.patientId ?? null;
  state.patientName = formatPatientName(
    patient.firstName?.value,
    patient.lastName?.value,
  );
  state.dob = patient.dob?.value ?? null;
  state.appointments = [...patient.appointments];
  state.appointmentsStatus = patient.appointmentsStatus ?? null;
  if (state.flow.patientStatus !== patient.status) {
    reduceFlowEvent(state.flow, {
      id: nextFlowEventId("active_patient_status"),
      type: "active_patient_status_synced",
      source: "system",
      createdAt: Date.now(),
      patientStatus: patient.status,
    });
  }

  if (patient.insurance) {
    state.insuranceCarrier =
      patient.insurance.canonicalPlan ??
      patient.insurance.plan?.value ??
      state.insuranceCarrier;
    state.checkedInsurancePlan =
      patient.insurance.canonicalPlan ??
      patient.insurance.plan?.value ??
      state.checkedInsurancePlan;
    state.checkedInsuranceCoverageType =
      patient.insurance.coverageType ?? state.checkedInsuranceCoverageType;
  }
}

function routingForAvailability(state: CallState): string | null {
  if (state.checkedInsuranceCoverageType === "routine_vision") {
    return "optical_only";
  }
  return state.routing;
}

function buildAvailabilityLookupRequestForState(
  state: CallState,
  args: AvailabilityLookupArgs,
): BuiltAvailabilityLookupRequest | ToolOutcome {
  const date = args.date?.trim();
  if (!date) {
    return toolOutcome(
      "needs_clarification",
      "get_availability",
      "Ask what date or starting day the caller wants before checking availability.",
      { reason: "availability_requires_date" },
      true,
    );
  }

  ensureAvailabilityVisitContext(state);
  const policyRouting = routingForAvailability(state);
  const policyResponse = evaluatePolicyForState(state, "get_availability", {
    date,
    ...(policyRouting ? { routing: policyRouting } : {}),
  });
  if (policyResponse) return policyResponse;

  ensureRoutineVisionOffice(state);
  const effectiveRouting = routingForAvailability(state);
  const body: Record<string, unknown> = { date };
  if (state.dob) body.dob = state.dob;
  if (effectiveRouting) body.routing = effectiveRouting;
  if (state.preauthRequired) body.preauthRequired = true;
  return { body, date, routing: effectiveRouting };
}

function appointmentIntentForBooking(
  state: CallState,
  routing: string | null,
  appointmentKind?: AppointmentKind,
): Record<string, unknown> {
  const visitKind = inferAppointmentKindForBooking(
    state,
    routing,
    appointmentKind,
  );
  const visitCategory =
    visitKind === "routine_vision" ? "routine_vision" : "medical";
  const visitReason = state.flow.schedulingGoal?.visitReason?.trim();

  return {
    visitCategory,
    visitKind,
    patientStatus: patientStatusForAppointmentIntent(state),
    ...(visitKind === "post_op" ? { isPostOp: true } : {}),
    ...(visitReason ? { visitReason } : {}),
  };
}

function inferAppointmentKindForBooking(
  state: CallState,
  routing: string | null,
  appointmentKind?: AppointmentKind,
): AppointmentKind {
  if (appointmentKind) return appointmentKind;
  if (
    routing === "optical_only" ||
    state.checkedInsuranceCoverageType === "routine_vision" ||
    state.flow.visitType === "routine_vision" ||
    state.flow.schedulingGoal?.visitType === "routine_vision"
  ) {
    return "routine_vision";
  }
  if (looksLikePostOpVisit(state.flow.schedulingGoal?.visitReason)) {
    return "post_op";
  }
  return "medical";
}

function patientStatusForAppointmentIntent(
  state: CallState,
): "new" | "established" {
  return state.flow.patientStatus === "created" ||
    state.flow.patientStatus === "new"
    ? "new"
    : "established";
}

function looksLikePostOpVisit(visitReason: string | undefined): boolean {
  const normalized = visitReason?.trim().toLowerCase() ?? "";
  return /\bpost\s*-?\s*op\b|\bpost\s+operative\b|\bpostoperative\b|\bsurgery\s+follow\s*-?\s*up\b|\brecent\s+surgery\b/.test(
    normalized,
  );
}

function appointmentTypeMissingFacts(
  result: Record<string, unknown>,
): string[] {
  return Array.isArray(result.missing)
    ? result.missing.filter((item): item is string => typeof item === "string")
    : [];
}

function nextStepForAppointmentTypeUnresolved(
  missing: string[],
): ToolOutcome["nextStep"] {
  if (missing.includes("routeToSpringHill") || missing.includes("routing")) {
    return "route_office";
  }
  if (missing.includes("patientStatus") || missing.includes("dob")) {
    return "verify_patient";
  }
  return "collect_visit_reason";
}

function clearAvailabilitySelection(
  state: CallState,
  invalidationReason?: AvailabilityInvalidationReason,
): void {
  clearAvailabilitySlots(state);
  state.lastAvailabilityRouting = null;
  if (invalidationReason) {
    reduceFlowEvent(state.flow, {
      id: nextFlowEventId("availability_invalidated"),
      type: "availability_invalidated",
      source: "system",
      createdAt: Date.now(),
      reason: invalidationReason,
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function updateCurrentTaskStep(
  state: CallState,
  nextStep: ToolOutcome["nextStep"],
  activeFlow?: CallState["flow"]["activeFlow"],
): void {
  reduceFlowEvent(state.flow, {
    id: nextFlowEventId("workflow_step"),
    type: "workflow_step_updated",
    source: "system",
    createdAt: Date.now(),
    step: nextStep,
    ...(activeFlow ? { activeFlow } : {}),
  });
}

function normalizeInsuranceOutcome(
  state: CallState,
  response: InsuranceToolResponse,
): InsuranceToolResponse & ToolOutcome {
  const routeRequired =
    Boolean(response.routeTool) || state.flow.step === "route_office";
  const routeTool =
    response.routeTool ?? (routeRequired ? "route_to_spring_hill" : undefined);
  const outcome: ToolOutcome["outcome"] = routeRequired
    ? "route_required"
    : response.status === "accepted" && response.canProceed
      ? "success"
      : response.status === "needs_clarification"
        ? "needs_clarification"
        : "not_allowed";
  if (routeRequired) {
    updateCurrentTaskStep(state, "route_office", "routing");
  }

  return {
    ...response,
    ...(routeTool ? { routeTool } : {}),
    outcome,
    nextStep: routeRequired ? "route_office" : state.flow.step,
    speak: response.callerMessage,
    facts: {
      status: response.status,
      canProceed: response.canProceed,
      canonicalPlan: response.canonicalPlan,
      clarificationNeeded: response.clarificationNeeded,
      acceptedAtAlternateOffice: response.acceptedAtAlternateOffice,
      alternateCanonicalPlan: response.alternateCanonicalPlan,
      routeTool,
    },
    retryable: outcome !== "success",
  };
}

function bookingTokenForSelectedSlot(
  state: CallState,
  selectedSlot: StoredAvailabilitySlot,
): string | ToolOutcome {
  const bookingToken = selectedSlot.bookingToken?.trim();
  if (bookingToken) return bookingToken;
  clearAvailabilitySelection(state);
  return toolOutcome(
    "not_allowed",
    "get_availability",
    "That cached slot is missing a signed booking token. Search availability again and choose one of the returned slots.",
    {
      reason: "booking_requires_booking_token",
      slotId: selectedSlot.slotId,
    },
    true,
  );
}

function activeReschedulePlan(state: CallState) {
  const planId = state.flow.activeTaskPlanId;
  const plan = planId ? state.flow.taskPlans?.[planId] : undefined;
  return plan?.kind === "appointment_reschedule" ? plan : undefined;
}

function markRescheduleReplacementBooked(
  state: CallState,
  result: unknown,
): boolean {
  const plan = activeReschedulePlan(state);
  if (!plan || typeof plan.targetAppointmentId !== "number") return false;
  const replacementBookedAppointmentId = appointmentIdFromBookingResult(result);
  if (replacementBookedAppointmentId === null) return false;
  return (
    reduceFlowEvent(state.flow, {
      id: nextFlowEventId("reschedule_replacement_booked"),
      type: "reschedule_replacement_booked",
      source: "tool_result",
      createdAt: Date.now(),
      replacementBookedAppointmentId,
    }).rescheduleProgressed === true
  );
}

function markRescheduleOldAppointmentCancelled(
  state: CallState,
  appointmentId: number,
): boolean {
  const plan = activeReschedulePlan(state);
  if (!plan || plan.targetAppointmentId !== appointmentId) return false;
  return (
    reduceFlowEvent(state.flow, {
      id: nextFlowEventId("reschedule_old_cancelled"),
      type: "reschedule_old_appointment_cancelled",
      source: "tool_result",
      createdAt: Date.now(),
      appointmentId,
    }).rescheduleProgressed === true
  );
}

function ensureRoutineVisionOffice(state: CallState): void {
  if (state.checkedInsuranceCoverageType !== "routine_vision") return;
  if (!getOfficeConfig(state.officeKey).features.routeRoutineVisionToSpringHill)
    return;
  clearAvailabilitySelection(state, "office_changed");
  state.officeKey = "spring-hill";
  state.amdOfficePhone = getSpringHillOfficePhone();
  reduceFlowEvent(state.flow, {
    id: nextFlowEventId("routine_vision_office"),
    type: "routine_vision_office_ensured",
    source: "system",
    createdAt: Date.now(),
    officeKey: "spring-hill",
  });
}

function ensureAvailabilityVisitContext(state: CallState): void {
  if (state.flow.visitType) return;

  const knownCoverageType =
    state.flow.coverageType ?? state.checkedInsuranceCoverageType;
  const inferredVisitType =
    state.flow.schedulingGoal?.visitType ??
    classifyVisitType(state.flow.schedulingGoal?.visitReason);

  const visitType =
    inferredVisitType ??
    (knownCoverageType === "routine_vision" || state.routing === "optical_only"
      ? "routine_vision"
      : "medical");

  reduceFlowEvent(state.flow, {
    id: nextFlowEventId("availability_visit_context"),
    type: "availability_visit_context_ensured",
    source: "system",
    createdAt: Date.now(),
    visitType,
  });
}

function compactTurnCommandResponse(turn: FlowTurnAdvanceResult) {
  if (turn.workflowCommand?.commandSource === "task_plan") {
    const command = turn.workflowCommand;
    const compact = compactWorkflowCommand(command);
    return {
      status: "recorded",
      task: compact.task,
      taskId: compact.taskId,
      phase: compact.phase,
      missingFacts: compact.missingFacts,
      nextAction: compact.nextAction,
      ...(turn.update?.pathFactsChanged ? { factsChanged: true } : {}),
      action:
        command.nextAction === "call_tool"
          ? "call_tool"
          : command.nextAction === "respond"
            ? "respond"
            : command.nextAction,
      ...(command.tool ? { tool: command.tool } : {}),
      ...(command.args ? { args: command.args } : {}),
      ...(compact.suggestedTool
        ? { suggestedTool: compact.suggestedTool }
        : {}),
      blockedSideEffects: compact.blockedSideEffects,
      instruction: command.instruction,
    };
  }

  const base = {
    status: "recorded",
    nextAction: turn.nextAction,
    ...(turn.update?.pathFactsChanged ? { factsChanged: true } : {}),
  };

  switch (turn.action) {
    case "ask":
      return {
        ...base,
        action: "ask",
        slot: turn.slot,
        instruction: turn.instruction,
      };
    case "call_tool":
      return {
        ...base,
        action: "call_tool",
        tool: turn.tool,
        args: turn.args,
        instruction: turn.instruction,
      };
    case "confirm":
      return {
        ...base,
        action: "confirm",
        confirmation: turn.confirmationType,
        instruction: turn.instruction,
      };
    case "complete":
    case "respond":
      return {
        ...base,
        action: "respond",
        instruction: turn.instruction,
      };
  }
}

function withLatestPlannerCommand(state: CallState, result: unknown): unknown {
  if (!isFlowHarnessEnabled(state)) return result;
  if (!shouldAdvanceWorkflowAfterTool(state)) return result;
  const turn = advanceWorkflow(state.flow, { type: "facts_changed" });
  if (!turn.workflowCommand) return result;
  const planner = compactWorkflowCommand(turn.workflowCommand);
  if (isRecord(result)) {
    return {
      ...result,
      planner,
    };
  }
  return {
    result,
    planner,
  };
}

function shouldAdvanceWorkflowAfterTool(state: CallState): boolean {
  if (
    !state.flow.activeIntent &&
    !state.flow.currentTask &&
    (state.flow.activeFlow === "intro" || state.flow.activeFlow === "intent")
  ) {
    return false;
  }
  return true;
}

function advanceWorkflowAfterToolWithoutPlanner(state: CallState): void {
  if (!isFlowHarnessEnabled(state)) return;
  if (!shouldAdvanceWorkflowAfterTool(state)) return;
  advanceWorkflow(state.flow, { type: "facts_changed" });
}

// --- record_turn_understanding ---
export const record_turn_understanding = llm.tool({
  description: `Internal fallback memory update. The reducer normally records obvious caller intent before the model responds, so this tool should only be used if it is explicitly exposed and the current turn_state is missing a material caller fact.

Use it to provide the structured semantic state update for the caller's latest turn. This is not a side-effect tool and should never be mentioned to the caller.

If the caller only says a backchannel like "yes", "okay", or "mm-hmm", call this tool with goal "unclear", interruption "backchannel", and the right confidence/evidence. If a concrete workflow tool is already safe from state, the harness will allow that tool without requiring this memory update first.`,
  parameters: turnUnderstandingSchema,
  execute: async (understanding, { ctx }) => {
    const state = getState(ctx);
    makeCurrentSpeechUninterruptible(ctx);
    if (!isFlowHarnessEnabled(state)) {
      return {
        status: "disabled",
        instruction:
          "Flow harness is disabled for this trunk. Continue with the normal tool flow.",
      };
    }
    const transcript = state.latestUserTranscript?.trim() ?? "";

    if (
      transcript &&
      state.turnUnderstandingAppliedForTranscript === transcript
    ) {
      return {
        status: "already_recorded",
        nextAction: "continue",
        action: "continue",
        instruction:
          "Continue from the previous command. Do not call record_turn_understanding again for this same user turn.",
      };
    }

    const turn = advanceWorkflow(state.flow, {
      type: "caller_intent_recorded",
      transcript,
      understanding,
      source: "model_understanding",
    });
    state.turnUnderstandingAppliedForTranscript = transcript || null;
    if (turn.update) {
      state.lastTurnUnderstanding = {
        goal: turn.update.understanding.goal,
        appointmentAction: turn.update.understanding.appointmentAction,
        confidence: turn.update.understanding.confidence,
        activeIntent: state.flow.activeIntent,
        activePatientRef: state.flow.activePatientRef,
      };
    }
    await refreshDynamicToolsForSession(
      ctx.session as voice.AgentSession<CallState>,
      "turn_understanding_recorded",
    );

    return compactTurnCommandResponse(turn);
  },
});

// --- verify_patient ---
export const verify_patient = llm.tool({
  description: `Use only when the current workflow needs a verified patient for patient-specific work.

This is the existing-patient lookup tool. It verifies a patient and loads upcoming appointments in the same call.

Use for patient-specific work: appointment lookup or confirmation, booking, cancellation, reschedule, insurance update, existing-patient registration fallback, or private chart/account questions.

Do not use for quick questions, office hours or location questions, general practice policy questions, routing questions that do not require private patient data, or transfer requests.

Ask for the patient's first name first. For first-name lookup, the caller phone number is loaded from session state automatically, so do not ask the caller to repeat their phone number.

Do NOT ask for last name or DOB before the first lookup when caller phone is available. If phone + first name is not enough, ask for last name and DOB and retry; full last name + DOB lookup is not restricted to the caller phone, so it can find patients when a parent, spouse, or caregiver is calling.

Do NOT call if phone lookup already verified the patient (single match + confirmed first name). Check CALLER CONTEXT first.

After response:
- If verified: let them know and move on.
- If routingAmbiguous: ask what type of plan (regular, EPO, HMO, Medicare). If HMO, scheduling starts two weeks out due to preauth.
- If routing is "not_accepted": tell them straightforwardly.
- If not found with firstName + caller phone: ask for last name and DOB and retry with full details.
- If not found with full details: ask them to spell their name and retry with corrections.
- If still not found after retry: lead into registration — "ok no worries, let me get you set up."`,
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
    makeCurrentSpeechUninterruptible(ctx);
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
    if (
      state.flow.preCall?.status === "single_match_confirmed" ||
      state.flow.preCall?.status === "multiple_match_confirmed"
    ) {
      const preCallPolicyResponse = evaluatePolicyForState(
        state,
        "verify_patient",
        {
          firstName,
          lastName,
          dob,
        },
      );
      if (preCallPolicyResponse) return preCallPolicyResponse;
    }
    if (!firstName && !request.usesFullIdentity) {
      return toolOutcome(
        "needs_clarification",
        "verify_patient",
        "Ask for the patient's first name before verifying them, or ask for last name and date of birth if the caller is calling for someone else.",
        { reason: "patient_lookup_requires_identity" },
        true,
      );
    }
    if (!request.usesCallerPhone && !request.usesFullIdentity) {
      return toolOutcome(
        "needs_clarification",
        "verify_patient",
        "Ask for the patient's first name, or collect both last name and date of birth before verifying someone not tied to the caller phone.",
        { reason: "patient_lookup_requires_caller_phone_or_full_identity" },
        true,
      );
    }
    const policyResponse = evaluatePolicyForState(state, "verify_patient", {
      firstName,
      lastName,
      dob,
    });
    if (policyResponse) return policyResponse;
    const previousIdentity = snapshotActivePatientIdentity(state.flow);
    reduceFlowEvent(state.flow, {
      id: nextFlowEventId("patient_verification_attempt"),
      type: "patient_verification_attempted",
      source: "tool_result",
      createdAt: Date.now(),
      firstName,
      lastName,
      dob,
      phone: request.usesCallerPhone
        ? (request.callerPhone ?? undefined)
        : undefined,
    });
    const identityChanged = hasActivePatientIdentityChanged(
      state.flow,
      previousIdentity,
    );
    if (identityChanged) {
      clearAvailabilitySelection(state, "patient_changed");
      clearSessionPatientRecord(state, {
        patientName: formatPatientName(firstName, lastName),
        dob: dob ?? null,
      });
    }
    const result = await resolvePatientForCall(state, request);
    const publicResult = publicPatientResolveResult(result, request);
    if (result.status === "verified") {
      applyResolvedPatientToState(state, result);
      if (isFlowHarnessEnabled(state)) {
        advanceWorkflow(state.flow, { type: "patient_verified" });
      }
      const planned = withLatestPlannerCommand(state, publicResult);
      await refreshDynamicToolsForSession(
        ctx.session as voice.AgentSession<CallState>,
        "tools_executed",
      );
      return planned;
    }
    return publicResult;
  },
});

// --- add_patient ---
export const add_patient = llm.tool({
  description: `Creates a new patient record. Use only when verify_patient returns no match. Every submitted field must come from what the caller explicitly said — never fabricate or guess values.

Follow the registration order in the runbook. Key rules for this tool:
- Run check_insurance first. Use the canonicalPlan from the latest check_insurance result for the insurance value sent to middleware. If the tool accepted a family alias like "Blue Cross" or "Oscar", do not rewrite it yourself.
- For a new routine-vision patient, check_insurance must use coverageType "routine_vision" first. This tool will attach that coverage type and canonical vision plan to the new patient payload.
- Ask "is the number you're calling from a good one on file?" If yes, omit phone and this tool will use the inbound caller number already stored in session state. If no, collect the best 10-digit phone number and pass it explicitly.
- Email is optional. Ask once; if the caller says they do not have one, omit email and continue registration. Do not transfer just because email is missing.
- If subscriber is "me" or "mine" = use patient name.
- Member ID is required unless the caller is self-pay. For self-pay, use subscriberName as the patient name and subscriberNum "self pay". If an insured caller does not have their card, offer to hold.
- Before submitting: read back name (spell last name letter by letter), DOB, insurance plan, and member ID when applicable. Wait for confirmation, then call this tool directly. If the tool says the confirmation was interrupted, read back and confirm again before retrying.

After response: if routing "not_accepted", tell them. If preauthRequired, scheduling starts two weeks out. Go straight to scheduling — don't check appointments for a new patient.

Preauth insurances: United Healthcare HMO, Aetna HMO, Florida Blue Medicare HMO, Cigna HMO, Tricare Prime, Tricare Forever.`,
  parameters: addPatientParameters,
  execute: async (params, { ctx, toolCallId }) => {
    const state = getState(ctx);
    const speechReady = makeCurrentSpeechUninterruptible(ctx);
    if (!speechReady) {
      return toolOutcome(
        "not_allowed",
        "collect_registration",
        "Registration was interrupted before it could be submitted. Please confirm the patient details again.",
        { reason: "speech_interrupted" },
        true,
      );
    }
    const policyResponse = evaluatePolicyForState(state, "add_patient", params);
    if (policyResponse) {
      return recordSideEffectConfirmationRequestFromToolCall(
        state,
        "add_patient",
        params,
        policyResponse,
        toolCallId,
      );
    }
    const insurance = state.checkedInsurancePlan ?? params.insurance;
    const selfPay = normalizeInsuranceText(insurance) === "self pay";
    const phone = params.phone ?? state.callerPhone;
    if (!phone) {
      return toolOutcome(
        "needs_clarification",
        "collect_registration",
        "Ask whether the number they're calling from is good; if not, collect the best phone number.",
        { reason: "registration_requires_phone" },
        true,
      );
    }
    ensureRoutineVisionOffice(state);
    const payload: Record<string, unknown> = { ...params, insurance, phone };
    if (selfPay) {
      payload.subscriberNum = "self pay";
      payload.subscriberName =
        params.subscriberName || `${params.firstName} ${params.lastName}`;
    }
    if (state.checkedInsuranceCoverageType === "routine_vision") {
      payload.coverageType = "routine_vision";
    }
    if (typeof params.email === "string" && params.email.trim()) {
      payload.email = params.email.trim();
    } else {
      delete payload.email;
    }
    const result = (await callApi(
      "/api/add-patient",
      payload,
      getAmdOfficeForToolCall(state),
    )) as any;
    if (result?.patientId) {
      recordSideEffectToolSucceeded(
        state,
        "add_patient",
        params,
        "patient_added",
        {
          patientId: result.patientId,
        },
      );
      applyPatientResult(state, result);
      return result;
    }
    return result;
  },
});

// --- update_insurance ---
export const update_insurance = llm.tool({
  description: `Updates a verified patient's insurance. Requires verify_patient first. Confirm plan name and member ID with caller before calling this tool. For self-pay, do not ask for a member ID; use subscriberNum "self pay".

Run check_insurance first with medical coverage and use the canonicalPlan from the latest result for the insurance value sent to middleware. Do not use update_insurance just to schedule a routine vision appointment for an existing patient; collect/check the accepted vision coverage or self-pay option and schedule on the routine-vision lane instead.

After response: session state updates automatically. If preauthRequired, scheduling starts two weeks out. If the tool says the confirmation was interrupted, confirm the insurance details again before retrying.`,
  parameters: updateInsuranceParameters,
  execute: async (
    { insurance, subscriberName, subscriberNum },
    { ctx, toolCallId },
  ) => {
    const state = getState(ctx);
    const speechReady = makeCurrentSpeechUninterruptible(ctx);
    if (!speechReady) {
      return toolOutcome(
        "not_allowed",
        "check_insurance",
        "Insurance update was interrupted before it could be submitted. Please confirm the insurance details again.",
        { reason: "speech_interrupted" },
        true,
      );
    }
    const policyResponse = evaluatePolicyForState(state, "update_insurance", {
      insurance,
      subscriberName,
      subscriberNum,
    });
    if (policyResponse) {
      return recordSideEffectConfirmationRequestFromToolCall(
        state,
        "update_insurance",
        {
          insurance,
          subscriberName,
          subscriberNum,
        },
        policyResponse,
        toolCallId,
      );
    }
    if (!state.patientId) {
      return toolOutcome(
        "not_allowed",
        "verify_patient",
        "Verify the patient before updating insurance.",
        { reason: "update_insurance_requires_verified_patient" },
        true,
      );
    }
    const insuranceForMiddleware =
      state.checkedInsuranceCoverageType === "medical"
        ? (state.checkedInsurancePlan ?? insurance)
        : insurance;
    const subscriberNumForMiddleware =
      normalizeInsuranceText(insuranceForMiddleware) === "self pay"
        ? "self pay"
        : subscriberNum;
    const payload: Record<string, unknown> = {
      patientId: state.patientId,
      ...(state.dob ? { dob: state.dob } : {}),
      insPlanId: state.insPlanId ?? "",
      respPartyId: state.respPartyId ?? "",
      oldInsurance: state.insuranceCarrier ?? "",
      insurance: insuranceForMiddleware,
      subscriberName,
      subscriberNum: subscriberNumForMiddleware,
    };
    const result = (await callApi(
      "/api/patient/update-insurance",
      payload,
      getAmdOfficeForToolCall(state),
    )) as any;
    if (result?.status === "updated") {
      recordSideEffectToolSucceeded(
        state,
        "update_insurance",
        {
          insurance,
          subscriberName,
          subscriberNum,
        },
        "insurance_updated",
        {
          newInsurance: result.newInsurance,
          routing: result.routing,
          preauthRequired: result.preauthRequired,
        },
      );
      state.insuranceCarrier = result.newInsurance ?? state.insuranceCarrier;
      state.insPlanId = result.insPlanId ?? null;
      state.respPartyId = result.respPartyId ?? null;
      state.routing = result.routing ?? state.routing;
      state.allowedProviders =
        result.allowedProviders ?? state.allowedProviders;
      state.routingAmbiguous = result.routingAmbiguous ?? false;
      state.preauthRequired = result.preauthRequired ?? false;
      reduceFlowEvent(state.flow, {
        id: nextFlowEventId("active_patient_insurance"),
        type: "active_patient_insurance_updated",
        source: "tool_result",
        createdAt: Date.now(),
        plan: state.insuranceCarrier,
        coverageType: state.checkedInsuranceCoverageType,
        canonicalPlan: state.checkedInsurancePlan ?? state.insuranceCarrier,
      });
      clearAvailabilitySelection(state, "insurance_changed");
      updateCurrentTaskStep(
        state,
        nextPatientFlowStep(state.flow.patientStatus),
      );
      return result;
    }
    return result;
  },
});

// --- get_availability ---
export const get_availability = llm.tool({
  description: `Gets schedule availability. Requires date (YYYY-MM-DD). Routing and preauth auto-applied from session state.

Ask the caller the reason for their visit before calling this tool so the scheduling lane is right. The response is intentionally tiny: result, reply, next, slotId, searched, nextSearchDate, and slots. Use reply for the caller-facing wording. If the caller accepts, call book_appt with slotId. Never ask for or mention the booking token; it is stored internally.

The middleware resolves the AMD appointment type during booking.

Rules: no same-day appointments — earliest is tomorrow. If the caller asks for today, just let them know the earliest you can schedule is tomorrow and offer that. Don't make up a policy — just move to the next available day. Under 18 medical visits = Dr. Bach only. Bach has limited schedule — set expectations. If routing is "not_accepted", do not call. "ASAP" or "whenever" = search tomorrow.

After response: follow the reply and next fields. If result is slots_found, offer slotId first. Mention the doctor only if asked or clinically relevant. If rejected, offer another listed slot. If result is no_slots_found, do not search the same range again; ask for a different preference or use nextSearchDate.`,
  parameters: z.object({
    date: z.string().describe("Start date to search, formatted YYYY-MM-DD"),
  }),
  execute: async ({ date }, { ctx }) => {
    const state = getState(ctx);
    makeCurrentSpeechUninterruptible(ctx);
    const request = buildAvailabilityLookupRequestForState(state, { date });
    if ("outcome" in request) return request;
    updateCurrentTaskStep(state, "get_availability");
    const result = await callApi(
      "/api/scheduler/availability",
      request.body,
      getAmdOfficeForToolCall(state),
    );
    state.lastAvailabilityRouting = request.routing;
    if (!isFlowHarnessEnabled(state)) {
      return storeAvailabilitySlots(state, result, request.routing);
    }
    const availabilityRecord = recordAvailabilitySearch(state.flow, {
      patientRef: state.flow.activePatientRef,
      officeKey: state.officeKey,
      visitType: state.flow.visitType,
      coverageType: state.flow.coverageType,
      routing: request.routing,
      date: request.date,
    });
    const modelResult = storeAvailabilitySlots(state, result, request.routing);
    recordAvailabilitySearchRange(availabilityRecord.search, result);
    recordAvailabilityCachedSlots(
      state.flow,
      state.lastAvailabilitySlots.map((slot) => ({
        slotId: slot.slotId,
        datetime: slot.datetime,
        columnId: slot.columnId,
        profileId: slot.profileId,
        duration: slot.duration,
      })),
    );
    updateCurrentTaskStep(
      state,
      state.lastAvailabilitySlots.length > 0
        ? "confirm_booking"
        : "get_availability",
    );
    advanceWorkflowAfterToolWithoutPlanner(state);
    return modelResult;
  },
});

// --- cancel_appt ---
export const cancel_appt = llm.tool({
  description: `Cancels an appointment. You MUST call this tool to cancel — an appointment is not cancelled until this tool executes successfully. Never tell the caller an appointment is cancelled without calling this tool first.

Requires appointmentId — use the ID from the caller context or from a verify_patient response. Read back the details and confirm the caller wants it cancelled before calling this tool. If they want to reschedule, book the new appointment first, then cancel. If the tool says the confirmation was interrupted, confirm the cancellation again before retrying.`,
  parameters: z.object({
    appointmentId: z
      .number()
      .describe(
        "Appointment ID from caller context or verify_patient response",
      ),
  }),
  execute: async ({ appointmentId }, { ctx, toolCallId }) => {
    const state = getState(ctx);
    const speechReady = makeCurrentSpeechUninterruptible(ctx);
    if (!speechReady) {
      return toolOutcome(
        "not_allowed",
        "confirm_cancel",
        "Cancellation was interrupted before it could be submitted. Please confirm the cancellation again.",
        { reason: "speech_interrupted" },
        true,
      );
    }
    const policyResponse = evaluatePolicyForState(state, "cancel_appt", {
      appointmentId,
    });
    if (policyResponse) {
      return recordSideEffectConfirmationRequestFromToolCall(
        state,
        "cancel_appt",
        {
          appointmentId,
        },
        policyResponse,
        toolCallId,
      );
    }
    if (!state.patientId) {
      return toolOutcome(
        "not_allowed",
        "verify_patient",
        "Verify the patient before cancelling.",
        { reason: "cancel_requires_verified_or_created_patient" },
        true,
      );
    }
    let cancelToken = cancelTokenForAppointment(state, appointmentId);
    if (!cancelToken && activeAppointmentById(state, appointmentId)) {
      cancelToken = await refreshCancelTokenForAppointment(
        state,
        appointmentId,
      );
    }
    if (!cancelToken) {
      return toolOutcome(
        "not_allowed",
        "confirm_cancel",
        "Load the patient's appointments again, read back the exact appointment, and confirm before cancelling.",
        {
          reason: "cancel_requires_cancel_token",
          appointmentId,
        },
        true,
      );
    }
    const result = await callApi(
      "/api/appointment/cancel",
      { appointmentId, patientId: state.patientId, cancelToken },
      getAmdOfficeForToolCall(state),
      { includeOffice: false },
    );
    const cancelResultReason = cancellationFailureReason(result);
    if (
      cancelResultReason === "appointment_already_cancelled" ||
      (cancelResultReason === "cancel_failed" &&
        apiResultLooksSuccessful(result))
    ) {
      recordSideEffectToolSucceeded(
        state,
        "cancel_appt",
        { appointmentId },
        "appointment_cancelled",
        { appointmentId },
      );
      removeAppointmentById(state, appointmentId);
      const completedReschedule = markRescheduleOldAppointmentCancelled(
        state,
        appointmentId,
      );
      const resumedTask =
        state.flow.currentTask?.kind === "appointment_management"
          ? completeCurrentTaskAndResume(state.flow)
          : undefined;
      if (!resumedTask) {
        updateCurrentTaskStep(state, "answer");
      }
      if (completedReschedule) {
        return withLatestPlannerCommand(state, result);
      }
      return result;
    }
    return result;
  },
});

// --- add_patient_note ---
export const add_patient_note = llm.tool({
  description: `Adds a short operational note to the verified patient's AdvancedMD chart. Requires a verified patient from phone lookup, verify_patient, or add_patient.

For scheduling workflows, collect the appointment reason and referring doctor during the call, but call this tool only after book_appt succeeds.

Only save these two fields: appointment reason and referring doctor. If there is no referring doctor, set referringDoctor to "none". Do not include diagnoses, clinical judgments, raw transcripts, appointment times, insurance, patient demographics, or anything else.`,
  parameters: z.object({
    appointmentReason: z
      .string()
      .min(1)
      .max(500)
      .describe("The caller's stated appointment reason"),
    referringDoctor: z
      .string()
      .min(1)
      .max(200)
      .describe(
        'The referring doctor name, or "none" if the caller was not referred',
      ),
  }),
  execute: async ({ appointmentReason, referringDoctor }, { ctx }) => {
    const state = getState(ctx);
    const speechReady = makeCurrentSpeechUninterruptible(ctx);
    syncSessionPatientFromActiveFlow(state);
    if (!state.patientId) {
      return toolOutcome(
        "not_allowed",
        "verify_patient",
        "Verify the patient before adding a note.",
        { reason: "note_requires_verified_patient" },
        true,
      );
    }
    if (!hasSuccessfulBookingForActivePatient(state)) {
      return toolOutcome(
        "not_allowed",
        "book",
        "Save the appointment note only after a successful booking.",
        { reason: "note_requires_successful_booking" },
        true,
      );
    }
    const reason = appointmentReason.trim();
    const referrer = referringDoctor.trim();
    if (!reason || !referrer) {
      return toolOutcome(
        "needs_clarification",
        "collect_visit_reason",
        "Collect both the appointment reason and referring doctor before saving the note.",
        { reason: "note_requires_reason_and_referrer" },
        true,
      );
    }
    const noteGrounding = evaluatePatientNoteGrounding(state, reason, referrer);
    if (noteGrounding) return noteGrounding;
    if (!speechReady) {
      return toolOutcome(
        "not_allowed",
        "collect_visit_reason",
        "The note was interrupted before it could be saved. Please confirm the note again.",
        { reason: "speech_interrupted" },
        true,
      );
    }
    const note = `Appointment reason: ${reason}\nReferring doctor: ${referrer}`;
    const result = await callApi(
      "/api/patient/notes",
      { patientId: state.patientId, note },
      getAmdOfficeForToolCall(state),
    );
    if (apiResultLooksSuccessful(result)) {
      updateCurrentTaskStep(state, "answer");
      return result;
    }
    return result;
  },
});

// --- book_appt ---
export const book_appt = llm.tool({
  description: `Books an appointment using slotId from an active get_availability response. Patient ID is read from session state automatically.

The middleware resolves the AMD appointment type from the selected slot, patient status, DOB, routing lane, and appointment kind. Do not choose or mention numeric AMD appointment type IDs.

Include the caller-provided appointment reason and referring doctor. A broad reason from any earlier caller turn is enough, like post-op follow-up, blurry vision, or routine eye exam. If there is no referring doctor, the caller is unsure, or nobody referred them, set referringDoctor to "none". Do not ask for extra clinical or surgery details once the reason is usable.

The middleware saves those two booking-note fields during booking.

Only book after the caller says yes to the exact offered slot. If the tool says the confirmation was interrupted, confirm the exact slot again before retrying. If booking fails because the slot is unavailable, call get_availability again before trying another slot.`,
  parameters: z.object({
    slotId: z
      .string()
      .describe("slotId of the caller-confirmed slot from get_availability"),
    appointmentKind: appointmentKindSchema,
    appointmentReason: z
      .string()
      .trim()
      .min(1)
      .describe("Caller-provided reason for the appointment."),
    referringDoctor: z
      .string()
      .trim()
      .min(1)
      .describe('Caller-provided referring doctor, or "none" if none.'),
  }),
  execute: async (params, { ctx, toolCallId }) => {
    const state = getState(ctx);
    const speechReady = makeCurrentSpeechUninterruptible(ctx);
    restoreConfirmedPreCallCaller(state);
    syncSessionPatientFromActiveFlow(state);
    if (!isFlowHarnessEnabled(state)) {
      return toolOutcome(
        "not_allowed",
        "handoff",
        "Booking requires the flow harness so the confirmed slot, patient, and booking note are tracked safely. Transfer the caller or enable the harness for this trunk.",
        { reason: "booking_requires_flow_harness" },
        false,
      );
    }
    if (!state.patientId) {
      const policyResponse = evaluatePolicyForState(state, "book_appt", params);
      return (
        policyResponse ??
        toolOutcome(
          "not_allowed",
          "verify_patient",
          "Verify or create the patient before booking.",
          { reason: "booking_requires_verified_or_created_patient" },
          true,
        )
      );
    }
    ensureRoutineVisionOffice(state);
    const selectedSlot = selectedAvailabilitySlot(state, params.slotId);
    if (!selectedSlot) {
      const policyResponse = evaluatePolicyForState(
        state,
        "book_appt",
        params,
        {
          booking: {
            patientRef: state.flow.activePatientRef,
            slotHash: normalizeSlotId(params.slotId),
            officeKey: state.officeKey,
            routing:
              state.lastAvailabilityRouting ?? routingForAvailability(state),
          },
        },
      );
      if (policyResponse) return policyResponse;
      return toolOutcome(
        "not_allowed",
        "get_availability",
        "That slot is not available from the active availability options. Search availability again before booking.",
        {
          reason: "booking_requires_recent_availability",
          slotId: params.slotId,
        },
        true,
      );
    }
    const routing =
      selectedSlot.routing ??
      state.lastAvailabilityRouting ??
      routingForAvailability(state);
    const bookingMetadata = resolveBookingNoteMetadata(
      state,
      params.appointmentReason,
      params.referringDoctor,
    );
    if ("outcome" in bookingMetadata) return bookingMetadata;
    const { appointmentReason, referringDoctor } = bookingMetadata;
    const bookingPolicyFacts = {
      patientRef: state.flow.activePatientRef,
      slotHash: selectedSlot.slotId,
      officeKey: state.officeKey,
      routing,
    };
    if (!speechReady) {
      return toolOutcome(
        "not_allowed",
        "confirm_booking",
        "Booking was interrupted before it could be submitted. Please confirm the appointment slot again.",
        { reason: "speech_interrupted" },
        true,
      );
    }
    const policyResponse = evaluatePolicyForState(state, "book_appt", params, {
      booking: bookingPolicyFacts,
    });
    if (policyResponse) return policyResponse;
    const bookingToken = bookingTokenForSelectedSlot(state, selectedSlot);
    if (typeof bookingToken !== "string") return bookingToken;
    const confirmationId =
      toolCallId ?? nextFlowEventId("tool_confirmed_booking");
    createPendingBookingAction(state.flow, {
      ...bookingPolicyFacts,
      spokenSummary: selectedSlot.spoken,
      confirmed: true,
      createdTurnId: confirmationId,
      confirmationTurnId: confirmationId,
    });
    const bookingAttempt = recordBookingAttempt(state.flow, {
      ...bookingPolicyFacts,
      spokenSummary: selectedSlot.spoken,
    });
    if (!bookingAttempt.action) {
      return toolOutcome(
        "error",
        "confirm_booking",
        "I couldn't lock that slot in from the current scheduling state. Check availability again.",
        { reason: "booking_action_not_recorded" },
        true,
      );
    }
    const appointmentIntent = appointmentIntentForBooking(
      state,
      routing,
      params.appointmentKind,
    );
    const body = {
      bookingToken,
      ...appointmentIntent,
      patientId: state.patientId,
      appointmentReason,
      referringDoctor,
      ...(state.patientName ? { patientName: state.patientName } : {}),
      ...(state.dob ? { dob: state.dob } : {}),
      ...(routing ? { routing } : {}),
    };
    const result = await callApi(
      "/api/appointment/book",
      body,
      getAmdOfficeForToolCall(state),
      { includeOffice: false },
    );
    const bookingResult = recordBookingResult(
      state.flow,
      bookingAttempt.action.id,
      result,
    );
    if (bookingResult.consumed) {
      recordBookedAppointmentInState(state, selectedSlot, result);
      removeAvailabilitySlot(state, selectedSlot.slotId);
      if (markRescheduleReplacementBooked(state, result)) {
        return withLatestPlannerCommand(state, result);
      }
      updateCurrentTaskStep(state, "answer");
      return result;
    }
    if (bookingResult.errorClass === "slot_unavailable") {
      const remainingSlots = removeAvailabilitySlot(state, selectedSlot.slotId);
      updateCurrentTaskStep(
        state,
        remainingSlots.length > 0 ? "confirm_booking" : "get_availability",
      );
      return result;
    }
    if (bookingResult.errorClass === "invalid_appointment_type") {
      clearAvailabilitySelection(state, "appointment_type_invalid");
      updateCurrentTaskStep(state, "get_availability");
      return result;
    }
    if (isRecord(result) && result.outcome === "appointment_type_unresolved") {
      const missing = appointmentTypeMissingFacts(result);
      const nextStep = nextStepForAppointmentTypeUnresolved(missing);
      updateCurrentTaskStep(state, nextStep);
      return result;
    }
    if (
      bookingResult.errorClass === "middleware_error" ||
      (isRecord(result) && result.status === "error")
    ) {
      updateCurrentTaskStep(state, "confirm_booking");
      return result;
    }
    return result;
  },
});

// --- route_to_spring_hill ---
export const route_to_spring_hill = llm.tool({
  description: `Switches the active call workflow to the Spring Hill office without transferring the caller.

Use this when the caller reached Crystal River but the visit must be handled through Spring Hill scheduling — especially pediatrics, cataract evaluation/workup/surgery scheduling, routine-vision scheduling, or insurance accepted at Spring Hill but not Crystal River. Explain the Spring Hill routing and get agreement, then call this before verify_patient, add_patient, update_insurance, get_availability, cancel_appt, or book_appt for that visit. If interrupted, get agreement again before retrying. Keep the caller on the line and continue helping them normally.`,
  parameters: z.object({}),
  execute: async (_, { ctx, toolCallId }) => {
    const state = getState(ctx);
    const speechReady = makeCurrentSpeechUninterruptible(ctx);
    if (!speechReady) {
      return toolOutcome(
        "not_allowed",
        "route_office",
        "Office routing was interrupted before it could be changed. Please confirm the routing again.",
        { reason: "speech_interrupted" },
        true,
      );
    }
    const policyResponse = evaluatePolicyForState(
      state,
      "route_to_spring_hill",
      {},
    );
    if (policyResponse) {
      return recordSideEffectConfirmationRequestFromToolCall(
        state,
        "route_to_spring_hill",
        {},
        policyResponse,
        toolCallId,
      );
    }
    const springHillOffice = getSpringHillOfficePhone();
    recordSideEffectToolSucceeded(
      state,
      "route_to_spring_hill",
      {},
      "office_routed",
      {
        officeKey: "spring-hill",
        amdOfficePhone: springHillOffice,
      },
    );
    clearAvailabilitySelection(state, "office_changed");
    state.officeKey = "spring-hill";
    state.amdOfficePhone = springHillOffice;
    return toolOutcome(
      "success",
      state.flow.step,
      `AMD routing switched to Spring Hill (${springHillOffice}). Continue the call without transferring.`,
      {
        officeKey: "spring-hill",
        amdOfficePhone: springHillOffice,
      },
      false,
    );
  },
});

// --- check_insurance ---
export const check_insurance = llm.tool({
  description: `Looks up whether the office accepts a specific insurance plan or family alias.

Prefer using this after the visit type is known when a caller asks if a plan is accepted or during new-patient registration.
The medical and routine_vision lookups can return different answers for the same plan name. If coverageType is not known, omit it and the lookup defaults to medical; if the answer may differ for routine vision, ask a follow-up after the lookup. Use coverageType "routine_vision" only for routine eye exam, glasses prescription, or contact lens prescription using accepted vision coverage or self-pay. Use "medical" for medical/surgical eye visits.
If the caller gives a plan or family name that matches the insurance map, run this tool with that exact phrase.
Do NOT force HMO, PPO, or Medicare as a default follow-up. Only ask for that kind of clarification if this tool returns clarificationNeeded.

The tool returns a small summary for the model:
- status
- canProceed
- canonicalPlan
- clarificationNeeded
- callerMessage

If Crystal River does not accept a plan but Spring Hill does, tell the caller Spring Hill accepts it and ask if they want to schedule there. If yes, call route_to_spring_hill before verify_patient, add_patient, update_insurance, get_availability, cancel_appt, or book_appt.

Use canonicalPlan for add_patient or update_insurance when canProceed=true.`,
  parameters: z.object({
    plan: z.string().describe("The insurance plan name the caller mentioned"),
    coverageType: z
      .enum(["medical", "routine_vision"])
      .optional()
      .describe(
        "medical for ophthalmology coverage; routine_vision for routine eye exam/glasses/contact lens prescription coverage.",
      ),
  }),
  execute: async ({ plan, coverageType }, { ctx }) => {
    const state = getState(ctx);
    makeCurrentSpeechUninterruptible(ctx);
    const policyResponse = evaluatePolicyForState(state, "check_insurance", {
      plan,
      coverageType,
    });
    if (policyResponse) return policyResponse;
    const normalizedCoverageType = normalizeCoverageType(coverageType);
    const result = matchInsurancePlanForOffice(
      state.officeKey,
      plan,
      normalizedCoverageType,
    );
    state.checkedInsurancePlan = canonicalInsurancePlan(result);
    state.checkedInsuranceCoverageType = state.checkedInsurancePlan
      ? normalizedCoverageType
      : null;
    reduceFlowEvent(state.flow, {
      id: nextFlowEventId("insurance_checked"),
      type: "insurance_checked",
      source: "tool_result",
      createdAt: Date.now(),
      plan,
      canonicalPlan: state.checkedInsurancePlan,
      coverageType: state.checkedInsuranceCoverageType,
      status: result.status,
      officeKey: state.officeKey,
    });
    const response = buildInsuranceToolResponse(result);
    if (
      state.officeKey === "crystal-river" &&
      result.status === "not_accepted"
    ) {
      const springHillResult = matchInsurancePlanForOffice("spring-hill", plan);
      const springHillPlan = canonicalInsurancePlan(springHillResult);
      if (springHillResult.status === "accepted" && springHillPlan) {
        return normalizeInsuranceOutcome(state, {
          ...response,
          acceptedAtAlternateOffice: "Spring Hill",
          alternateCanonicalPlan: springHillPlan,
          routeTool: "route_to_spring_hill",
          callerMessage: `${response.callerMessage} Spring Hill accepts ${springHillPlan}. Ask if they'd like to schedule there, then route to Spring Hill if they agree.`,
        });
      }
    }
    return normalizeInsuranceOutcome(state, response);
  },
});

// --- lookup_knowledge ---
export const lookup_knowledge = llm.tool({
  description: `Returns practice facts: address, hours, location, providers, services, what to bring, phone, fax, and appointment expectations.

You MUST call this tool before answering any of those questions, including mid-flow.

Answer naturally from the returned info — just the part that answers their question.`,
  parameters: z.object({
    question: z
      .string()
      .describe(
        "What the caller is asking about (e.g. 'office hours', 'do you see kids', 'what should I bring')",
      ),
  }),
  execute: async ({ question }, { ctx }) => {
    const state = getState(ctx);
    makeCurrentSpeechUninterruptible(ctx);
    const result = lookupOfficeKnowledge(state.officeKey, question);
    if (state.flow.currentTask?.kind === "faq") {
      completeCurrentTaskAndResume(state.flow);
    }
    return result;
  },
});

// --- transfer_call ---
export const transfer_call = llm.tool({
  description:
    'Transfers the caller to the office. Before calling, say: "I\'m going to transfer you to the office now. They may be with a patient, so please leave a message and we will get back to you as soon as possible." Then call this tool once. Do not ask for transfer confirmation. Do not call in parallel; duplicate in-flight calls are ignored. After it executes the SIP session disconnects and your turn is over.',
  parameters: z.object({}),
  execute: async (_, { ctx, toolCallId }) => {
    const state = getState(ctx);
    const speechReady = makeCurrentSpeechUninterruptible(ctx);
    // Guard: prevent duplicate transfers (LLM sometimes calls this twice)
    if (state.transferred || state.transferInFlight) {
      return toolOutcome(
        "success",
        "answer",
        "Transfer already started. No action needed.",
        { reason: "transfer_already_started" },
        false,
      );
    }
    if (state.transferAttempted) {
      return toolOutcome(
        "not_allowed",
        "answer",
        "Transfer was already attempted. Do not call transfer_call again.",
        { reason: "transfer_already_attempted" },
        false,
      );
    }
    if (!speechReady) {
      return toolOutcome(
        "not_allowed",
        "handoff",
        "Transfer was interrupted before it could start. Do not call transfer_call again until the caller asks for transfer again.",
        { reason: "speech_interrupted" },
        false,
      );
    }
    const policyResponse = evaluatePolicyForState(state, "transfer_call", {});
    if (policyResponse) {
      return recordSideEffectConfirmationRequestFromToolCall(
        state,
        "transfer_call",
        {},
        policyResponse,
        toolCallId,
      );
    }
    state.transferAttempted = true;
    state.transferInFlight = true;
    try {
      // Wait for the transfer announcement to finish playing before initiating
      await ctx.waitForPlayout();
      if (!state.sipRoomName || !state.sipParticipantIdentity) {
        state.transferInFlight = false;
        return toolOutcome(
          "error",
          "handoff",
          "Could not transfer - no active SIP session.",
          { reason: "missing_sip_session" },
          false,
        );
      }
      const { handoffOfficeKey, handoffTarget } =
        await transferCallerToOffice(state);
      recordSideEffectToolSucceeded(
        state,
        "transfer_call",
        {},
        "transfer_started",
        {
          handoffOfficeKey,
        },
      );
      state.transferred = true;
      state.transferInFlight = false;
      console.log(
        `[tools] Transferred ${state.sipParticipantIdentity} to ${handoffTarget}`,
      );
      // Framework handles shutdown via close_on_disconnect when the
      // SIP participant leaves after the transfer completes.
      return toolOutcome(
        "success",
        "handoff",
        "Transfer initiated successfully.",
        {
          handoffOfficeKey,
        },
        false,
      );
    } catch (err) {
      state.transferInFlight = false;
      console.error("[tools] Transfer failed:", err);
      return toolOutcome(
        "error",
        "handoff",
        "Could not transfer the call. Do not call transfer_call again.",
        { reason: "transfer_failed" },
        false,
      );
    }
  },
});
