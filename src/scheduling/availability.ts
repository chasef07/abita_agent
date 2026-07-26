import {
  type CallState,
  type StoredAvailabilitySlot,
} from "../state/call-state.js";
import type {
  AvailabilityResult,
  AvailabilitySlot,
  MiddlewareFailure,
} from "../clients/owned-middleware.js";
import {
  availabilitySlotsForState,
  clearAvailabilitySelection,
  mergeAvailabilitySlots,
  reserveAvailabilitySlotIds,
  storeAvailabilityBookingToken,
} from "./state.js";
import { recordOwnedMiddlewareFailure } from "../state/observability.js";
import {
  describeTimeConstraint,
  parseClockMinutes,
  slotMatchesTimeConstraint,
  type AvailabilityDateSearchMode,
  type AvailabilityTimeConstraint,
} from "./temporal.js";

type AvailabilitySearchSummary = {
  requestedDate?: string;
  searchedFrom?: string;
  searchedThrough?: string;
  actualDate?: string;
  dateShifted: boolean;
  shouldRetrySameSearch: boolean;
  nextSearchDate?: string;
};

type AvailabilityToolResponse = {
  message: string;
  cacheable: boolean;
};

type AvailableSlotsResult = Exclude<AvailabilityResult, MiddlewareFailure>;

const MAX_AVAILABILITY_SLOT_OFFERS = 2;

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

export function storeAvailabilitySlots(
  state: CallState,
  result: AvailabilityResult,
  routing: string | null,
  timeConstraint: AvailabilityTimeConstraint | null,
  dateSearchMode: AvailabilityDateSearchMode,
): AvailabilityToolResponse {
  if (result.status === "error") {
    recordOwnedMiddlewareFailure(state, "getAvailability", result);
    clearAvailabilitySelection(state);
    return cleanAvailabilityErrorResponse();
  }

  const sortedSlots = distinctAvailabilitySlots(result.slots, routing).sort(
    compareAvailabilitySlot,
  );
  const offeredSlots = selectAvailabilitySlots(
    sortedSlots,
    timeConstraint,
  ).slice(0, MAX_AVAILABILITY_SLOT_OFFERS);
  const storedSlots: StoredAvailabilitySlot[] = [];
  for (const slot of offeredSlots) {
    const candidate = storedAvailabilitySlot(slot, "", routing);
    const existingSlot = [
      ...availabilitySlotsForState(state),
      ...storedSlots,
    ].find((storedSlot) => sameAvailabilitySlot(storedSlot, candidate));
    const slotId =
      existingSlot?.slotId ?? reserveAvailabilitySlotIds(state, 1)[0] ?? "";
    storedSlots.push({ ...candidate, slotId });
  }

  mergeAvailabilitySlots(state, storedSlots, routing);
  offeredSlots.forEach((slot, index) => {
    storeAvailabilityBookingToken(
      state,
      storedSlots[index]?.slotId ?? "",
      slot.bookingToken,
      result.bookingTokenExpiresAt,
    );
  });

  const searchedRange = availabilitySearchedRange(result);
  const nextSearchDate = nextIsoDate(searchedRange?.end);
  const search = buildAvailabilitySearchSummary({
    result,
    searchedRange,
    nextSearchDate:
      result.status === "none" || result.status === "found"
        ? nextSearchDate
        : undefined,
  });

  return cleanAvailabilityResponse({
    result,
    search,
    slots: storedSlots,
    dateSearchMode,
    timeConstraint,
  });
}

function storedAvailabilitySlot(
  slot: AvailabilitySlot,
  slotId: string,
  routing: string | null,
): StoredAvailabilitySlot {
  const provider = slotProvider(slot);
  const date = slotDate(slot);
  const time = slotTime(slot);
  const datetime = slot.datetime;
  const spoken = [date, time, provider ? `with ${provider}` : ""]
    .filter(Boolean)
    .join(" ");

  return {
    slotId,
    spoken,
    provider,
    date,
    time,
    datetime,
    routing,
  };
}

function distinctAvailabilitySlots(
  slots: AvailabilitySlot[],
  routing: string | null,
): AvailabilitySlot[] {
  const distinct: AvailabilitySlot[] = [];
  for (const slot of slots) {
    const candidate = storedAvailabilitySlot(slot, "", routing);
    const existingIndex = distinct.findIndex((existing) =>
      sameAvailabilitySlot(
        storedAvailabilitySlot(existing, "", routing),
        candidate,
      ),
    );
    if (existingIndex < 0) {
      distinct.push(slot);
      continue;
    }
    if (
      !distinct[existingIndex]?.bookingToken?.trim() &&
      slot.bookingToken?.trim()
    ) {
      distinct[existingIndex] = slot;
    }
  }
  return distinct;
}

