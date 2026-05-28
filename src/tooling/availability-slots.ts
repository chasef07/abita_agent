import type { CallState, StoredAvailabilitySlot } from "./call-state.js";

type SlotTimeWindow = "morning" | "midday" | "afternoon" | "late_day";

type AvailabilityCandidateSlot = {
  slotId: string;
  spoken: string;
  provider: string;
  date: string;
  time: string;
  timeWindow: SlotTimeWindow;
};

type ModelAvailabilitySlot = {
  slotId: string;
  reply: string;
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

export function clearAvailabilitySlots(state: CallState): void {
  state.lastAvailabilitySlots = [];
  state.bookableAvailabilitySlots = [];
  state.availabilitySlotSequence = 0;
}

export function removeAvailabilitySlot(
  state: CallState,
  slotId: string,
): StoredAvailabilitySlot[] {
  const normalized = normalizeSlotId(slotId);
  state.lastAvailabilitySlots = state.lastAvailabilitySlots.filter(
    (slot) => normalizeSlotId(slot.slotId) !== normalized,
  );
  const remainingBookableSlots = availabilitySlotsForBooking(state).filter(
    (slot) => normalizeSlotId(slot.slotId) !== normalized,
  );
  state.bookableAvailabilitySlots = remainingBookableSlots;
  if (
    state.lastAvailabilitySlots.length === 0 &&
    remainingBookableSlots.length === 0
  ) {
    state.lastAvailabilityRouting = null;
  }
  return remainingBookableSlots;
}

export function publicAvailabilitySlots(slots: StoredAvailabilitySlot[]) {
  return slots.map(({ slotId, spoken, provider, date, time }) => ({
    slotId,
    spoken,
    provider,
    date,
    time,
  }));
}

export function selectedAvailabilitySlot(
  state: CallState,
  slotId: string,
): StoredAvailabilitySlot | null {
  const normalized = normalizeSlotId(slotId);
  const slots = availabilitySlotsForBooking(state);
  const exact = slots.find(
    (slot) => normalizeSlotId(slot.slotId) === normalized,
  );
  if (exact) return exact;
  const naturalMatches = slots.filter((slot) =>
    slotNaturallyMatches(slot, slotId),
  );
  return naturalMatches.length === 1 ? naturalMatches[0] : null;
}

export function availabilitySlotsForBooking(
  state: CallState,
): StoredAvailabilitySlot[] {
  return state.bookableAvailabilitySlots?.length
    ? state.bookableAvailabilitySlots
    : state.lastAvailabilitySlots;
}

export function storeAvailabilitySlots(
  state: CallState,
  rawResponse: unknown,
  routing: string | null,
): unknown {
  const activeSlots = availabilitySlotsForBooking(state);
  if (!isRecord(rawResponse)) {
    state.lastAvailabilitySlots = [];
    return cleanAvailabilityErrorResponse(rawResponse);
  }
  const rawSlots = Array.isArray(rawResponse.slots) ? rawResponse.slots : [];
  const outcome = stringField(rawResponse, "outcome");
  if (
    !Array.isArray(rawResponse.slots) &&
    outcome !== "no_availability" &&
    outcome !== "availability_search_incomplete"
  ) {
    state.lastAvailabilitySlots = [];
    return cleanAvailabilityErrorResponse(rawResponse);
  }

  const firstSlotIndex = nextAvailabilitySlotIndex(state, activeSlots);
  const storedSlots: StoredAvailabilitySlot[] = [];
  const candidateSlots: AvailabilityCandidateSlot[] = [];
  const sortableSlots = rawSlots
    .map((slot, index) => ({ slot, index }))
    .filter(
      (entry): entry is { slot: Record<string, unknown>; index: number } =>
        isRecord(entry.slot),
    )
    .sort(compareRawAvailabilitySlot);

  sortableSlots.forEach(({ slot }) => {
    const rawProvider = typeof slot.provider === "string" ? slot.provider : "";
    const provider = rawProvider ? publicProviderName(rawProvider) : "";
    const datetime = typeof slot.datetime === "string" ? slot.datetime : "";
    const time = typeof slot.time === "string" ? slot.time : "";
    const date =
      typeof slot.date === "string"
        ? slot.date
        : slotDateFromDatetime(datetime);
    const slotId = slotIdForIndex(firstSlotIndex + storedSlots.length);
    const spoken = [date, time, provider ? `with ${provider}` : ""]
      .filter(Boolean)
      .join(" ");

    const storedSlot: StoredAvailabilitySlot = {
      slotId,
      spoken,
      provider,
      date,
      time,
      datetime,
      routing,
    };
    if (typeof slot.bookingToken === "string") {
      storedSlot.bookingToken = slot.bookingToken;
    }
    if (typeof slot.columnId === "number") storedSlot.columnId = slot.columnId;
    if (typeof slot.profileId === "number")
      storedSlot.profileId = slot.profileId;
    if (typeof slot.duration === "number") storedSlot.duration = slot.duration;
    storedSlots.push(storedSlot);

    candidateSlots.push({
      slotId,
      spoken,
      provider,
      date,
      time,
      timeWindow: slotTimeWindow(time),
    });
  });

  state.lastAvailabilitySlots = storedSlots;
  state.bookableAvailabilitySlots = mergeAvailabilitySlots(
    activeSlots,
    storedSlots,
  );
  state.availabilitySlotSequence = firstSlotIndex + storedSlots.length;
  const searchedRange = availabilitySearchedRange(rawResponse);
  const nextSearchDate = nextIsoDate(searchedRange?.end);
  const preferredWindow = state.flow.schedulingGoal?.preferredWindow;
  const requestedWindows = requestedTimeWindows(preferredWindow);
  const earliestMinute = requestedEarliestMinute(preferredWindow);
  const matchesRequestedEarliest = (slot: AvailabilityCandidateSlot) =>
    earliestMinute === undefined ||
    (minutesFromDisplayTime(slot.time) ?? 0) >= earliestMinute;
  const matchingSlots =
    requestedWindows.length > 0
      ? candidateSlots.filter((slot) =>
          requestedWindows.includes(slot.timeWindow),
        )
      : [];
  const matchingWindowSlots = matchingSlots.filter(matchesRequestedEarliest);
  const unmatchedWindowSlots = matchingSlots.filter(
    (slot) => !matchesRequestedEarliest(slot),
  );
  const effectiveMatchingSlots =
    requestedWindows.length > 0 ? matchingWindowSlots : [];
  const otherSlots =
    requestedWindows.length > 0
      ? [
          ...unmatchedWindowSlots,
          ...candidateSlots.filter(
            (slot) => !requestedWindows.includes(slot.timeWindow),
          ),
        ]
      : [];
  const recommendedSlot = effectiveMatchingSlots[0] ?? candidateSlots[0];
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
    preferredWindow,
    candidateSlots,
    recommendedSlot,
    requestedWindows,
    matchingSlots: effectiveMatchingSlots,
    otherSlots,
  });
}

