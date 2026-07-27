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
    return {
      message:
        "I'm having trouble checking availability. Please try the search once more.",
      cacheable: false,
    };
  }

  const offeredSlots = distinctAvailabilitySlots(result.slots).slice(
    0,
    MAX_AVAILABILITY_SLOT_OFFERS,
  );
  const existingSlots = availabilitySlotsForState(state);
  const candidates = offeredSlots.map((slot) =>
    storedAvailabilitySlot(slot, "", routing),
  );
  const missingSlotIds = reserveAvailabilitySlotIds(
    state,
    candidates.filter(
      (candidate) =>
        !existingSlots.some((existing) =>
          sameStoredAvailabilitySlot(existing, candidate),
        ),
    ).length,
  );
  const storedSlots = candidates.map((candidate) => {
    const existing = existingSlots.find((slot) =>
      sameStoredAvailabilitySlot(slot, candidate),
    );
    return {
      ...candidate,
      slotId: existing?.slotId ?? missingSlotIds.shift() ?? "",
    };
  });

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
    message: availabilityMessage(result, storedSlots),
    cacheable: completeAvailabilityResult(result),
  };
}

function availabilityMessage(
  result: AvailableSlotsResult,
  slots: StoredAvailabilitySlot[],
): string {
  const searchedRange = spokenSearchRange(result);
  if (result.status === "none") {
    return `No openings were found ${searchedRange}. Ask whether the caller has another day or time preference.`;
  }
  if (result.status === "incomplete") {
    return `Availability was not fully checked ${searchedRange}. Call get_availability again once with the same when phrase.`;
  }

  const primarySlot = slots[0];
  if (!primarySlot) {
    return `No usable openings were returned ${searchedRange}. Try the availability search once more.`;
  }
  const backupSlot = slots[1];
  if (backupSlot) {
    return (
      `Offer these options: ${slotOffer(primarySlot)}, or ${slotOffer(backupSlot)}. ` +
      "Ask which one works better. " +
      "If the caller accepts a listed slot, use its appointmentSlotRef; if neither works, ask for another day or time and call get_availability with the caller's new when phrase."
    );
  }
  return (
    `Offer this slot: ${slotOffer(primarySlot)}. ` +
    `If the caller accepts it, use appointmentSlotRef ${primarySlot.slotId}; if they want a different day or time, ask for another preference and call get_availability with the caller's new when phrase.`
  );
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
  const spoken = [date, slot.time, provider ? `with ${provider}` : ""]
    .filter(Boolean)
    .join(" ");
  return {
    slotId,
    spoken,
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
  const distinct: AvailabilitySlot[] = [];
  for (const slot of slots) {
    const existingIndex = distinct.findIndex((candidate) =>
      sameAvailabilitySlot(candidate, slot),
    );
    if (existingIndex < 0) {
      distinct.push(slot);
    } else if (
      !distinct[existingIndex]?.bookingToken?.trim() &&
      slot.bookingToken?.trim()
    ) {
      distinct[existingIndex] = slot;
    }
  }
  return distinct;
}

function sameAvailabilitySlot(
  left: AvailabilitySlot,
  right: AvailabilitySlot,
): boolean {
  return (
    left.date === right.date &&
    left.time === right.time &&
    left.provider === right.provider &&
    left.datetime === right.datetime
  );
}

function sameStoredAvailabilitySlot(
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

function slotOffer(slot: StoredAvailabilitySlot): string {
  const dateTime = [spokenAppointmentDate(slot.date), slot.time]
    .filter(Boolean)
    .join(" at ");
  const spoken = [dateTime, slot.provider ? `with ${slot.provider}` : ""]
    .filter(Boolean)
    .join(" ");
  return `${spoken} (appointmentSlotRef ${slot.slotId})`;
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
