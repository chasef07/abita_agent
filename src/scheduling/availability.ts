import {
  activePatientDob,
  activePatientId,
  type CallState,
  type StoredAvailabilitySlot,
  type VisitType,
} from "../state/call-state.js";
import {
  middlewareFailureIsRetryable,
  type AvailabilityResult,
  type AvailabilitySlot,
  type MiddlewareFailure,
} from "../clients/owned-middleware.js";
import {
  normalizePhoneNumber,
  type AvailabilityOfficeKey,
} from "../customers/abita/profile.js";
import { incompletePatientRegistrationMessage } from "../identity/patient-identity.js";
import { activeRoutingContext, setWorkflowVisitType } from "./state.js";
import {
  getAmdOfficeForToolCall,
  medicalSchedulingUnavailable,
  routingForAvailability,
  routineVisionSchedulingUnavailable,
  selectAvailabilityOffice,
} from "./routing.js";
import {
  addCalendarDays,
  clinicIsoDate,
  type SchedulingClock,
} from "./clock.js";
import type { SchedulingMiddleware } from "./middleware.js";
import { spokenAppointmentDate } from "./spoken-date.js";
import { throwOwnedMiddlewareFailure } from "../runtime/middleware-tool-failure.js";

type AvailabilityRequest = Parameters<
  SchedulingMiddleware["getAvailability"]
>[0];

interface AvailabilityLookupArgs {
  startDate?: string;
  visitType?: VisitType;
  office?: AvailabilityOfficeKey;
}

export async function loadAvailability(
  state: CallState,
  args: AvailabilityLookupArgs,
  middleware: SchedulingMiddleware,
  clock: SchedulingClock,
  signal?: AbortSignal,
): Promise<string> {
  const now = clock.now();
  const request = buildAvailabilityLookupRequestForState(state, {
    ...args,
    cacheDay: clinicIsoDate(now),
  });
  if ("blocked" in request) return request.blocked;

  let result: AvailabilityResult;
  for (let attempt = 0; ; attempt += 1) {
    result = await coordinatedAvailabilityRead(
      state,
      request.backendKey,
      () =>
        middleware.getAvailability({
          ...request.body,
          ...(signal ? { signal } : {}),
        }),
      {
        now: clock.now(),
        signal,
      },
    );
    if (signal?.aborted || !availabilityRequestStillCurrent(state, request)) {
      discardAvailabilityRead(state, request.backendKey, result);
      return "The patient or appointment changed while I was checking. Let me check again with the current details.";
    }
    const expiresAt = availabilityResultExpiresAt(result);
    if (expiresAt === null || expiresAt > clock.now().getTime()) {
      break;
    }

    clearAvailabilitySelection(state);
    invalidateAvailabilityCacheForExpiredResult(
      state,
      request.backendKey,
      result,
    );
    if (attempt > 0) {
      return "Those openings expired before I could offer them. Let me check again.";
    }
  }
  try {
    const message = storeAvailabilitySlots(
      state,
      result,
      request.routing,
      availabilityReadCanRetry(state, request.backendKey),
    );
    if (result.status !== "error" && completeAvailabilityResult(result)) {
      cacheCompletedAvailabilityRead(
        state,
        request.backendKey,
        result,
        clock.now(),
      );
    }
    return message;
  } finally {
    discardAvailabilityRead(state, request.backendKey, result);
  }
}

type AvailableSlotsResult = Exclude<AvailabilityResult, MiddlewareFailure>;

export function selectedAvailabilitySlot(
  state: CallState,
  slotId: string,
): StoredAvailabilitySlot | null {
  const normalized = normalizeSlotId(slotId);
  return (
    availabilitySlotsForState(state).find(
      (slot) => normalizeSlotId(slot.slotId) === normalized,
    ) ?? null
  );
}