function compareAvailabilitySlot(
  left: AvailabilitySlot,
  right: AvailabilitySlot,
): number {
  return sortableSlotTimestamp(left) - sortableSlotTimestamp(right);
}

function selectAvailabilitySlots(
  sortedSlots: AvailabilitySlot[],
  timeConstraint: AvailabilityTimeConstraint | null,
): AvailabilitySlot[] {
  if (timeConstraint) {
    const matchingSlots = sortedSlots.filter((slot) => {
      const minutes = parseClockMinutes(slotTime(slot));
      return (
        minutes !== null && slotMatchesTimeConstraint(minutes, timeConstraint)
      );
    });
    if (timeConstraint.kind === "near") {
      matchingSlots.sort((left, right) => {
        const dateOrder = slotDate(left).localeCompare(slotDate(right));
        if (dateOrder) return dateOrder;
        const leftMinutes =
          parseClockMinutes(slotTime(left)) ?? Number.MAX_SAFE_INTEGER;
        const rightMinutes =
          parseClockMinutes(slotTime(right)) ?? Number.MAX_SAFE_INTEGER;
        return (
          Math.abs(leftMinutes - timeConstraint.minutes) -
            Math.abs(rightMinutes - timeConstraint.minutes) ||
          leftMinutes - rightMinutes
        );
      });
    }
    return matchingSlots;
  }

  const firstSlot = sortedSlots[0];
  const firstAfternoonSlot = sortedSlots.find((slot) => slotIsAfternoon(slot));
  if (firstSlot && firstAfternoonSlot && firstAfternoonSlot !== firstSlot) {
    return [
      firstSlot,
      firstAfternoonSlot,
      ...sortedSlots.filter(
        (slot) => slot !== firstSlot && slot !== firstAfternoonSlot,
      ),
    ];
  }

  return sortedSlots;
}

function slotIsAfternoon(slot: AvailabilitySlot): boolean {
  const minutes = parseClockMinutes(slotTime(slot));
  return minutes !== null && minutes >= 12 * 60;
}

function sortableSlotTimestamp(slot: AvailabilitySlot): number {
  const datetime = slot.datetime;
  const date = slotDate(slot);
  const time = slotTime(slot);
  const isoLike = datetime || (date && time ? `${date}T${time}` : "");
  const parsed = Date.parse(isoLike);
  if (Number.isFinite(parsed)) return parsed;
  return parseClockMinutes(time) ?? Number.MAX_SAFE_INTEGER;
}

function slotProvider(slot: AvailabilitySlot): string {
  return publicProviderName(slot.provider);
}

function slotDate(slot: AvailabilitySlot): string {
  return slot.date || (slot.datetime.split("T")[0] ?? "");
}