function compareRawAvailabilitySlot(
  left: { slot: Record<string, unknown>; index: number },
  right: { slot: Record<string, unknown>; index: number },
): number {
  const leftTime = sortableSlotTimestamp(left.slot);
  const rightTime = sortableSlotTimestamp(right.slot);
  if (leftTime !== rightTime) return leftTime - rightTime;
  return left.index - right.index;
}

function sortableSlotTimestamp(slot: Record<string, unknown>): number {
  const datetime = typeof slot.datetime === "string" ? slot.datetime : "";
  const date = typeof slot.date === "string" ? slot.date : "";
  const time = typeof slot.time === "string" ? slot.time : "";
  const isoLike = datetime || (date && time ? `${date}T${time}` : "");
  const parsed = Date.parse(isoLike);
  if (Number.isFinite(parsed)) return parsed;
  const minutes = minutesFromDisplayTime(time);
  return minutes ?? Number.MAX_SAFE_INTEGER;
}

export function normalizeSlotId(slotId: string): string {
  return slotId.trim().toUpperCase();
}

export function publicProviderName(provider: string): string {
  return provider
    .replace("Dr. Austin Bach (Overflow)", "Dr. Bach")
    .replace("Dr. Austin Bach", "Dr. Bach")
    .replace("Dr. J. Licht", "Dr. Licht")
    .replace("Dr. D. Noel", "Dr. Noel");
}

function slotDateFromDatetime(datetime: string): string {
  return datetime.split("T")[0] ?? datetime;
}

function mergeAvailabilitySlots(
  existing: StoredAvailabilitySlot[],
  next: StoredAvailabilitySlot[],
): StoredAvailabilitySlot[] {
  if (next.length === 0) return existing;
  const slotsById = new Map<string, StoredAvailabilitySlot>();
  for (const slot of existing) {
    slotsById.set(normalizeSlotId(slot.slotId), slot);
  }
  for (const slot of next) {
    slotsById.set(normalizeSlotId(slot.slotId), slot);
  }
  return [...slotsById.values()];
}

