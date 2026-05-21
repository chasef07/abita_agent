import type { InsuranceCoverageType } from "../insurance-rules.js";
import type { OfficeKey } from "../offices.js";
import { normalizeSchedulingRouting } from "./state.js";
import type {
  AvailabilitySearch,
  CallFlowState,
  PatientRef,
  SchedulingRouting,
  VisitType,
} from "./types.js";

const DEFAULT_MAX_AVAILABILITY_SEARCHES = 3;

export interface AvailabilitySearchRequest {
  patientRef?: PatientRef;
  officeKey: OfficeKey;
  visitType?: VisitType;
  coverageType?: InsuranceCoverageType;
  routing?: SchedulingRouting | string | null;
  appointmentTypeId?: number;
  date?: string;
  requestedWindow?: string;
  providerRestrictions?: string[];
  ageLane?: string;
  maxSearches?: number;
}

export interface AvailabilitySearchRecordResult {
  search: AvailabilitySearch;
  searchKey: string;
  duplicate: boolean;
  exhausted: boolean;
}

export interface AvailabilitySearchInspection {
  search?: AvailabilitySearch;
  searchKey: string;
  duplicate: boolean;
  exhausted: boolean;
  projectedStatus?: AvailabilitySearch["status"];
  projectedExactSearchCount?: number;
  projectedDuplicateSearchCount?: number;
}

export function inspectAvailabilitySearch(
  flow: CallFlowState,
  request: AvailabilitySearchRequest,
): AvailabilitySearchInspection {
  const searchKey = buildAvailabilitySearchKey(request);
  const search = findActiveAvailabilitySearch(flow, request);
  const duplicate = Boolean(search?.searchedKeys.includes(searchKey));
  const maxSearches =
    search?.maxSearches ??
    request.maxSearches ??
    DEFAULT_MAX_AVAILABILITY_SEARCHES;
  const projectedExactSearchCount =
    (search?.exactSearchCount ?? 0) + (duplicate ? 0 : 1);
  const projectedDuplicateSearchCount =
    (search?.duplicateSearchCount ?? 0) + (duplicate ? 1 : 0);
  const projectedStatus =
    search?.status === "active" || !search
      ? projectedExactSearchCount >= maxSearches
        ? "exhausted"
        : "active"
      : search.status;

  return {
    search,
    searchKey,
    duplicate,
    exhausted: search?.status === "exhausted",
    projectedStatus,
    projectedExactSearchCount,
    projectedDuplicateSearchCount,
  };
}

export function recordAvailabilitySearch(
  flow: CallFlowState,
  request: AvailabilitySearchRequest,
): AvailabilitySearchRecordResult {
  const patientRef = request.patientRef ?? flow.activePatientRef ?? "caller";
  const searchKey = buildAvailabilitySearchKey(request);
  let search = findActiveAvailabilitySearch(flow, request);

  if (!search) {
    search = {
      id: `availability_${flow.availabilitySearches.length + 1}`,
      patientRef,
      officeKey: request.officeKey,
      visitType: request.visitType,
      coverageType: request.coverageType,
      routing: normalizeSchedulingRouting(request.routing),
      appointmentTypeId: request.appointmentTypeId,
      requestedWindow: request.requestedWindow ?? request.date,
      searchedKeys: [],
      cachedSlots: [],
      rejectedSlotHashes: [],
      exactSearchCount: 0,
      broadenCount: 0,
      duplicateSearchCount: 0,
      maxSearches: request.maxSearches ?? DEFAULT_MAX_AVAILABILITY_SEARCHES,
      failureReasons: [],
      status: "active",
    };
    flow.availabilitySearches.push(search);
  }

  const duplicate = search.searchedKeys.includes(searchKey);
  if (duplicate) {
    search.duplicateSearchCount += 1;
    pushFailureReason(search, "duplicate_search");
  } else {
    search.searchedKeys.push(searchKey);
    search.exactSearchCount += 1;
  }

  if (search.exactSearchCount >= search.maxSearches) {
    search.status = "exhausted";
    pushFailureReason(search, "budget_exhausted");
  }

  return {
    search,
    searchKey,
    duplicate,
    exhausted: search.status === "exhausted",
  };
}

export function rejectAvailabilitySlot(
  flow: CallFlowState,
  slotHash: string,
  reason: "caller_rejected" | "slot_unavailable",
): AvailabilitySearch | undefined {
  const search = [...flow.availabilitySearches]
    .reverse()
    .find((candidate) => candidate.status === "active");
  if (!search) return undefined;

  if (!search.rejectedSlotHashes.includes(slotHash)) {
    search.rejectedSlotHashes.push(slotHash);
  }
  pushFailureReason(search, reason);
  return search;
}

export function recordAvailabilityCachedSlots(
  flow: CallFlowState,
  slots: Array<{
    slotId: string;
    datetime?: string;
    columnId?: number;
    profileId?: number;
    duration?: number;
  }>,
): AvailabilitySearch | undefined {
  const search = [...flow.availabilitySearches]
    .reverse()
    .find((candidate) => candidate.status !== "invalidated");
  if (!search) return undefined;

  search.cachedSlots = slots.map((slot) => ({
    slotHash: slot.slotId,
    startDatetime: slot.datetime,
    columnId: slot.columnId,
    profileId: slot.profileId,
    duration: slot.duration,
  }));
  if (search.cachedSlots.length > 0) {
    search.status = "satisfied";
  }
  return search;
}

export function buildAvailabilitySearchKey(
  request: AvailabilitySearchRequest,
): string {
  return stableStringify({
    date: request.date ?? null,
    requestedWindow: request.requestedWindow ?? null,
    officeKey: request.officeKey,
    visitType: request.visitType ?? null,
    coverageType: request.coverageType ?? null,
    routing: normalizeSchedulingRouting(request.routing) ?? null,
    appointmentTypeId: request.appointmentTypeId ?? null,
    providerRestrictions: request.providerRestrictions ?? [],
    ageLane: request.ageLane ?? null,
  });
}

function findActiveAvailabilitySearch(
  flow: CallFlowState,
  request: AvailabilitySearchRequest,
): AvailabilitySearch | undefined {
  const patientRef = request.patientRef ?? flow.activePatientRef ?? "caller";
  const routing = normalizeSchedulingRouting(request.routing);

  return [...flow.availabilitySearches].reverse().find((search) => {
    if (search.status === "invalidated" || search.status === "satisfied") {
      return false;
    }
    return (
      search.patientRef === patientRef &&
      search.officeKey === request.officeKey &&
      search.visitType === request.visitType &&
      search.coverageType === request.coverageType &&
      search.routing === routing &&
      search.appointmentTypeId === request.appointmentTypeId
    );
  });
}

function pushFailureReason(
  search: AvailabilitySearch,
  reason: AvailabilitySearch["failureReasons"][number],
): void {
  if (!search.failureReasons.includes(reason)) {
    search.failureReasons.push(reason);
  }
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
