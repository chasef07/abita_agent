import { describe, expect, it } from "vitest";
import {
  applySchedulingLaneToState,
  applyTurnContextToState,
  createCanonicalCallState,
} from "../state/call-state.js";

function createState() {
  return createCanonicalCallState({
    preCallLookup: { status: "not_attempted", durationMs: null },
    officeKey: "spring-hill",
    amdOfficePhone: "+17275919997",
    sipRoomName: "test-room",
    sipParticipantIdentity: "sip-caller",
    callId: "call-test",
    callerPhone: "+17275551212",
    trunkPhone: "+17275919997",
    patientId: null,
    patientName: null,
    dob: null,
    insuranceCarrier: null,
    insPlanId: null,
    respPartyId: null,
    checkedInsurancePlan: null,
    checkedInsuranceCoverageType: null,
    routing: null,
    lastAvailabilityRouting: null,
    lastAvailabilitySlots: [],
    allowedProviders: [],
    routingAmbiguous: false,
    preauthRequired: false,
    appointmentsStatus: null,
    appointments: [],
    transferred: false,
  });
}

function seedAvailability(state: ReturnType<typeof createState>) {
  state.availability.latestRouting = "all_three";
  state.availability.bookingTokensBySlotId = { A: "private-token" };
  state.availability.latestSearch = {
    signature: "old-search",
    response: { result: "slots_found" },
  };
  state.availability.slots = [
    {
      slotId: "A",
      spoken: "June 1 at 9:00 AM with Dr. Bach",
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
    expect(state.availability.latestRouting).toBeNull();
    expect(state.availability.bookingTokensBySlotId).toEqual({});
    expect(state.availability.latestSearch).toBeUndefined();
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
    expect(state.availability.latestRouting).toBeNull();
    expect(state.availability.bookingTokensBySlotId).toEqual({});
    expect(state.availability.latestSearch).toBeUndefined();
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
});