function nextAvailabilitySlotIndex(
  state: CallState,
  slots: StoredAvailabilitySlot[],
): number {
  const nextIndexFromSlots =
    Math.max(-1, ...slots.map((slot) => slotIndexFromId(slot.slotId))) + 1;
  const nextIndex = Math.max(
    state.availabilitySlotSequence ?? 0,
    nextIndexFromSlots,
  );
  state.availabilitySlotSequence = nextIndex;
  return nextIndex;
}

function slotIndexFromId(slotId: string): number {
  const normalized = normalizeSlotId(slotId);
  if (/^[A-Z]$/.test(normalized)) {
    return normalized.charCodeAt(0) - "A".charCodeAt(0);
  }
  const match = normalized.match(/^SLOT_(\d+)$/);
  return match ? Number(match[1]) - 1 : -1;
}

function compactSlotReference(value: string | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/\bdoctor\b/g, "dr")
    .replace(/\bdr\.\s*/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function slotTimeReferences(slot: StoredAvailabilitySlot): string[] {
  const references = new Set<string>();
  const timeSources = [slot.time, slot.datetime?.split("T")[1]?.slice(0, 5)];
  for (const time of timeSources) {
    const match = time?.match(/(\d{1,2}):?(\d{2})?\s*(am|pm)?/i);
    if (!match) continue;
    const hour = match[1] ?? "";
    const minute = match[2] ?? "00";
    const meridiem = match[3]?.toLowerCase() ?? "";
    const unpadded = `${Number(hour)}${minute}`;
    const padded = `${hour.padStart(2, "0")}${minute}`;
    references.add(unpadded);
    references.add(padded);
    if (meridiem) {
      references.add(`${unpadded}${meridiem}`);
      references.add(`${padded}${meridiem}`);
    }
  }
  return [...references].filter(Boolean);
}

function slotNaturallyMatches(
  slot: StoredAvailabilitySlot,
  requestedSlotId: string,
): boolean {
  const requested = compactSlotReference(requestedSlotId);
  if (!requested) return false;
  const aliases = [
    slot.spoken,
    slot.datetime,
    [slot.date, slot.time, slot.provider].filter(Boolean).join(" "),
  ]
    .map(compactSlotReference)
    .filter(Boolean);
  if (
    aliases.some((alias) => alias === requested || alias.includes(requested))
  ) {
    return true;
  }

  const dateReferences = [slot.date, slot.datetime?.split("T")[0]]
    .map(compactSlotReference)
    .filter(Boolean);
  const providerReference = compactSlotReference(slot.provider);
  const hasDate = dateReferences.some((date) => requested.includes(date));
  const hasTime = slotTimeReferences(slot).some((time) =>
    requested.includes(time),
  );
  const hasProvider =
    !providerReference || requested.includes(providerReference);
  return hasDate && hasTime && hasProvider;
}

function slotTimeWindow(time: string): SlotTimeWindow {
  const minutes = minutesFromDisplayTime(time);
  if (minutes === null) return "midday";
  if (minutes < 11 * 60) return "morning";
  if (minutes < 13 * 60) return "midday";
  if (minutes < 16 * 60) return "afternoon";
  return "late_day";
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

function requestedTimeWindows(
  preferredWindow: string | undefined,
): SlotTimeWindow[] {
  const normalized = preferredWindow?.toLowerCase() ?? "";
  const windows: SlotTimeWindow[] = [];
  const asksLateMorning = /\blate morning\b/.test(normalized);
  const asksAfterThree = /\b(after 3|after three)\b/.test(normalized);
  if (
    asksLateMorning ||
    /\b(morning|am|8\s*am|9\s*am|10\s*am)\b/.test(normalized)
  ) {
    windows.push("morning");
  }
  if (/\b(midday|noon|lunch|11\s*am|12\s*pm)\b/.test(normalized)) {
    windows.push("midday");
  }
  if (
    asksAfterThree ||
    /\b(afternoon|after lunch|early afternoon|1\s*pm|2\s*pm|3\s*pm|around 1|around 2|around 3)\b/.test(
      normalized,
    )
  ) {
    windows.push("afternoon");
  }
  if (
    !asksLateMorning &&
    /\b(late|later|end of day|after 3|after three|4\s*pm|5\s*pm|around 4|around 5)\b/.test(
      normalized,
    )
  ) {
    windows.push("late_day");
  }
  return Array.from(new Set(windows));
}

function requestedEarliestMinute(
  preferredWindow: string | undefined,
): number | undefined {
  const normalized = preferredWindow?.toLowerCase() ?? "";
  if (/\b(after 3|after three)\b/.test(normalized)) return 15 * 60;
  return undefined;
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
  preferredWindow?: string;
  requestedWindows: SlotTimeWindow[];
  matchingSlots: AvailabilityCandidateSlot[];
  otherSlots: AvailabilityCandidateSlot[];
  recommendedSlot?: AvailabilityCandidateSlot;
}): string {
  const {
    rawResponse,
    search,
    preferredWindow,
    requestedWindows,
    matchingSlots,
    otherSlots,
    recommendedSlot,
  } = input;
  const outcome = stringField(rawResponse, "outcome") ?? "unknown";
  const spokenSearchedRange =
    search.searchedFrom && search.searchedThrough
      ? `from ${spokenIsoDate(search.searchedFrom) ?? search.searchedFrom} through ${
          spokenIsoDate(search.searchedThrough) ?? search.searchedThrough
        }`
      : "for those dates";
  const spokenNextDate = spokenIsoDate(search.nextSearchDate);
  const nextSearchText = search.nextSearchDate
    ? ` Would you like me to check ${spokenNextDate ?? search.nextSearchDate}, or try a different day or time?`
    : " Would you like to try a different day or time?";

  if (outcome === "no_availability") {
    return `I do not see openings ${spokenSearchedRange}.${nextSearchText}`;
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
  const matchText =
    preferredWindow && requestedWindows.length > 0 && matchingSlots.length === 0
      ? ` It is not exactly ${preferredWindow}, but does that work?`
      : " Does that work?";
  const alternateText =
    otherSlots.length > 0 || matchingSlots.length > 1
      ? " If not, I can offer another option."
      : "";

  return `${foundText}${matchText}${alternateText}`;
}

function cleanAvailabilityErrorResponse(rawResponse: unknown): {
  result: string;
  reply: string;
  next: string;
  slots: ModelAvailabilitySlot[];
} {
  if (!isRecord(rawResponse)) {
    return {
      result: "retry",
      reply: "I’m having trouble checking availability. Let me try once more.",
      next: "retry_search_once",
      slots: [],
    };
  }

  const outcome = stringField(rawResponse, "outcome") ?? "error";
  const reply =
    stringField(rawResponse, "message") ??
    "I’m having trouble checking availability. Let me try once more.";
  const shouldRetry = booleanField(rawResponse, "shouldRetrySameSearch");
  return {
    result: outcome === "availability_search_incomplete" ? "retry" : "error",
    reply,
    next: shouldRetry ? "retry_search_once" : "ask_new_date_or_time",
    slots: [],
  };
}

function publicAvailabilitySlot(slot: AvailabilityCandidateSlot) {
  const spokenDate = spokenIsoDate(slot.date) ?? slot.date;
  return {
    slotId: slot.slotId,
    reply: `${spokenDate} at ${slot.time} with ${slot.provider}`,
    provider: slot.provider,
    date: slot.date,
    time: slot.time,
  };
}

function cleanAvailabilityResponse(input: {
  rawResponse: Record<string, unknown>;
  search: AvailabilitySearchSummary;
  preferredWindow?: string;
  candidateSlots: AvailabilityCandidateSlot[];
  recommendedSlot?: AvailabilityCandidateSlot;
  requestedWindows: SlotTimeWindow[];
  matchingSlots: AvailabilityCandidateSlot[];
  otherSlots: AvailabilityCandidateSlot[];
}) {
  const {
    rawResponse,
    search,
    preferredWindow,
    candidateSlots,
    recommendedSlot,
    requestedWindows,
    matchingSlots,
    otherSlots,
  } = input;
  const outcome = stringField(rawResponse, "outcome") ?? "unknown";
  const availabilityFound = candidateSlots.length > 0;
  const result = availabilityFound
    ? "slots_found"
    : outcome === "availability_search_incomplete"
      ? "retry"
      : "no_slots_found";
  const next =
    result === "slots_found"
      ? "offer_slot"
      : search.shouldRetrySameSearch
        ? "retry_search_once"
        : "ask_new_date_or_time";
  const searched =
    search.searchedFrom && search.searchedThrough
      ? `${search.searchedFrom} through ${search.searchedThrough}`
      : undefined;

  return {
    result,
    reply: buildAvailabilityReply({
      rawResponse,
      search,
      preferredWindow,
      requestedWindows,
      matchingSlots,
      otherSlots,
      recommendedSlot,
    }),
    next,
    ...(searched ? { searched } : {}),
    ...(search.nextSearchDate ? { nextSearchDate: search.nextSearchDate } : {}),
    ...(recommendedSlot ? { slotId: recommendedSlot.slotId } : {}),
    slots: candidateSlots.map(publicAvailabilitySlot),
  };
}

function slotIdForIndex(index: number): string {
  if (index >= 0 && index < 26) {
    return String.fromCharCode("A".charCodeAt(0) + index);
  }
  return `slot_${index + 1}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