function storeAvailabilitySlots(
  state: CallState,
  result: AvailabilityResult,
  routing: string | null,
  canRetry = true,
): string {
  if (result.status === "error") {
    clearAvailabilitySelection(state);
    throwOwnedMiddlewareFailure(
      result,
      canRetry
        ? "I couldn't check availability. I can try once more or connect you with the office."
        : "I still couldn't verify availability. Do not retry this search or describe it as no openings. Offer staff help according to office policy.",
    );
  }

  // A partial read cannot establish the full calendar. Do not expose it as inventory.
  const offeredSlots =
    result.status === "incomplete"
      ? []
      : distinctAvailabilitySlots(result.slots);
  const existingSlots = new Map(
    availabilitySlotsForState(state).map((slot) => [storedSlotKey(slot), slot]),
  );
  const candidates = offeredSlots.map((slot) =>
    storedAvailabilitySlot(slot, "", routing),
  );
  const missingSlotIds = reserveAvailabilitySlotIds(
    state,
    candidates.filter((slot) => !existingSlots.has(storedSlotKey(slot))).length,
  );
  let nextId = 0;
  const storedSlots = candidates.map((slot) => ({
    ...slot,
    slotId:
      existingSlots.get(storedSlotKey(slot))?.slotId ??
      missingSlotIds[nextId++]!,
  }));

  clearAvailabilitySelection(state);
  state.availability.slots = storedSlots;
  state.availability.latestRouting = routing;
  offeredSlots.forEach((slot, index) => {
    storeAvailabilityBookingToken(
      state,
      storedSlots[index]?.slotId ?? "",
      slot.bookingToken,
      result.bookingTokenExpiresAt,
    );
  });

  return availabilityMessage(result, storedSlots, canRetry);
}

function availabilityMessage(
  result: AvailableSlotsResult,
  slots: StoredAvailabilitySlot[],
  canRetry: boolean,
): string {
  const searchedRange = spokenSearchRange(result);
  if (result.status === "none") {
    return `I couldn't find any openings ${searchedRange}. What other day or time works for you?`;
  }
  if (result.status === "incomplete") {
    if (!canRetry || !result.shouldRetrySameSearch) {
      return `I still couldn't verify availability ${searchedRange}. Do not retry this search or describe it as no openings. Offer staff help according to office policy.`;
    }
    return `I couldn't finish checking availability ${searchedRange}. Let me try once more.`;
  }

  if (slots.length === 0) {
    return "I couldn't find a usable opening. Call list_available_appointments once more.";
  }
  const dates = new Map(
    [...new Set(slots.map((slot) => slot.date))].map((date) => [
      date,
      spokenAppointmentDate(date),
    ]),
  );
  return [
    `Loaded ${slots.length} eligible appointments ${searchedRange}. All times are Eastern.`,
    "Use this list to match the caller's requested days and times. Offer at most two choices, then wait. For follow-up preferences within this range, use this list without another lookup. Never invent a time or silently ignore a constraint. If nothing fits, explain that and ask whether an alternative works. Slot references are private; book only the caller-confirmed reference after read-back.",
    ...slots.map(
      (slot) =>
        `${slot.slotId} — ${dates.get(slot.date)} at ${slot.time} with ${slot.provider}`,
    ),
  ].join("\n");
}

function spokenSearchRange(result: AvailableSlotsResult): string {
  const start = result.searchedFrom ?? result.requestedDate;
  const end = result.searchedThrough ?? result.actualDate ?? start;
  if (start && end) {
    return `from ${spokenAppointmentDate(start)} through ${spokenAppointmentDate(end)}`;
  }
  return "for those dates";
}

function storedAvailabilitySlot(
  slot: AvailabilitySlot,
  slotId: string,
  routing: string | null,
): StoredAvailabilitySlot {
  const provider = publicProviderName(slot.provider);
  const date = slot.date || (slot.datetime.split("T")[0] ?? "");
  return {
    inventoryKey: slot.key ?? `${slot.provider}|${slot.datetime}`,
    slotId,
    provider,
    date,
    time: slot.time,
    datetime: slot.datetime,
    routing,
  };
}

