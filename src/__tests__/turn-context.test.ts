import { describe, expect, it } from "vitest";
import {
  applySchedulingLaneToState,
  applyTurnContextToState,
  removeAvailabilitySlot,
} from "../scheduling/state.js";
import { createTestCallState } from "./support/call-state.js";

function createState() {
  return createTestCallState();
}

function seedAvailability(state: ReturnType<typeof createState>) {
  state.availability.latestRouting = "all_three";
  state.availability.preferenceBranches = [
    { dates: ["2026-06-02"], time: { operator: "afternoon" } },
  ];
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

describe("turn context state", () => {
  it("records scheduling lane from business tools", () => {
    const state = createState();

    applySchedulingLaneToState(state, "medical_md");

    expect(state.workflow.current).toEqual({
      intent: "schedule",
      appointmentLane: "medical_md",
    });
  });

  it("clears stale availability when scheduling lane changes", () => {
    const state = createState();
    applySchedulingLaneToState(state, "medical_md");
    seedAvailability(state);

    applySchedulingLaneToState(state, "routine_od");

    expect(state.workflow.current?.appointmentLane).toBe("routine_od");
    expect(state.availability.slots).toEqual([]);
    expect(state.availability.preferenceBranches).toEqual([]);
    expect(state.availability.latestRouting).toBeNull();
    expect(state.availability.bookingTokensBySlotId).toEqual({});
  });

  it("clears stale availability when workflow intent changes", () => {
    const state = createState();
    applySchedulingLaneToState(state, "medical_md");
    seedAvailability(state);

    applyTurnContextToState(state, {
      intent: "change_appointment",
      appointmentLane: "not_applicable",
    });

    expect(state.workflow.current).toEqual({
      intent: "change_appointment",
      appointmentLane: "not_applicable",
    });
    expect(state.availability.slots).toEqual([]);
    expect(state.availability.preferenceBranches).toEqual([]);
    expect(state.availability.latestRouting).toBeNull();
    expect(state.availability.bookingTokensBySlotId).toEqual({});
  });

  it("keeps appointment-change context distinct from new scheduling lane", () => {
    const state = createState();

    applyTurnContextToState(state, {
      intent: "change_appointment",
      appointmentLane: "not_applicable",
    });

    expect(state.workflow.current).toEqual({
      intent: "change_appointment",
      appointmentLane: "not_applicable",
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
