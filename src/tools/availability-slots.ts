import {
  availabilitySlotsForState,
  clearAvailabilitySelection,
  reserveAvailabilitySlotIds,
  storeAvailabilityBookingToken,
  type CallState,
  type StoredAvailabilitySlot,
} from "../state/call-state.js";

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

export type AvailabilityTimePreference = "morning" | "afternoon" | "none";

const MAX_AVAILABILITY_SLOT_OFFERS = 2;

export function removeAvailabilitySlot(
  state: CallState,
  slotId: string,
): StoredAvailabilitySlot[] {
  const normalized = normalizeSlotId(slotId);
  state.availability.slots = state.availability.slots.filter(
    (slot) => normalizeSlotId(slot.slotId) !== normalized,
  );
  for (const storedSlotId of Object.keys(
    state.availability.bookingTokensBySlotId,
  )) {
    if (normalizeSlotId(storedSlotId) === normalized) {
      delete state.availability.bookingTokensBySlotId[storedSlotId];
    }
  }
  state.availability.latestSearch = undefined;
  return availabilitySlotsForState(state);
}

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
  rawResponse: unknown,
  routing: string | null,
  timePreference: AvailabilityTimePreference = "none",
): AvailabilityToolResponse {
  if (!isRecord(rawResponse)) {
    clearAvailabilitySelection(state);
    return cleanAvailabilityErrorResponse(rawResponse);
  }

  const apiSlots = Array.isArray(rawResponse.slots) ? rawResponse.slots : [];
  const outcome = stringField(rawResponse, "outcome");
  if (
    !Array.isArray(rawResponse.slots) &&
    outcome !== "no_availability" &&
    outcome !== "availability_search_incomplete"
  ) {
    clearAvailabilitySelection(state);
    return cleanAvailabilityErrorResponse(rawResponse);
  }

  const sortedSlots = apiSlots
    .filter(isRecord)
    .sort(compareRawAvailabilitySlot);
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

  state.availability.slots = mergeAvailabilitySlots(
    availabilitySlotsForState(state),
    storedSlots,
  );
  state.availability.latestRouting = routing;
  offeredSlots.forEach((slot, index) => {
    storeAvailabilityBookingToken(
      state,
      storedSlots[index]?.slotId ?? "",
      typeof slot.bookingToken === "string" ? slot.bookingToken : undefined,
    );
  });

  const searchedRange = availabilitySearchedRange(rawResponse);
  const nextSearchDate = nextIsoDate(searchedRange?.end);
  const search = buildAvailabilitySearchSummary({
    rawResponse,
    searchedRange,
    nextSearchDate:
      rawResponse.outcome === "no_availability" ||
      rawResponse.outcome === "availability_found"
        ? nextSearchDate
        : undefined,
  });

  return cleanAvailabilityResponse({
    rawResponse,
    search,
    slots: storedSlots,
    preferenceFallback: selection.preferenceFallback,
  });
}

