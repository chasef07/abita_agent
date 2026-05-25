import { createHash } from "crypto";
import type { InsuranceCoverageType } from "../insurance-rules.js";
import type { OfficeKey } from "../customer/profile.js";
import { normalizeSchedulingRouting } from "./state.js";
import type {
  AvailabilitySearch,
  AvailabilityInvalidationReason,
  CallFlowState,
  PendingAction,
  PatientRef,
  SchedulingRouting,
  VisitType,
} from "./types.js";

const DEFAULT_MAX_AVAILABILITY_SEARCHES = 3;
const UNKNOWN_AVAILABILITY_SEARCH_ID = "unknown_availability_search";

type BookAppointmentPendingAction = Extract<
  PendingAction,
  { type: "book_appt" }
>;
type BookingErrorClass = NonNullable<
  BookAppointmentPendingAction["lastBookingErrorClass"]
>;

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

export interface BookingAttemptRecordInput {
  patientRef?: PatientRef;
  slotHash: string;
  appointmentTypeId?: number;
  officeKey: OfficeKey;
  routing?: SchedulingRouting | string | null;
  spokenSummary: string;
  createdTurnId?: string;
  confirmationTurnId?: string;
  createdAt?: number;
}

export interface BookingAttemptRecordResult {
  action?: BookAppointmentPendingAction;
  availabilitySearch?: AvailabilitySearch;
  attemptHash: string;
}

export interface PendingBookingActionInput {
  patientRef?: PatientRef;
  slotHash: string;
  appointmentTypeId?: number;
  officeKey: OfficeKey;
  routing?: SchedulingRouting | string | null;
  spokenSummary: string;
  confirmed?: boolean;
  createdTurnId: string;
  confirmationTurnId?: string;
}

export interface BookingResultRecordResult {
  action?: BookAppointmentPendingAction;
  availabilitySearch?: AvailabilitySearch;
  errorClass?: BookingErrorClass;
  consumed: boolean;
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
  reason: "caller_rejected" | "slot_unavailable" | "invalid_appointment_type",
): AvailabilitySearch | undefined {
  const search =
    findAvailabilitySearchBySlotHash(flow, slotHash) ??
    latestUsableAvailabilitySearch(flow);
  if (!search) return undefined;

  if (!search.rejectedSlotHashes.includes(slotHash)) {
    search.rejectedSlotHashes.push(slotHash);
  }
  pushFailureReason(search, reason);
  if (reason === "invalid_appointment_type") {
    search.status = "invalidated";
    search.lastInvalidationReason = "appointment_type_invalid";
  }
  return search;
}

export function invalidateAvailabilitySearches(
  flow: CallFlowState,
  reason: AvailabilityInvalidationReason,
  options: { searchId?: string } = {},
): AvailabilitySearch[] {
  const invalidated: AvailabilitySearch[] = [];

  for (const search of flow.availabilitySearches) {
    if (search.status === "invalidated") continue;
    if (options.searchId && search.id !== options.searchId) continue;
    search.status = "invalidated";
    search.lastInvalidationReason = reason;
    if (reason === "appointment_type_invalid") {
      pushFailureReason(search, "invalid_appointment_type");
    }
    invalidated.push(search);
  }

  return invalidated;
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
  } else {
    if (search.status === "satisfied") {
      search.status =
        search.exactSearchCount >= search.maxSearches ? "exhausted" : "active";
    }
    pushFailureReason(search, "no_slots");
  }
  return search;
}

export function recordBookingAttempt(
  flow: CallFlowState,
  input: BookingAttemptRecordInput,
): BookingAttemptRecordResult {
  const bookingMatch = resolveBookingAction(flow, input);
  const { action, availabilitySearch, attemptHash } = bookingMatch;

  if (!action) return { availabilitySearch, attemptHash };

  action.lastBookingAttemptHash = attemptHash;
  action.bookingAttemptCount += 1;
  return { action, availabilitySearch, attemptHash };
}

export function createPendingBookingAction(
  flow: CallFlowState,
  input: PendingBookingActionInput,
): BookAppointmentPendingAction {
  const patientRef = input.patientRef ?? flow.activePatientRef ?? "caller";
  const routing = normalizeSchedulingRouting(input.routing);
  const availabilitySearch = findAvailabilitySearchBySlotHash(
    flow,
    input.slotHash,
  );
  const availabilitySearchId =
    availabilitySearch?.id ?? UNKNOWN_AVAILABILITY_SEARCH_ID;
  const existing = findMatchingBookingAction(
    flow,
    {
      patientRef,
      slotHash: input.slotHash,
      appointmentTypeId: input.appointmentTypeId,
      officeKey: input.officeKey,
      routing,
      availabilitySearchId,
    },
    { includeConsumed: true },
  );
  if (existing) return existing;

  return createBookingAction(flow, {
    patientRef,
    slotHash: input.slotHash,
    appointmentTypeId: input.appointmentTypeId,
    officeKey: input.officeKey,
    routing,
    availabilitySearchId,
    spokenSummary: input.spokenSummary,
    confirmed: input.confirmed ?? false,
    createdTurnId: input.createdTurnId,
    confirmationTurnId: input.confirmationTurnId,
  });
}

