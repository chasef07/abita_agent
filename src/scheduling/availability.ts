import type { CallState, StoredAvailabilitySlot } from "../state/call-state.js";
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
import { spokenAppointmentDate } from "./spoken-date.js";
import { throwOwnedMiddlewareFailure } from "../runtime/middleware-tool-failure.js";

type AvailabilityToolResponse = {
  message: string;
  cacheable: boolean;
};

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

export function storeAvailabilitySlots(
  state: CallState,
  result: AvailabilityResult,
  routing: string | null,
  canRetry = true,
): AvailabilityToolResponse {
  if (result.status === "error") {
    recordOwnedMiddlewareFailure(state, "getAvailability", result);
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

  replaceAvailabilitySlots(state, storedSlots, routing);
  offeredSlots.forEach((slot, index) => {
    storeAvailabilityBookingToken(
      state,
      storedSlots[index]?.slotId ?? "",
      slot.bookingToken,
      result.bookingTokenExpiresAt,
    );
  });

  return {
    message: availabilityMessage(result, storedSlots, canRetry),
    cacheable: completeAvailabilityResult(result),
  };
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

export function availabilityModelProjection(state: CallState): string {
  const slots = availabilitySlotsForState(state);
  if (
    state.availability.refreshAfter !== undefined &&
    Date.now() >= state.availability.refreshAfter
  ) {
    return "The loaded appointment inventory is stale. Call list_available_appointments to refresh before offering further times. A caller-confirmed selection still requires middleware booking revalidation.";
  }
  if (slots.length === 0) {
    if (state.availability.refreshAfter !== undefined) {
      return "The current appointment inventory is empty. Earlier appointment lists are invalid. Use the latest lookup's coverage when explaining availability; expand the range if the caller wants later dates.";
    }
    return state.availability.version !== undefined ||
      state.availability.nextSlotIndex > 0
      ? "No appointment inventory is active for the current patient, office, and visit. All earlier appointment lists are invalid. Load current appointments before offering times."
      : "";
  }
  return `Current appointment inventory has ${slots.length} slots (${slots[0]?.slotId} through ${slots.at(-1)?.slotId}). Inventory revision ${state.availability.version ?? 0}. Use the most recent list_available_appointments result for dates and times; earlier patient or office inventories are invalid. Keep slot references private and use appointmentSlotRef only after the caller confirms the exact appointment.`;
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
