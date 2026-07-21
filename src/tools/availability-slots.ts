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
} from "../state/scheduling.js";

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

export type AvailabilityTimePreference = "morning" | "afternoon" | "none";

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
  timePreference: AvailabilityTimePreference = "none",
): AvailabilityToolResponse {
  if (result.status === "error") {
    clearAvailabilitySelection(state);
    return cleanAvailabilityErrorResponse();
  }

  const sortedSlots = [...result.slots].sort(compareAvailabilitySlot);
  const selection = selectAvailabilitySlots(sortedSlots, timePreference);
  const offeredSlots = selection.slots.slice(0, MAX_AVAILABILITY_SLOT_OFFERS);
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
    preferenceFallback: selection.preferenceFallback,
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

function compareAvailabilitySlot(
  left: AvailabilitySlot,
  right: AvailabilitySlot,
): number {
  return sortableSlotTimestamp(left) - sortableSlotTimestamp(right);
}

function selectAvailabilitySlots(
  sortedSlots: AvailabilitySlot[],
  timePreference: AvailabilityTimePreference,
): {
  slots: AvailabilitySlot[];
  preferenceFallback: AvailabilityTimePreference | null;
} {
  if (timePreference === "morning" || timePreference === "afternoon") {
    const preferredSlots = sortedSlots.filter((slot) =>
      slotMatchesTimePreference(slot, timePreference),
    );
    return preferredSlots.length > 0
      ? { slots: preferredSlots, preferenceFallback: null }
      : { slots: sortedSlots, preferenceFallback: timePreference };
  }

  const firstSlot = sortedSlots[0];
  const firstAfternoonSlot = sortedSlots.find((slot) =>
    slotMatchesTimePreference(slot, "afternoon"),
  );
  if (firstSlot && firstAfternoonSlot && firstAfternoonSlot !== firstSlot) {
    return {
      slots: [
        firstSlot,
        firstAfternoonSlot,
        ...sortedSlots.filter(
          (slot) => slot !== firstSlot && slot !== firstAfternoonSlot,
        ),
      ],
      preferenceFallback: null,
    };
  }

  return { slots: sortedSlots, preferenceFallback: null };
}

function slotMatchesTimePreference(
  slot: AvailabilitySlot,
  timePreference: Exclude<AvailabilityTimePreference, "none">,
): boolean {
  const minutes = minutesFromDisplayTime(slotTime(slot));
  if (minutes === null) return false;
  return timePreference === "morning" ? minutes < 12 * 60 : minutes >= 12 * 60;
}

function sortableSlotTimestamp(slot: AvailabilitySlot): number {
  const datetime = slot.datetime;
  const date = slotDate(slot);
  const time = slotTime(slot);
  const isoLike = datetime || (date && time ? `${date}T${time}` : "");
  const parsed = Date.parse(isoLike);
  if (Number.isFinite(parsed)) return parsed;
  return minutesFromDisplayTime(time) ?? Number.MAX_SAFE_INTEGER;
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

function minutesFromDisplayTime(time: string): number | null {
  const match = time.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? "0");
  const meridiem = match[3]?.toUpperCase();
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (meridiem === "PM" && hour !== 12) hour += 12;
  if (meridiem === "AM" && hour === 12) hour = 0;
  return hour * 60 + minute;
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
  preferenceFallback: AvailabilityTimePreference | null;
}): string {
  const { result, search, slots, preferenceFallback } = input;
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
    return `Availability was not fully checked ${spokenSearchedRange}. Call get_availability again once with the same date.`;
  }

  const primarySlot = slots[0];
  if (!primarySlot) {
    return "I do not see openings for those details. Would you like to try a different day or time?";
  }

  const requestedDate = spokenIsoDate(search.requestedDate);
  const dateShiftText =
    search.dateShifted && requestedDate
      ? `No opening was found on ${requestedDate}. `
      : "";
  const preferenceFallbackText = availabilityPreferenceFallbackText(
    preferenceFallback,
    search,
  );
  const backupSlot = slots[1];
  if (backupSlot) {
    return (
      `${dateShiftText}${preferenceFallbackText}Offer these options: ${slotOffer(primarySlot)}, or ${slotOffer(backupSlot)}. ` +
      "Ask which one works better. " +
      "If the caller accepts a listed slot, use its appointmentSlotRef; if neither works, ask for another date to check and call get_availability with that date."
    );
  }

  return (
    `${dateShiftText}${preferenceFallbackText}Offer this slot: ${slotOffer(primarySlot)}. ` +
    `If the caller accepts it, use appointmentSlotRef ${primarySlot.slotId}; if they want a different day or time, ask for another date to check and call get_availability with that date.`
  );
}

function availabilityPreferenceFallbackText(
  timePreference: AvailabilityTimePreference | null,
  search: AvailabilitySearchSummary,
): string {
  if (timePreference === null || timePreference === "none") return "";
  const fallbackDate = spokenIsoDate(search.actualDate ?? search.requestedDate);
  return `No ${timePreference} openings were found${fallbackDate ? ` on ${fallbackDate}` : ""}. `;
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
  preferenceFallback: AvailabilityTimePreference | null;
}): AvailabilityToolResponse {
  const { result, search, slots, preferenceFallback } = input;
  const foundSlots = slots.length > 0;
  const cacheable =
    foundSlots ||
    (result.status !== "incomplete" && !search.shouldRetrySameSearch);

  return {
    message: buildAvailabilityMessage({
      result,
      search,
      slots,
      preferenceFallback,
    }),
    cacheable,
  };
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
