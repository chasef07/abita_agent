import { createHash } from "crypto";
import { inspectAvailabilitySearch } from "./availability.js";
import type { AvailabilitySearchInspection } from "./availability.js";
import type { CallFlowState } from "./types.js";

export type GuardedToolName =
  | "verify_patient"
  | "check_insurance"
  | "route_to_spring_hill"
  | "add_patient"
  | "get_availability"
  | "book_appt"
  | "cancel_appt"
  | "update_insurance"
  | "transfer_call";

export type GuardObservationReason =
  | "allowed"
  | "duplicate_tool_call_same_args"
  | "routine_vision_crystal_river_requires_route_to_spring_hill"
  | "new_patient_requires_insurance_check_before_registration"
  | "availability_duplicate_search_signature"
  | "availability_search_budget_exhausted"
  | "booking_requires_verified_or_created_patient"
  | "booking_requires_recent_availability"
  | "booking_confirmation_required"
  | "booking_action_already_consumed"
  | "booking_slot_invalidated"
  | "cancel_requires_verified_or_created_patient"
  | "cancel_confirmation_not_tracked"
  | "cancel_requires_loaded_appointment"
  | "update_insurance_requires_verified_patient"
  | "side_effect_confirmation_required"
  | "side_effect_action_already_consumed"
  | "side_effect_action_invalidated";

export interface GuardToolCallInput {
  flow: CallFlowState;
  toolName: GuardedToolName;
  args?: unknown;
  stateFacts?: {
    checkedInsurancePlan?: string | null;
    checkedInsuranceCoverageType?: string | null;
    patientId?: string | null;
    lastAvailabilityRouting?: string | null;
    officeKey?: string | null;
  };
  createdAt?: number;
}

export interface GuardObservation {
  type: "flow_guard_observation";
  mode: "report_only";
  enforcement: "observe" | "block";
  createdAt: number;
  toolName: GuardedToolName;
  argsHash: string;
  allowed: boolean;
  reason: GuardObservationReason;
  activeFlow: CallFlowState["activeFlow"];
  activeIntent: CallFlowState["activeIntent"];
  step: CallFlowState["step"];
  patientStatus: CallFlowState["patientStatus"];
  activePatientRef?: CallFlowState["activePatientRef"];
  currentTaskId?: string;
  visitType?: CallFlowState["visitType"];
  officeKey: CallFlowState["officeKey"];
  availabilitySearchId?: string;
  availabilitySearchStatus?: string;
  availabilityExactSearchCount?: number;
  availabilityDuplicateSearchCount?: number;
}

export function guardToolCall({
  flow,
  toolName,
  args,
  stateFacts = {},
  createdAt = Date.now(),
}: GuardToolCallInput): GuardObservation {
  const argsHash = hashToolArgs(args);
  const availabilityInspection =
    toolName === "get_availability"
      ? inspectAvailabilitySearch(
          flow,
          availabilitySearchRequestFromGuard(flow, args, stateFacts),
        )
      : undefined;
  const reason = guardReason(
    flow,
    toolName,
    args,
    argsHash,
    stateFacts,
    availabilityInspection,
  );

  return {
    type: "flow_guard_observation",
    mode: "report_only",
    enforcement: "observe",
    createdAt,
    toolName,
    argsHash,
    allowed: reason === "allowed",
    reason,
    activeFlow: flow.activeFlow,
    activeIntent: flow.activeIntent,
    step: flow.step,
    patientStatus: flow.patientStatus,
    activePatientRef: flow.activePatientRef,
    currentTaskId: flow.currentTask?.id,
    visitType: flow.visitType,
    officeKey: flow.officeKey,
    availabilitySearchId: availabilityInspection?.search?.id,
    availabilitySearchStatus: availabilityInspection?.projectedStatus,
    availabilityExactSearchCount:
      availabilityInspection?.projectedExactSearchCount,
    availabilityDuplicateSearchCount:
      availabilityInspection?.projectedDuplicateSearchCount,
  };
}