function distinctAvailabilitySlots(
  slots: AvailabilitySlot[],
): AvailabilitySlot[] {
  const unique = new Map<string, AvailabilitySlot>();
  for (const slot of slots) {
    const key = slot.key ?? `${slot.provider}|${slot.datetime}`;
    const previous = unique.get(key);
    if (
      !previous ||
      (!previous.bookingToken?.trim() && slot.bookingToken?.trim())
    )
      unique.set(key, slot);
  }
  return [...unique.values()];
}

function storedSlotKey(slot: StoredAvailabilitySlot): string {
  return `${slot.inventoryKey ?? `${slot.provider}|${slot.datetime}`}|${slot.routing}`;
}

function normalizeSlotId(slotId: string): string {
  return slotId.trim().toUpperCase();
}

export function publicProviderName(provider: string): string {
  return provider
    .replace("Dr. Austin Bach (Overflow)", "Dr. Bach")
    .replace("Dr. Austin Bach", "Dr. Bach")
    .replace("Dr. J. Licht", "Dr. Licht")
    .replace("Dr. D. Noel", "Dr. Noel");
}

function completeAvailabilityResult(result: AvailableSlotsResult): boolean {
  if (result.shouldRetrySameSearch || result.status === "incomplete") {
    return false;
  }
  if (result.status === "none") return result.slots.length === 0;
  return (
    result.slots.length > 0 &&
    result.slots.every(
      (slot) =>
        Boolean(slot.provider.trim()) &&
        Boolean(slot.date.trim()) &&
        Boolean(slot.time.trim()) &&
        Boolean(slot.datetime.trim()) &&
        Boolean(slot.bookingToken?.trim()),
    )
  );
}

export function storeAvailabilityBookingToken(
  state: CallState,
  slotId: string,
  bookingToken?: string,
  bookingTokenExpiresAt?: string,
): void {
  if (bookingToken?.trim()) {
    state.availability.bookingTokensBySlotId[slotId] = bookingToken.trim();
    const expiresAt = Date.parse(bookingTokenExpiresAt ?? "");
    const expiries = availabilityRuntimeFor(state).tokenExpiries;
    if (Number.isFinite(expiresAt)) {
      expiries.set(slotId, expiresAt);
    } else {
      expiries.delete(slotId);
    }
  }
}

export function availabilityBookingToken(
  state: CallState,
  slotId: string,
  now?: Date,
): string | null {
  const bookingToken =
    state.availability.bookingTokensBySlotId[slotId]?.trim() || null;
  if (!bookingToken) return null;
  const expiries = availabilityRuntimeFor(state).tokenExpiries;
  const expiresAt = expiries.get(slotId);
  if (expiresAt !== undefined && now && now.getTime() >= expiresAt) {
    delete state.availability.bookingTokensBySlotId[slotId];
    expiries.delete(slotId);
    return null;
  }
  return bookingToken;
}

export function clearAvailabilitySelection(
  state: CallState,
  options: { invalidateReads?: boolean } = {},
): void {
  if (options.invalidateReads) {
    invalidateAvailabilityReads(state);
    state.availability.requestedStartDate = undefined;
  }
  state.availability.slots = [];
  state.availability.latestRouting = null;
  state.availability.bookingTokensBySlotId = {};
  availabilityRuntimeFor(state).tokenExpiries.clear();
}

function reserveAvailabilitySlotIds(state: CallState, count: number): string[] {
  if (count <= 0) return [];
  const nextSlotIndex = Math.max(
    state.availability.nextSlotIndex,
    nextAvailabilitySlotIndexAfter(state.availability.slots),
    nextAvailabilitySlotIndexAfter(
      Object.keys(state.availability.bookingTokensBySlotId).map((slotId) => ({
        slotId,
      })),
    ),
  );
  state.availability.nextSlotIndex = nextSlotIndex + count;
  return Array.from(
    { length: count },
    (_, index) => `S${nextSlotIndex + index + 1}`,
  );
}

