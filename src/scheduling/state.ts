import type { InsuranceCoverageType } from "../insurance-rules.js";
import type {
  CallState,
  InsuranceEligibilityCheck,
  InsuranceSnapshot,
  VisitType,
  StoredAvailabilitySlot,
} from "../state/call-state.js";
import { invalidateAvailabilityReads } from "./availability-coordinator.js";

type SchedulingRouting =
  "bach_only" | "bach_licht" | "all_three" | "optical_only";

const bookingTokenExpiryKey = Symbol("bookingTokenExpiry");

type CallStateWithBookingTokenExpiry = CallState & {
  [bookingTokenExpiryKey]?: Map<string, number>;
};

export function createSchedulingState(input: {
  insuranceCarrier: string | null;
  checkedInsurancePlan: string | null;
  checkedInsuranceCoverageType: InsuranceCoverageType | null;
  routing: string | null;
  preauthRequired: boolean;
}): Pick<CallState, "insurance" | "workflow" | "availability"> {
  const routing = normalizeSchedulingRouting(input.routing);
  const coverageType =
    input.checkedInsuranceCoverageType ??
    (routing === "optical_only" ? "routine_vision" : null);
  const checkedPlan = input.checkedInsurancePlan ?? input.insuranceCarrier;
  const onFile = checkedPlan
    ? insuranceSnapshot({
        plan: checkedPlan,
        canonicalPlan: checkedPlan,
        coverageType,
        currentCarrier: input.insuranceCarrier ?? checkedPlan,
      })
    : null;
  return {
    insurance: {
      onFile,
      lastEligibilityCheck: null,
    },
    workflow: {
      visitType: null,
      routing: {
        routing,
        preauthRequired: input.preauthRequired,
      },
    },
    availability: {
      slots: [],
      requestedStartDate: undefined,
      latestRouting: null,
      bookingTokensBySlotId: {},
      nextSlotIndex: 0,
    },
  };
}

export function insuranceOnFile(state: CallState): InsuranceSnapshot | null {
  return state.insurance.onFile;
}

export function lastInsuranceEligibilityCheck(
  state: CallState,
): InsuranceEligibilityCheck | null {
  return state.insurance.lastEligibilityCheck;
}

export function setInsuranceOnFile(
  state: CallState,
  insurance: InsuranceSnapshot | null,
): void {
  state.insurance.onFile = insurance;
}

export function setLastInsuranceEligibilityCheck(
  state: CallState,
  check: InsuranceEligibilityCheck | null,
): void {
  state.insurance.lastEligibilityCheck = check;
}

export function setWorkflowVisitType(
  state: CallState,
  visitType: VisitType,
): void {
  if (state.workflow.visitType === visitType) return;
  state.workflow.visitType = visitType;
  clearAvailabilitySelection(state, { invalidateReads: true });
}

export function activeRoutingContext(state: CallState): {
  routing: SchedulingRouting | null;
  preauthRequired: boolean;
} {
  return {
    routing: state.workflow.routing.routing ?? null,
    preauthRequired: state.workflow.routing.preauthRequired,
  };
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
    const expiries = bookingTokenExpiriesFor(state);
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
  const expiries = bookingTokenExpiriesFor(state);
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
  bookingTokenExpiriesFor(state).clear();
}

export function resetPatientSchedulingState(
  state: CallState,
  options: { preserveEligibilityCheck?: boolean } = {},
): void {
  const eligibilityCheck = options.preserveEligibilityCheck
    ? state.insurance.lastEligibilityCheck
    : null;
  clearAvailabilitySelection(state, {
    invalidateReads: true,
  });
  state.workflow.visitType = null;
  setLastInsuranceEligibilityCheck(state, eligibilityCheck);
  setRoutingContext(state, {});
}

export function reserveAvailabilitySlotIds(
  state: CallState,
  count: number,
): string[] {
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
  return Array.from({ length: count }, (_, index) =>
    slotIdForIndex(nextSlotIndex + index),
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
  const normalized = normalizeSlotId(slotId);
  state.availability.slots = state.availability.slots.filter(
    (slot) => normalizeSlotId(slot.slotId) !== normalized,
  );
  for (const storedSlotId of Object.keys(
    state.availability.bookingTokensBySlotId,
  )) {
    if (normalizeSlotId(storedSlotId) === normalized) {
      delete state.availability.bookingTokensBySlotId[storedSlotId];
      bookingTokenExpiriesFor(state).delete(storedSlotId);
    }
  }
  return availabilitySlotsForState(state);
}

export function replaceAvailabilitySlots(
  state: CallState,
  slots: StoredAvailabilitySlot[],
  routing: string | null,
): void {
  state.availability.slots = [...slots];
  state.availability.latestRouting = routing;
  state.availability.bookingTokensBySlotId = {};
  bookingTokenExpiriesFor(state).clear();
}

function bookingTokenExpiriesFor(state: CallState): Map<string, number> {
  const sessionState = state as CallStateWithBookingTokenExpiry;
  const existing = sessionState[bookingTokenExpiryKey];
  if (existing) return existing;

  const expiries = new Map<string, number>();
  Object.defineProperty(sessionState, bookingTokenExpiryKey, {
    value: expiries,
    enumerable: false,
  });
  return expiries;
}

function normalizeSchedulingRouting(
  value: string | null | undefined,
): SchedulingRouting | null {
  return value === "bach_only" ||
    value === "bach_licht" ||
    value === "all_three" ||
    value === "optical_only"
    ? value
    : null;
}

export function setRoutingContext(
  state: CallState,
  routing: {
    routing?: string | null;
    preauthRequired?: boolean;
  },
): void {
  const nextRouting = {
    routing: normalizeSchedulingRouting(routing.routing),
    preauthRequired: routing.preauthRequired ?? false,
  };
  const currentRouting = state.workflow.routing;
  if (
    currentRouting.routing !== nextRouting.routing ||
    currentRouting.preauthRequired !== nextRouting.preauthRequired
  ) {
    clearAvailabilitySelection(state, {
      invalidateReads: true,
    });
  }
  state.workflow.routing = nextRouting;
}

export function insuranceSnapshot(input: {
  plan?: string | null;
  canonicalPlan?: string | null;
  coverageType?: InsuranceCoverageType | null;
  currentCarrier?: string | null;
}): InsuranceSnapshot {
  const plan = input.plan?.trim() || input.canonicalPlan?.trim() || null;
  const canonicalPlan = input.canonicalPlan?.trim() || plan;
  return {
    plan,
    canonicalPlan,
    coverageType: input.coverageType ?? null,
    currentCarrier: input.currentCarrier?.trim() || plan,
  };
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

function slotIdForIndex(index: number): string {
  return `S${index + 1}`;
}

function normalizeSlotId(slotId: string): string {
  return slotId.trim().toUpperCase();
}