function slotTime(slot: AvailabilitySlot): string {
  return slot.time;
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

function nextIsoDate(date: string | undefined): string | undefined {
  if (!date) return undefined;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return undefined;
  parsed.setUTCDate(parsed.getUTCDate() + 1);
  return parsed.toISOString().slice(0, 10);
}

function spokenIsoDate(date: string | undefined): string | undefined {
  if (!date) return undefined;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(parsed);
}

function availabilitySearchedRange(result: AvailableSlotsResult) {
  const start = result.searchedFrom ?? result.requestedDate;
  const end = result.searchedThrough ?? result.actualDate ?? start;
  if (!start || !end) return undefined;
  return { start, end };
}

function buildAvailabilitySearchSummary(input: {
  result: AvailableSlotsResult;
  searchedRange?: { start: string; end: string };
  nextSearchDate?: string;
}): AvailabilitySearchSummary {
  const { result, searchedRange, nextSearchDate } = input;
  const { requestedDate, actualDate, dateShifted, shouldRetrySameSearch } =
    result;

  return {
    ...(requestedDate ? { requestedDate } : {}),
    ...(searchedRange
      ? {
          searchedFrom: searchedRange.start,
          searchedThrough: searchedRange.end,
        }
      : {}),
    ...(actualDate ? { actualDate } : {}),
    dateShifted,
    shouldRetrySameSearch,
    ...(nextSearchDate ? { nextSearchDate } : {}),
  };
}

function buildAvailabilityMessage(input: {
  result: AvailableSlotsResult;
  search: AvailabilitySearchSummary;
  slots: StoredAvailabilitySlot[];
  dateSearchMode: AvailabilityDateSearchMode;
  timeConstraint: AvailabilityTimeConstraint | null;
}): string {
  const { dateSearchMode, result, search, slots, timeConstraint } = input;
  const spokenSearchedRange =
    search.searchedFrom && search.searchedThrough
      ? `from ${spokenIsoDate(search.searchedFrom) ?? search.searchedFrom} through ${
          spokenIsoDate(search.searchedThrough) ?? search.searchedThrough
        }`
      : "for those dates";
  const conciseSearchedRange =
    search.searchedFrom && search.searchedThrough
      ? `${spokenIsoDate(search.searchedFrom) ?? search.searchedFrom} through ${
          spokenIsoDate(search.searchedThrough) ?? search.searchedThrough
        }`
      : "those dates";
  const noAvailabilityWindow =
    search.searchedFrom && search.searchedThrough
      ? `from ${conciseSearchedRange}`
      : `for ${conciseSearchedRange}`;
  const spokenNextDate = spokenIsoDate(search.nextSearchDate);

  if (result.status === "none") {
    return search.nextSearchDate
      ? `No openings were found ${noAvailabilityWindow}. Ask whether to check starting ${spokenNextDate ?? search.nextSearchDate}, or whether they prefer a different day or time.`
      : `No openings were found ${noAvailabilityWindow}. Ask whether they prefer a different day or time.`;
  }

  if (result.status === "incomplete") {
    return `Availability was not fully checked ${spokenSearchedRange}. Call get_availability again once with the same when phrase.`;
  }

  const primarySlot = slots[0];
  if (!primarySlot) {
    if (timeConstraint) {
      return `No returned openings matched the requested ${describeTimeConstraint(timeConstraint)}. Ask whether the caller wants a different time or day.`;
    }
    return "I do not see openings for those details. Would you like to try a different day or time?";
  }

  const requestedDate = spokenIsoDate(search.requestedDate);
  const dateShiftText =
    dateSearchMode === "specific" && search.dateShifted && requestedDate
      ? `No opening was found on ${requestedDate}. `
      : "";
  const backupSlot = slots[1];
  if (backupSlot) {
    return (
      `${dateShiftText}Offer these options: ${slotOffer(primarySlot)}, or ${slotOffer(backupSlot)}. ` +
      "Ask which one works better. " +
      "If the caller accepts a listed slot, use its appointmentSlotRef; if neither works, ask for another day or time and call get_availability with the caller's new when phrase."
    );
  }

  return (
    `${dateShiftText}Offer this slot: ${slotOffer(primarySlot)}. ` +
    `If the caller accepts it, use appointmentSlotRef ${primarySlot.slotId}; if they want a different day or time, ask for another preference and call get_availability with the caller's new when phrase.`
  );
}

function cleanAvailabilityErrorResponse(): AvailabilityToolResponse {
  return {
    message:
      "I'm having trouble checking availability. Let me try once more. Ask for a different date or time preference.",
    cacheable: false,
  };
}

function slotOffer(slot: StoredAvailabilitySlot): string {
  const spokenDate = spokenIsoDate(slot.date) ?? slot.date;
  const dateTime = [spokenDate, slot.time].filter(Boolean).join(" at ");
  const spoken = [dateTime, slot.provider ? `with ${slot.provider}` : ""]
    .filter(Boolean)
    .join(" ");
  return `${spoken} (appointmentSlotRef ${slot.slotId})`;
}

function cleanAvailabilityResponse(input: {
  result: AvailableSlotsResult;
  search: AvailabilitySearchSummary;
  slots: StoredAvailabilitySlot[];
  dateSearchMode: AvailabilityDateSearchMode;
  timeConstraint: AvailabilityTimeConstraint | null;
}): AvailabilityToolResponse {
  const { dateSearchMode, result, search, slots, timeConstraint } = input;

  return {
    message: buildAvailabilityMessage({
      result,
      search,
      slots,
      dateSearchMode,
      timeConstraint,
    }),
    cacheable: completeAvailabilityResult(result),
  };
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

function sameAvailabilitySlot(
  left: StoredAvailabilitySlot,
  right: StoredAvailabilitySlot,
): boolean {
  return (
    left.date === right.date &&
    left.time === right.time &&
    left.provider === right.provider &&
    left.datetime === right.datetime &&
    left.routing === right.routing
  );
}