export function findPendingBookingAction(
  flow: CallFlowState,
  input: Omit<BookingAttemptRecordInput, "spokenSummary">,
  options: { includeConsumed?: boolean } = {},
): BookAppointmentPendingAction | undefined {
  const patientRef = input.patientRef ?? flow.activePatientRef ?? "caller";
  const routing = normalizeSchedulingRouting(input.routing);
  const availabilitySearch = findAvailabilitySearchBySlotHash(
    flow,
    input.slotHash,
  );
  const availabilitySearchId =
    availabilitySearch?.id ?? UNKNOWN_AVAILABILITY_SEARCH_ID;

  return findMatchingBookingAction(
    flow,
    {
      patientRef,
      slotHash: input.slotHash,
      appointmentTypeId: input.appointmentTypeId,
      officeKey: input.officeKey,
      routing,
      availabilitySearchId,
    },
    options,
  );
}

export function findConsumedBookingAction(
  flow: CallFlowState,
  input: Omit<BookingAttemptRecordInput, "spokenSummary">,
): BookAppointmentPendingAction | undefined {
  return findHistoricalBookingAction(flow, input, {
    consumed: true,
  });
}

export function findInvalidatedBookingAction(
  flow: CallFlowState,
  input: Omit<BookingAttemptRecordInput, "spokenSummary">,
): BookAppointmentPendingAction | undefined {
  return findHistoricalBookingAction(flow, input, {
    consumed: false,
    slotInvalidated: true,
  });
}

