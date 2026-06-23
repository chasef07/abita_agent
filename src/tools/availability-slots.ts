import {
  availabilitySlotsForState,
  clearAvailabilitySelection,
  reserveAvailabilitySlotIds,
  storeAvailabilityBookingToken,
  type CallState,
  type StoredAvailabilitySlot,
} from "../state/call-state.js";

type PublicAvailabilitySlot = {
  slotRef: string;
  spoken: string;
  provider: string;
  date: string;
  time: string;
};

type AvailabilitySearchSummary = {
  requestedDate?: string;
  searchedFrom?: string;
  searchedThrough?: string;
  actualDate?: string;
  dateShifted: boolean;
  shouldRetrySameSearch: boolean;
  nextSearchDate?: string;
};

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
): unknown {
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
  const storedSlots: StoredAvailabilitySlot[] = [];
  for (const slot of sortedSlots) {
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
  sortedSlots.forEach((slot, index) => {
    storeAvailabilityBookingToken(
      state,
      storedSlots[index]?.slotId ?? "",
      typeof slot.bookingToken === "string" ? slot.bookingToken : undefined,
    );
  });

  const searchedRange = availabilitySearchedRange(rawResponse);
  const nextSearchDate = nextIsoDate(searchedRange?.end);
  const recommendedSlot = storedSlots[0];
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
    recommendedSlot,
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

function buildAvailabilityReply(input: {
  rawResponse: Record<string, unknown>;
  search: AvailabilitySearchSummary;
  recommendedSlot?: StoredAvailabilitySlot;
  hasAlternates: boolean;
}): string {
  const { rawResponse, search, recommendedSlot, hasAlternates } = input;
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
  const spokenNextDate = spokenIsoDate(search.nextSearchDate);

  if (outcome === "no_availability") {
    return search.nextSearchDate
      ? `I checked ${conciseSearchedRange} and did not find openings. Ask if they want me to check starting ${spokenNextDate ?? search.nextSearchDate}, or if they prefer a different day or time.`
      : `I checked ${conciseSearchedRange} and did not find openings. Ask if they prefer a different day or time.`;
  }

  if (outcome === "availability_search_incomplete") {
    return `I could not fully check availability ${spokenSearchedRange}. Let me try once more.`;
  }

  if (!recommendedSlot) {
    return "I do not see openings for those details. Would you like to try a different day or time?";
  }

  const requestedDate = spokenIsoDate(search.requestedDate);
  const foundDate =
    spokenIsoDate(search.actualDate) ??
    spokenIsoDate(recommendedSlot.date) ??
    recommendedSlot.date;
  const foundText =
    search.dateShifted && requestedDate && foundDate
      ? `I do not see anything on ${requestedDate}, but I found ${foundDate} at ${recommendedSlot.time} with ${recommendedSlot.provider}.`
      : `I found ${foundDate} at ${recommendedSlot.time} with ${recommendedSlot.provider}.`;
  const alternateText = hasAlternates
    ? " If not, I can offer another option."
    : "";

  return `${foundText} Does that work?${alternateText}`;
}

function cleanAvailabilityErrorResponse(rawResponse: unknown): {
  result: string;
  reply: string;
  next: string;
  slots: PublicAvailabilitySlot[];
} {
  if (!isRecord(rawResponse)) {
    return {
      result: "retry",
      reply: "I'm having trouble checking availability. Let me try once more.",
      next: "retry_search_once",
      slots: [],
    };
  }

  const outcome = stringField(rawResponse, "outcome") ?? "error";
  const reply =
    stringField(rawResponse, "message") ??
    "I'm having trouble checking availability. Let me try once more.";
  const shouldRetry = booleanField(rawResponse, "shouldRetrySameSearch");
  return {
    result: outcome === "availability_search_incomplete" ? "retry" : "error",
    reply,
    next: shouldRetry ? "retry_search_once" : "ask_new_date_or_time",
    slots: [],
  };
}

function publicAvailabilitySlot(slot: StoredAvailabilitySlot) {
  const spokenDate = spokenIsoDate(slot.date) ?? slot.date;
  const dateTime = [spokenDate, slot.time].filter(Boolean).join(" at ");
  const spoken = [dateTime, slot.provider ? `with ${slot.provider}` : ""]
    .filter(Boolean)
    .join(" ");
  return {
    slotRef: slot.slotId,
    spoken,
    provider: slot.provider,
    date: slot.date,
    time: slot.time,
  };
}

function cleanAvailabilityResponse(input: {
  rawResponse: Record<string, unknown>;
  search: AvailabilitySearchSummary;
  slots: StoredAvailabilitySlot[];
  recommendedSlot?: StoredAvailabilitySlot;
}) {
  const { rawResponse, search, slots, recommendedSlot } = input;
  const outcome = stringField(rawResponse, "outcome") ?? "unknown";
  const foundSlots = slots.length > 0;
  const result = foundSlots
    ? "slots_found"
    : outcome === "availability_search_incomplete"
      ? "retry"
      : "no_slots_found";
  const next =
    result === "slots_found"
      ? "offer_slot"
      : search.shouldRetrySameSearch
        ? "retry_search_once"
        : "ask_next_search_or_new_preference";
  const searched =
    search.searchedFrom && search.searchedThrough
      ? `${search.searchedFrom} through ${search.searchedThrough}`
      : undefined;

  return {
    result,
    reply: buildAvailabilityReply({
      rawResponse,
      search,
      recommendedSlot,
      hasAlternates: slots.length > 1,
    }),
    next,
    ...(searched ? { searched } : {}),
    ...(search.nextSearchDate ? { nextSearchDate: search.nextSearchDate } : {}),
    ...(recommendedSlot ? { slotRef: recommendedSlot.slotId } : {}),
    slots: slots.map(publicAvailabilitySlot),
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