export function latestAvailabilityRouting(state: CallState): string | null {
  return (
    state.availability.latestRouting ?? state.workflow.routing.routing ?? null
  );
}

export function availabilitySlotsForState(
  state: CallState,
): StoredAvailabilitySlot[] {
  return [...state.availability.slots];
}

export function removeAvailabilitySlot(
  state: CallState,
  slotId: string,
): StoredAvailabilitySlot[] {
  invalidateAvailabilityReads(state);
  const normalized = normalizeSlotId(slotId);
  state.availability.slots = state.availability.slots.filter(
    (slot) => normalizeSlotId(slot.slotId) !== normalized,
  );
  for (const storedSlotId of Object.keys(
    state.availability.bookingTokensBySlotId,
  )) {
    if (normalizeSlotId(storedSlotId) === normalized) {
      delete state.availability.bookingTokensBySlotId[storedSlotId];
      availabilityRuntimeFor(state).tokenExpiries.delete(storedSlotId);
    }
  }
  return availabilitySlotsForState(state);
}

function nextAvailabilitySlotIndexAfter(
  slots: readonly { slotId: string }[],
): number {
  return slots.reduce((nextIndex, slot) => {
    const index = availabilitySlotIndex(slot.slotId);
    return index === null ? nextIndex : Math.max(nextIndex, index + 1);
  }, 0);
}

function availabilitySlotIndex(slotId: string): number | null {
  const normalized = slotId.trim().toUpperCase();
  const stableMatch = normalized.match(/^S(\d+)$/);
  if (!stableMatch) return null;
  const index = Number(stableMatch[1]) - 1;
  return Number.isSafeInteger(index) && index >= 0 ? index : null;
}

function availabilityRequestStillCurrent(
  state: CallState,
  request: AvailabilityWorkflowRequest,
): boolean {
  return (
    state.availability.requestedStartDate === request.body.startDate &&
    availabilityBackendKey(state, {
      body: request.body,
      cacheDay: request.cacheDay,
      patientId: activePatientId(state),
      routing: request.routing,
    }) === request.backendKey
  );
}

type AvailabilityWorkflowRequest = {
  body: AvailabilityRequest;
  backendKey: string;
  cacheDay: string;
  routing: string | null;
};

function buildAvailabilityLookupRequestForState(
  state: CallState,
  args: AvailabilityLookupArgs & {
    cacheDay: string;
  },
): AvailabilityWorkflowRequest | { blocked: string } {
  const { cacheDay } = args;
  if (args.startDate && args.startDate <= cacheDay) {
    return {
      blocked:
        `Same-day and past-date appointments cannot be scheduled here. The earliest search date is ${spokenAppointmentDate(addCalendarDays(cacheDay, 1))}. ` +
        "Ask whether that date or later works; do not retry the same date or change it without the caller's agreement. Follow office policy if the caller needs help today.",
    };
  }
  const incompleteRegistration = incompletePatientRegistrationMessage(state);
  if (incompleteRegistration) {
    return { blocked: incompleteRegistration };
  }
  const patientId = activePatientId(state);
  if (!patientId) {
    return {
      blocked:
        "I need to verify or create the patient before checking availability.",
    };
  }

  const officeSelection = selectAvailabilityOffice(state, args.office);
  if (officeSelection) return { blocked: officeSelection };

  if (args.visitType) setWorkflowVisitType(state, args.visitType);
  if (!state.workflow.visitType) {
    return { blocked: "Is this visit for medical care or routine vision?" };
  }
  const unsupportedMedicalScheduling = medicalSchedulingUnavailable(state);
  if (unsupportedMedicalScheduling)
    return { blocked: unsupportedMedicalScheduling };
  const unsupportedRoutineVisionScheduling =
    routineVisionSchedulingUnavailable(state);
  if (unsupportedRoutineVisionScheduling)
    return { blocked: unsupportedRoutineVisionScheduling };
  const routing = routingForAvailability(state);
  const startDate = args.startDate ?? addCalendarDays(cacheDay, 1);
  state.availability.requestedStartDate = startDate;
  const body: AvailabilityRequest = {
    office: getAmdOfficeForToolCall(state),
    startDate,
    rangeDays: 14,
  };
  const dob = activePatientDob(state);
  if (dob) body.dob = dob;
  if (routing) body.routing = routing;
  if (activeRoutingContext(state).preauthRequired) body.preauthRequired = true;
  return {
    body,
    backendKey: availabilityBackendKey(state, {
      body,
      cacheDay,
      patientId,
      routing,
    }),
    cacheDay,
    routing,
  };
}