function storedAvailabilitySlot(
  slot: Record<string, unknown>,
  slotId: string,
  routing: string | null,
): StoredAvailabilitySlot {
  const provider = slotProvider(slot);
  const date = slotDate(slot);
  const time = slotTime(slot);
  const datetime = typeof slot.datetime === "string" ? slot.datetime : "";
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

function compareRawAvailabilitySlot(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): number {
  return sortableSlotTimestamp(left) - sortableSlotTimestamp(right);
}

function selectAvailabilitySlots(
  sortedSlots: Record<string, unknown>[],
  timePreference: AvailabilityTimePreference,
): {
  slots: Record<string, unknown>[];
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
  slot: Record<string, unknown>,
  timePreference: Exclude<AvailabilityTimePreference, "none">,
): boolean {
  const minutes = minutesFromDisplayTime(slotTime(slot));
  if (minutes === null) return false;
  return timePreference === "morning" ? minutes < 12 * 60 : minutes >= 12 * 60;
}

function sortableSlotTimestamp(slot: Record<string, unknown>): number {
  const datetime = typeof slot.datetime === "string" ? slot.datetime : "";
  const date = slotDate(slot);
  const time = slotTime(slot);
  const isoLike = datetime || (date && time ? `${date}T${time}` : "");
  const parsed = Date.parse(isoLike);
  if (Number.isFinite(parsed)) return parsed;
  return minutesFromDisplayTime(time) ?? Number.MAX_SAFE_INTEGER;
}

function slotProvider(slot: Record<string, unknown>): string {
  return typeof slot.provider === "string"
    ? publicProviderName(slot.provider)
    : "";
}

function slotDate(slot: Record<string, unknown>): string {
  if (typeof slot.date === "string") return slot.date;
  return typeof slot.datetime === "string"
    ? (slot.datetime.split("T")[0] ?? "")
    : "";
}

function slotTime(slot: Record<string, unknown>): string {
  return typeof slot.time === "string" ? slot.time : "";
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

function availabilitySearchedRange(rawResponse: Record<string, unknown>) {
  const start =
    typeof rawResponse.searchedFrom === "string"
      ? rawResponse.searchedFrom
      : typeof rawResponse.requestedDate === "string"
        ? rawResponse.requestedDate
        : undefined;
  const end =
    typeof rawResponse.searchedThrough === "string"
      ? rawResponse.searchedThrough
      : typeof rawResponse.actualDate === "string"
        ? rawResponse.actualDate
        : start;
  if (!start || !end) return undefined;
  return { start, end };
}

function stringField(
  record: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = record[field];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function booleanField(
  record: Record<string, unknown>,
  field: string,
): boolean | undefined {
  const value = record[field];
  return typeof value === "boolean" ? value : undefined;
}

function buildAvailabilitySearchSummary(input: {
  rawResponse: Record<string, unknown>;
  searchedRange?: { start: string; end: string };
  nextSearchDate?: string;
}): AvailabilitySearchSummary {
  const { rawResponse, searchedRange, nextSearchDate } = input;
  const requestedDate = stringField(rawResponse, "requestedDate");
  const actualDate = stringField(rawResponse, "actualDate");
  const dateShifted =
    booleanField(rawResponse, "dateShifted") ??
    Boolean(requestedDate && actualDate && requestedDate !== actualDate);

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
    shouldRetrySameSearch:
      booleanField(rawResponse, "shouldRetrySameSearch") ?? false,
    ...(nextSearchDate ? { nextSearchDate } : {}),
  };
}

function buildAvailabilityMessage(input: {
  rawResponse: Record<string, unknown>;
  search: AvailabilitySearchSummary;
  slots: StoredAvailabilitySlot[];
  preferenceFallback: AvailabilityTimePreference | null;
}): string {
  const { rawResponse, search, slots, preferenceFallback } = input;
  const outcome = stringField(rawResponse, "outcome") ?? "unknown";
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

  if (outcome === "no_availability") {
    return search.nextSearchDate
      ? `No openings were found ${noAvailabilityWindow}. Ask whether to check starting ${spokenNextDate ?? search.nextSearchDate}, or whether they prefer a different day or time.`
      : `No openings were found ${noAvailabilityWindow}. Ask whether they prefer a different day or time.`;
  }

  if (outcome === "availability_search_incomplete") {
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

function cleanAvailabilityErrorResponse(
  rawResponse: unknown,
): AvailabilityToolResponse {
  if (!isRecord(rawResponse)) {
    return {
      message:
        "I'm having trouble checking availability. Call get_availability again once with the same date.",
      cacheable: false,
    };
  }

  const outcome = stringField(rawResponse, "outcome") ?? "error";
  const reply =
    stringField(rawResponse, "message") ??
    "I'm having trouble checking availability. Let me try once more.";
  const shouldRetry = booleanField(rawResponse, "shouldRetrySameSearch");
  const retryMessage =
    outcome === "availability_search_incomplete" || shouldRetry
      ? `${reply} Call get_availability again once with the same date.`
      : `${reply} Ask for a different date or time preference.`;
  return {
    message: retryMessage,
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
  rawResponse: Record<string, unknown>;
  search: AvailabilitySearchSummary;
  slots: StoredAvailabilitySlot[];
  preferenceFallback: AvailabilityTimePreference | null;
}): AvailabilityToolResponse {
  const { rawResponse, search, slots, preferenceFallback } = input;
  const outcome = stringField(rawResponse, "outcome") ?? "unknown";
  const foundSlots = slots.length > 0;
  const cacheable =
    foundSlots ||
    (outcome !== "availability_search_incomplete" &&
      !search.shouldRetrySameSearch);

  return {
    message: buildAvailabilityMessage({
      rawResponse,
      search,
      slots,
      preferenceFallback,
    }),
    cacheable,
  };
}

function mergeAvailabilitySlots(
  existingSlots: StoredAvailabilitySlot[],
  newSlots: StoredAvailabilitySlot[],
): StoredAvailabilitySlot[] {
  const mergedSlots = [...existingSlots];
  for (const slot of newSlots) {
    const existingIndex = mergedSlots.findIndex((existingSlot) =>
      sameAvailabilitySlot(existingSlot, slot),
    );
    if (existingIndex >= 0) {
      mergedSlots[existingIndex] = slot;
    } else {
      mergedSlots.push(slot);
    }
  }
  return mergedSlots;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