function guardReason(
  flow: CallFlowState,
  toolName: GuardedToolName,
  args: unknown,
  argsHash: string,
  stateFacts: NonNullable<GuardToolCallInput["stateFacts"]>,
  availabilityInspection?: AvailabilitySearchInspection,
): GuardObservationReason {
  if (
    toolName === "get_availability" &&
    flow.visitType === "routine_vision" &&
    (stateFacts.officeKey ?? flow.officeKey) === "crystal-river"
  ) {
    return "routine_vision_crystal_river_requires_route_to_spring_hill";
  }

  if (
    toolName === "add_patient" &&
    !stateFacts.checkedInsurancePlan &&
    !stateFacts.checkedInsuranceCoverageType
  ) {
    return "new_patient_requires_insurance_check_before_registration";
  }

  if (toolName === "get_availability" && availabilityInspection?.duplicate) {
    return "availability_duplicate_search_signature";
  }

  if (toolName === "get_availability" && availabilityInspection?.exhausted) {
    return "availability_search_budget_exhausted";
  }

  const hasVerifiedOrCreatedPatient =
    flow.patientStatus === "verified" || flow.patientStatus === "created";
  if (toolName === "book_appt" && !hasVerifiedOrCreatedPatient) {
    return "booking_requires_verified_or_created_patient";
  }

  if (
    toolName === "book_appt" &&
    !stateFacts.lastAvailabilityRouting &&
    !hasCachedAvailabilityForBooking(flow, args)
  ) {
    return "booking_requires_recent_availability";
  }

  if (toolName === "update_insurance" && !stateFacts.patientId) {
    return "update_insurance_requires_verified_patient";
  }

  if (toolName === "cancel_appt" && !hasVerifiedOrCreatedPatient) {
    return "cancel_requires_verified_or_created_patient";
  }

  const hasConsumedCancel = hasConsumedCancelAction(flow, argsHash);
  if (
    toolName === "cancel_appt" &&
    flow.pendingConfirmation?.type !== "cancel" &&
    !hasPendingCancelAction(flow, argsHash) &&
    !hasConsumedCancel
  ) {
    return "cancel_confirmation_not_tracked";
  }

  if (
    toolName === "cancel_appt" &&
    !hasConsumedCancel &&
    !hasLoadedAppointment(flow, args)
  ) {
    return "cancel_requires_loaded_appointment";
  }

  if (
    flow.lastGuardedToolCall?.name === toolName &&
    flow.lastGuardedToolCall.argsHash === argsHash
  ) {
    return "duplicate_tool_call_same_args";
  }

  return "allowed";
}

function hasPendingCancelAction(
  flow: CallFlowState,
  argsHash: string,
): boolean {
  return flow.pendingActions.some(
    (action) =>
      action.type === "cancel_appt" &&
      action.argsHash === argsHash &&
      action.confirmed &&
      !action.consumed &&
      !action.invalidated,
  );
}

function hasConsumedCancelAction(
  flow: CallFlowState,
  argsHash: string,
): boolean {
  return flow.pendingActions.some(
    (action) =>
      action.type === "cancel_appt" &&
      action.argsHash === argsHash &&
      action.confirmed &&
      action.consumed &&
      !action.invalidated,
  );
}

function hasLoadedAppointment(flow: CallFlowState, args: unknown): boolean {
  const appointmentId = appointmentIdFromArgs(args);
  if (typeof appointmentId !== "number") return false;
  const patient = flow.patients[flow.activePatientRef ?? "caller"];
  return Boolean(
    patient?.appointments.some(
      (appointment) => appointment.id === appointmentId,
    ),
  );
}

function hasCachedAvailabilityForBooking(
  flow: CallFlowState,
  args: unknown,
): boolean {
  const slotHash = slotHashFromBookingArgs(args);
  return flow.availabilitySearches.some((search) => {
    if (search.status === "invalidated") return false;
    if (search.cachedSlots.length === 0) return false;
    if (!slotHash) return true;
    return search.cachedSlots.some(
      (slot) => normalizeSlotHash(slot.slotHash) === slotHash,
    );
  });
}

function slotHashFromBookingArgs(args: unknown): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return undefined;
  }
  const slotId = (args as { slotId?: unknown }).slotId;
  return typeof slotId === "string" ? normalizeSlotHash(slotId) : undefined;
}

function normalizeSlotHash(slotHash: string): string {
  return slotHash.trim().toUpperCase();
}

function appointmentIdFromArgs(args: unknown): number | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return undefined;
  }
  const appointmentId = (args as { appointmentId?: unknown }).appointmentId;
  return typeof appointmentId === "number" ? appointmentId : undefined;
}

function availabilitySearchRequestFromGuard(
  flow: CallFlowState,
  args: unknown,
  stateFacts: NonNullable<GuardToolCallInput["stateFacts"]>,
) {
  const toolArgs =
    args && typeof args === "object" && !Array.isArray(args)
      ? (args as { date?: unknown; routing?: unknown })
      : {};

  return {
    patientRef: flow.activePatientRef,
    officeKey: (stateFacts.officeKey ??
      flow.officeKey) as CallFlowState["officeKey"],
    visitType: flow.visitType,
    coverageType: flow.coverageType,
    routing:
      typeof toolArgs.routing === "string"
        ? toolArgs.routing
        : (flow.routing ?? stateFacts.lastAvailabilityRouting),
    date: typeof toolArgs.date === "string" ? toolArgs.date : undefined,
  };
}

export function hashToolArgs(args: unknown): string {
  return createHash("sha256")
    .update(stableStringify(args ?? {}))
    .digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([a], [b]) => a.localeCompare(b),
  );
  return `{${entries
    .map(
      ([key, entryValue]) =>
        `${JSON.stringify(key)}:${stableStringify(entryValue)}`,
    )
    .join(",")}}`;
}