function availabilityBackendKey(
  state: CallState,
  input: {
    body: AvailabilityRequest;
    cacheDay: string;
    patientId: string | null;
    routing: string | null;
  },
): string {
  return JSON.stringify({
    availabilityGeneration: availabilityRuntimeFor(state).generation,
    patientContextGeneration: state.identity.transitionVersion,
    patientId: input.patientId?.trim() || null,
    officeProfile: state.office.activeKey,
    providerOffice: normalizePhoneNumber(getAmdOfficeForToolCall(state)),
    visitType: state.workflow.visitType,
    cacheDay: input.cacheDay,
    startDate: input.body.startDate,
    dob:
      typeof input.body.dob === "string" ? input.body.dob.trim() || null : null,
    routing: input.routing,
    preauthRequired: input.body.preauthRequired === true,
  });
}

type AvailabilityRuntime = {
  completed: Map<string, { expiresAt: number; result: AvailabilityResult }>;
  generation: number;
  tokenExpiries: Map<string, number>;
  inFlight: Map<string, InFlightAvailabilityRead>;
  failed: Map<string, { attempts: number; result: AvailabilityResult }>;
};

type InFlightAvailabilityRead = {
  promise: Promise<AvailabilityResult>;
  result?: AvailabilityResult;
};

type CoordinatedAvailabilityReadOptions = {
  now: Date;
  signal?: AbortSignal;
};

const availabilityRuntimes = new WeakMap<CallState, AvailabilityRuntime>();

async function coordinatedAvailabilityRead(
  state: CallState,
  key: string,
  read: () => Promise<AvailabilityResult>,
  options: CoordinatedAvailabilityReadOptions,
): Promise<AvailabilityResult> {
  const { now, signal } = options;
  signal?.throwIfAborted();
  const coordinator = availabilityRuntimeFor(state);
  const failed = coordinator.failed.get(key);
  if (failed && !availabilityReadCanRetry(state, key)) {
    return failed.result;
  }
  const completed = coordinator.completed.get(key);
  if (completed) {
    if (now.getTime() >= completed.expiresAt) {
      coordinator.completed.clear();
    } else {
      return completed.result;
    }
  }

  const existing = coordinator.inFlight.get(key);
  if (existing) return existing.promise;

  const pending = Promise.resolve().then(read);
  const inFlight: InFlightAvailabilityRead = { promise: pending };
  inFlight.promise = pending.then((result) => {
    // Count backend attempts once, even when multiple tool calls share the read.
    if (coordinator.inFlight.get(key) === inFlight && !signal?.aborted) {
      if (result.status === "incomplete" || result.status === "error") {
        const attempts = (coordinator.failed.get(key)?.attempts ?? 0) + 1;
        coordinator.failed.set(key, { attempts, result });
      } else {
        coordinator.failed.delete(key);
      }
    }
    inFlight.result = result;
    return result;
  });
  coordinator.inFlight.set(key, inFlight);
  const discard = () => {
    if (coordinator.inFlight.get(key) === inFlight) {
      invalidateAvailabilityReads(state);
    }
  };
  signal?.addEventListener("abort", discard, { once: true });
  try {
    return await inFlight.promise;
  } catch (error) {
    if (coordinator.inFlight.get(key) === inFlight) {
      coordinator.inFlight.delete(key);
    }
    throw error;
  } finally {
    signal?.removeEventListener("abort", discard);
  }
}

