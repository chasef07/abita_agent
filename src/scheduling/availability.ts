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
  replaceAvailabilitySlots,
  reserveAvailabilitySlotIds,
  storeAvailabilityBookingToken,
} from "./state.js";
import { recordOwnedMiddlewareFailure } from "../state/observability.js";

type AvailabilitySearchSummary = {
  searchedFrom?: string;
  searchedThrough?: string;
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
): AvailabilityToolResponse {
  if (result.status === "error") {
    recordOwnedMiddlewareFailure(state, "getAvailability", result);
    clearAvailabilitySelection(state);
    return cleanAvailabilityErrorResponse();
  }

  const offeredSlots =
    result.status === "found"
      ? distinctAvailabilitySlots(result.slots, routing).slice(
          0,
          MAX_AVAILABILITY_SLOT_OFFERS,
        )
      : [];
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

  replaceAvailabilitySlots(state, storedSlots, routing);
  offeredSlots.forEach((slot, index) => {
    storeAvailabilityBookingToken(
      state,
      storedSlots[index]?.slotId ?? "",
      slot.bookingToken,
      result.bookingTokenExpiresAt,
    );
  });

  const searchedRange = availabilitySearchedRange(result);
  const search = searchedRange
    ? {
        searchedFrom: searchedRange.start,
        searchedThrough: searchedRange.end,
      }
    : {};

  return cleanAvailabilityResponse({
    result,
    search,
    slots: storedSlots,
    sourceSlots: offeredSlots,
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

function buildAvailabilityMessage(input: {
  result: AvailableSlotsResult;
  search: AvailabilitySearchSummary;
  slots: StoredAvailabilitySlot[];
  sourceSlots: AvailabilitySlot[];
}): string {
  const { result, search, slots, sourceSlots } = input;
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
  if (result.status === "none") {
    return `No openings were found for the complete search window ${conciseSearchedRange}.`;
  }

  if (result.status === "incomplete") {
    return `Availability was not fully checked ${spokenSearchedRange}. Do not report no availability; call get_availability again once with the same structured preferences.`;
  }

  const primarySlot = slots[0];
  if (!primarySlot) {
    return "I could not verify a bookable opening from the availability response.";
  }

  const backupSlot = slots[1];
  if (backupSlot) {
    return (
      `Offer these options: ${describedSlotOffer(primarySlot, sourceSlots[0])}, or ${describedSlotOffer(backupSlot, sourceSlots[1])}. ` +
      "Ask which one works better. " +
      "Use the corresponding appointmentSlotRef only if the caller accepts that option."
    );
  }

  return (
    `${preferenceDifferenceMessage(sourceSlots[0])}Offer this slot: ${slotOffer(primarySlot)}. ` +
    `Use appointmentSlotRef ${primarySlot.slotId} only if the caller accepts it.`
  );
}

function cleanAvailabilityErrorResponse(): AvailabilityToolResponse {
  return {
    message:
      "I'm having trouble checking availability. Call get_availability once more with the same structured preferences.",
    cacheable: false,
  };
}

function describedSlotOffer(
  slot: StoredAvailabilitySlot,
  source: AvailabilitySlot | undefined,
): string {
  const difference = preferenceDifference(source);
  return difference
    ? `${slotOffer(slot)}; this option differs from the requested ${difference}`
    : slotOffer(slot);
}

function preferenceDifferenceMessage(
  slot: AvailabilitySlot | undefined,
): string {
  const difference = preferenceDifference(slot);
  return difference
    ? `The closest real option differs from the requested ${difference}. `
    : "";
}

function preferenceDifference(
  slot: AvailabilitySlot | undefined,
): string | null {
  if (slot?.preferenceMatch !== "fallback") return null;
  const differences = slot.preferenceDifferences ?? [];
  if (differences.length === 0) return null;
  if (differences.length === 1) return differences[0] ?? null;
  if (differences.length === 2) return differences.join(" and ");
  return `${differences.slice(0, -1).join(", ")}, and ${differences.at(-1)}`;
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
  sourceSlots: AvailabilitySlot[];
}): AvailabilityToolResponse {
  const { result, search, slots, sourceSlots } = input;

  return {
    message: buildAvailabilityMessage({
      result,
      search,
      slots,
      sourceSlots,
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
