import { createHash } from "crypto";
import { inspectAvailabilitySearch } from "./availability.js";
import type { AvailabilitySearchInspection } from "./availability.js";
import type { CallFlowState } from "./types.js";

export type GuardedToolName =
  | "check_insurance"
  | "route_to_spring_hill"
  | "add_patient"
  | "get_availability"
  | "book_appt"
  | "cancel_appt";

export type GuardObservationReason =
  | "allowed"
  | "duplicate_tool_call_same_args"
  | "visit_type_required_before_insurance"
  | "routine_vision_crystal_river_requires_route_to_spring_hill"
  | "new_patient_requires_insurance_check_before_registration"
  | "availability_requires_visit_type"
  | "availability_duplicate_search_signature"
  | "availability_search_budget_exhausted"
  | "booking_requires_verified_or_created_patient"
  | "booking_requires_recent_availability"
  | "cancel_confirmation_not_tracked";

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
  createdAt: number;
  toolName: GuardedToolName;
  argsHash: string;
  allowed: boolean;
  reason: GuardObservationReason;
  activeFlow: CallFlowState["activeFlow"];
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
    createdAt,
    toolName,
    argsHash,
    allowed: reason === "allowed",
    reason,
    activeFlow: flow.activeFlow,
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
  const coverageType = coverageTypeFromArgs(args);
  if (
    toolName === "check_insurance" &&
    !flow.visitType &&
    flow.step !== "check_insurance" &&
    !coverageType
  ) {
    return "visit_type_required_before_insurance";
  }

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

  if (toolName === "get_availability" && !flow.visitType) {
    return "availability_requires_visit_type";
  }

  if (toolName === "get_availability" && availabilityInspection?.duplicate) {
    return "availability_duplicate_search_signature";
  }

  if (toolName === "get_availability" && availabilityInspection?.exhausted) {
    return "availability_search_budget_exhausted";
  }

  if (
    flow.lastGuardedToolCall?.name === toolName &&
    flow.lastGuardedToolCall.argsHash === argsHash
  ) {
    return "duplicate_tool_call_same_args";
  }

  const hasBookablePatient =
    flow.patientStatus === "verified" ||
    flow.patientStatus === "created" ||
    (flow.patientStatus === "matched" && Boolean(stateFacts.patientId));
  if (toolName === "book_appt" && !hasBookablePatient) {
    return "booking_requires_verified_or_created_patient";
  }

  if (toolName === "book_appt" && !stateFacts.lastAvailabilityRouting) {
    return "booking_requires_recent_availability";
  }

  if (
    toolName === "cancel_appt" &&
    flow.pendingConfirmation?.type !== "cancel"
  ) {
    return "cancel_confirmation_not_tracked";
  }

  return "allowed";
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

function coverageTypeFromArgs(
  args: unknown,
): "medical" | "routine_vision" | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return undefined;
  }
  const value = (args as { coverageType?: unknown }).coverageType;
  return value === "medical" || value === "routine_vision" ? value : undefined;
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