function cacheCompletedAvailabilityRead(
  state: CallState,
  key: string,
  result: AvailabilityResult,
  now: Date,
): void {
  const coordinator = availabilityRuntimeFor(state);
  const expiresAt = availabilityResultExpiresAt(result);
  if (
    (result.status !== "found" && result.status !== "none") ||
    (result.status === "found" &&
      (expiresAt === null || expiresAt <= now.getTime()))
  ) {
    return;
  }
  // Cache hits must retain the original fetch deadline, especially empty results
  // which have no booking token to provide an independent expiry.
  const snapshotExpiresAt =
    coordinator.completed.get(key)?.expiresAt ??
    availabilitySnapshotExpiresAt(result, now);
  if (!coordinator.completed.has(key)) {
    coordinator.completed.set(key, {
      expiresAt: snapshotExpiresAt,
      result: copyAvailabilityResult(result),
    });
  }
}

function discardAvailabilityRead(
  state: CallState,
  key: string,
  result: AvailabilityResult,
): void {
  const runtime = availabilityRuntimeFor(state);
  if (runtime.inFlight.get(key)?.result === result) {
    runtime.inFlight.delete(key);
  }
}

function invalidateAvailabilityCacheForExpiredResult(
  state: CallState,
  key: string,
  result: AvailabilityResult,
): void {
  const coordinator = availabilityRuntimeFor(state);
  if (coordinator.inFlight.get(key)?.result !== result) return;

  coordinator.completed.clear();
  coordinator.inFlight.delete(key);
}

function availabilityReadCanRetry(state: CallState, key: string): boolean {
  const failed = availabilityRuntimeFor(state).failed.get(key);
  if (!failed) return true;
  return (
    failed.attempts < 2 &&
    (failed.result.status === "error"
      ? middlewareFailureIsRetryable(failed.result)
      : failed.result.shouldRetrySameSearch)
  );
}

function invalidateAvailabilityReads(state: CallState): void {
  const coordinator = availabilityRuntimeFor(state);
  coordinator.generation += 1;
  coordinator.completed.clear();
  coordinator.inFlight.clear();
  coordinator.failed.clear();
}

function availabilityRuntimeFor(state: CallState): AvailabilityRuntime {
  let runtime = availabilityRuntimes.get(state);
  if (!runtime) {
    runtime = {
      completed: new Map(),
      inFlight: new Map(),
      failed: new Map(),
      generation: 0,
      tokenExpiries: new Map(),
    };
    availabilityRuntimes.set(state, runtime);
  }
  return runtime;
}

function copyAvailabilityResult(
  result: AvailabilityResult,
): AvailabilityResult {
  return result.status === "error"
    ? { ...result }
    : { ...result, slots: result.slots.map((slot) => ({ ...slot })) };
}

function availabilityResultExpiresAt(
  result: AvailabilityResult,
): number | null {
  if (result.status !== "found") return null;
  const expiresAt = Date.parse(result.bookingTokenExpiresAt ?? "");
  return Number.isFinite(expiresAt) ? expiresAt : null;
}

// Inventory freshness is shorter than signed booking authorization. A selected
// slot is still revalidated by middleware at booking time.
function availabilitySnapshotExpiresAt(
  result: AvailabilityResult,
  now: Date,
): number {
  return Math.min(
    availabilityResultExpiresAt(result) ?? Infinity,
    now.getTime() + 60_000,
  );
}