export function recordBookingResult(
  flow: CallFlowState,
  actionId: string,
  result: unknown,
): BookingResultRecordResult {
  const action = flow.pendingActions.find(
    (candidate): candidate is BookAppointmentPendingAction =>
      candidate.type === "book_appt" && candidate.id === actionId,
  );
  if (!action) return { consumed: false };

  const resultClass = classifyBookingResult(result);
  const availabilitySearch =
    findAvailabilitySearchBySlotHash(flow, action.slotHash) ??
    flow.availabilitySearches.find(
      (search) => search.id === action.availabilitySearchId,
    );

  if (resultClass === "success") {
    action.consumed = true;
    if (availabilitySearch) {
      availabilitySearch.status = "invalidated";
      availabilitySearch.lastInvalidationReason = "booking_completed";
    }
    return { action, availabilitySearch, consumed: true };
  }

  if (!resultClass) {
    return { action, availabilitySearch, consumed: false };
  }

  action.lastBookingErrorClass = resultClass;
  if (resultClass === "slot_unavailable") {
    action.slotInvalidated = true;
    const search = rejectAvailabilitySlot(flow, action.slotHash, resultClass);
    return {
      action,
      availabilitySearch: search ?? availabilitySearch,
      errorClass: resultClass,
      consumed: false,
    };
  }

  if (resultClass === "invalid_appointment_type") {
    action.slotInvalidated = true;
    const search = rejectAvailabilitySlot(
      flow,
      action.slotHash,
      "invalid_appointment_type",
    );
    return {
      action,
      availabilitySearch: search ?? availabilitySearch,
      errorClass: resultClass,
      consumed: false,
    };
  }

  return {
    action,
    availabilitySearch,
    errorClass: resultClass,
    consumed: false,
  };
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
    if (search.status === "invalidated") {
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

function findAvailabilitySearchBySlotHash(
  flow: CallFlowState,
  slotHash: string,
): AvailabilitySearch | undefined {
  return [...flow.availabilitySearches].reverse().find((search) => {
    if (search.status === "invalidated") return false;
    return search.cachedSlots.some((slot) => slot.slotHash === slotHash);
  });
}

function latestUsableAvailabilitySearch(
  flow: CallFlowState,
): AvailabilitySearch | undefined {
  return [...flow.availabilitySearches]
    .reverse()
    .find((search) => search.status !== "invalidated");
}

function findMatchingBookingAction(
  flow: CallFlowState,
  input: {
    patientRef: PatientRef;
    slotHash: string;
    appointmentTypeId?: number;
    officeKey: OfficeKey;
    routing?: SchedulingRouting;
    availabilitySearchId: string;
  },
  options: { includeConsumed?: boolean } = {},
): BookAppointmentPendingAction | undefined {
  return flow.pendingActions.find(
    (action): action is BookAppointmentPendingAction =>
      action.type === "book_appt" &&
      action.patientRef === input.patientRef &&
      action.slotHash === input.slotHash &&
      action.appointmentTypeId === input.appointmentTypeId &&
      action.officeKey === input.officeKey &&
      action.routing === input.routing &&
      action.availabilitySearchId === input.availabilitySearchId &&
      (options.includeConsumed || !action.consumed),
  );
}

function findHistoricalBookingAction(
  flow: CallFlowState,
  input: Omit<BookingAttemptRecordInput, "spokenSummary">,
  filters: { consumed: boolean; slotInvalidated?: boolean },
): BookAppointmentPendingAction | undefined {
  const patientRef = input.patientRef ?? flow.activePatientRef ?? "caller";
  const routing = normalizeSchedulingRouting(input.routing);

  return [...flow.pendingActions]
    .reverse()
    .find(
      (action): action is BookAppointmentPendingAction =>
        action.type === "book_appt" &&
        action.consumed === filters.consumed &&
        (filters.slotInvalidated === undefined ||
          action.slotInvalidated === filters.slotInvalidated) &&
        action.patientRef === patientRef &&
        action.slotHash === input.slotHash &&
        action.appointmentTypeId === input.appointmentTypeId &&
        action.officeKey === input.officeKey &&
        (routing === undefined || action.routing === routing),
    );
}

function resolveBookingAction(
  flow: CallFlowState,
  input: BookingAttemptRecordInput,
): BookingAttemptRecordResult {
  const patientRef = input.patientRef ?? flow.activePatientRef ?? "caller";
  const routing = normalizeSchedulingRouting(input.routing);
  const availabilitySearch = findAvailabilitySearchBySlotHash(
    flow,
    input.slotHash,
  );
  const availabilitySearchId =
    availabilitySearch?.id ?? UNKNOWN_AVAILABILITY_SEARCH_ID;
  const attemptHash = hashStateArgs({
    patientRef,
    slotHash: input.slotHash,
    appointmentTypeId: input.appointmentTypeId,
    officeKey: input.officeKey,
    routing: routing ?? null,
    availabilitySearchId,
  });
  const action = findMatchingBookingAction(flow, {
    patientRef,
    slotHash: input.slotHash,
    appointmentTypeId: input.appointmentTypeId,
    officeKey: input.officeKey,
    routing,
    availabilitySearchId,
  });

  return { action, availabilitySearch, attemptHash };
}

function createBookingAction(
  flow: CallFlowState,
  input: {
    patientRef: PatientRef;
    slotHash: string;
    appointmentTypeId?: number;
    officeKey: OfficeKey;
    routing?: SchedulingRouting;
    availabilitySearchId: string;
    spokenSummary: string;
    confirmed: boolean;
    createdTurnId: string;
    confirmationTurnId?: string;
  },
): BookAppointmentPendingAction {
  const action: BookAppointmentPendingAction = {
    id: `pending_book_${flow.pendingActions.length + 1}`,
    type: "book_appt",
    patientRef: input.patientRef,
    slotHash: input.slotHash,
    appointmentTypeId: input.appointmentTypeId,
    officeKey: input.officeKey,
    routing: input.routing,
    availabilitySearchId: input.availabilitySearchId,
    spokenSummary: input.spokenSummary,
    confirmed: input.confirmed,
    consumed: false,
    confirmationTurnId: input.confirmationTurnId,
    createdTurnId: input.createdTurnId,
    bookingAttemptCount: 0,
    slotInvalidated: false,
  };
  flow.pendingActions.push(action);
  return action;
}

function classifyBookingResult(
  result: unknown,
): "success" | BookingErrorClass | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return undefined;
  }
  const record = result as Record<string, unknown>;
  const status =
    typeof record.status === "string" ? record.status.toLowerCase() : "";
  const outcome =
    typeof record.outcome === "string" ? record.outcome.toLowerCase() : "";
  const message =
    typeof record.message === "string" ? record.message.toLowerCase() : "";

  if (
    status === "booked" ||
    status === "ok" ||
    (status === "partial" && record.appointmentId) ||
    (status === "success" && record.appointmentId)
  ) {
    return "success";
  }
  if (
    outcome === "slot_unavailable" ||
    outcome === "invalid_booking_token" ||
    message.includes("slot is no longer available") ||
    message.includes("booking token")
  ) {
    return "slot_unavailable";
  }
  if (
    outcome === "invalid_appointment_type" ||
    (message.includes("appointment type") && message.includes("invalid"))
  ) {
    return "invalid_appointment_type";
  }
  if (status === "error") return "middleware_error";
  return undefined;
}

function pushFailureReason(
  search: AvailabilitySearch,
  reason: AvailabilitySearch["failureReasons"][number],
): void {
  if (!search.failureReasons.includes(reason)) {
    search.failureReasons.push(reason);
  }
}

function hashStateArgs(value: unknown): string {
  return createHash("sha256")
    .update(stableStringify(value ?? {}))
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
