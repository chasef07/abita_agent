import { describe, expect, it } from "vitest";
import { setWorkflowVisitType } from "../scheduling/state.js";
import { removeAvailabilitySlot } from "../scheduling/availability.js";
import { createTestCallState } from "./support/call-state.js";

function createState() {
  return createTestCallState();
}

function seedAvailability(state: ReturnType<typeof createState>) {
  state.availability.latestRouting = "all_three";
  state.availability.bookingTokensBySlotId = { S1: "private-token" };
  state.availability.slots = [
    {
      slotId: "S1",
      provider: "Dr. Bach",
      date: "2026-06-01",
      time: "9:00 AM",
      datetime: "2026-06-01T09:00:00",
      routing: "all_three",
    },
  ];
}

describe("scheduling visit type", () => {
  it("records visit type from business tools", () => {
    const state = createState();

    setWorkflowVisitType(state, "medical");

    expect(state.workflow.visitType).toBe("medical");
  });

  it("clears stale availability when visit type changes", () => {
    const state = createState();
    setWorkflowVisitType(state, "medical");
    seedAvailability(state);

    setWorkflowVisitType(state, "routine_vision");

    expect(state.workflow.visitType).toBe("routine_vision");
    expect(state.availability.slots).toEqual([]);
    expect(state.availability.latestRouting).toBeNull();
    expect(state.availability.bookingTokensBySlotId).toEqual({});
  });

  it("preserves loaded availability when visit type is unchanged", () => {
    const state = createState();
    setWorkflowVisitType(state, "medical");
    seedAvailability(state);
    setWorkflowVisitType(state, "medical");
    expect(state.availability.slots).toHaveLength(1);
    expect(state.availability.bookingTokensBySlotId).toEqual({
      S1: "private-token",
    });
  });

  it("removes a slot and its private token atomically", () => {
    const state = createState();
    seedAvailability(state);

    const remaining = removeAvailabilitySlot(state, "S1");

    expect(remaining).toEqual([]);
    expect(state.availability.bookingTokensBySlotId).toEqual({});
  });
});
