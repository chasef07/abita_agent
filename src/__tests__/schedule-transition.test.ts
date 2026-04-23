import { describe, expect, it } from "vitest";
import { createInitialCallState, type PhoneLookupResult } from "../tools.js";
import {
  applyScheduleTransition,
  mapScheduleTaskResultToEvent,
  transitionScheduleWorkflow,
} from "../workflows/engine/schedule-transition.js";

function verifiedLookup(): PhoneLookupResult {
  return {
    status: "verified",
    patientId: "P123",
    name: "Maria Santos",
    dob: "03/05/1982",
    phone: "+18135551234",
    insuranceCarrier: "Florida Blue",
    insPlanId: "IP1",
    respPartyId: "RP1",
    routing: "accepted",
    allowedProviders: [],
    routingAmbiguous: false,
    appointments: [],
  };
}

function createState(phoneLookup?: PhoneLookupResult) {
  return createInitialCallState({
    officeKey: "spring-hill",
    officePhone: "+17275919997",
    amdOfficePhone: "+17275919997",
    sipRoomName: "room",
    sipParticipantIdentity: "sip",
    callerPhone: "+18135551234",
    phoneLookup,
  });
}

describe("schedule transition engine", () => {
  it("starts the schedule workflow from a single entrypoint", () => {
    const state = createState(verifiedLookup());

    const result = applyScheduleTransition(state, { type: "START" });

    expect(result.nextStep).toBe("identify_patient");
    expect(result.activeFlow).toBe("identify");
    expect(result.workflowComplete).toBe(false);
    expect(state.workflow.intent).toBe("schedule");
    expect(state.workflow.appointmentIntent).toBe("schedule");
    expect(state.workflow.activeFlow).toBe("identify");
  });

  it("moves directly to visit reason when identity is confirmed", () => {
    const state = createState(verifiedLookup());
    applyScheduleTransition(state, { type: "START" });

    const result = applyScheduleTransition(state, {
      type: "IDENTITY_CONFIRMED",
    });

    expect(result.nextStep).toBe("visit_reason");
    expect(state.workflow.activeFlow).toBe("visit_reason");
  });

  it("moves into registration when identity resolution allows it", () => {
    const state = createState(verifiedLookup());
    applyScheduleTransition(state, { type: "START" });

    const result = applyScheduleTransition(state, {
      type: "REGISTRATION_ALLOWED",
    });

    expect(result.nextStep).toBe("register_patient");
    expect(state.workflow.activeFlow).toBe("register");
  });

  it("keeps the workflow on visit reason when registration is skipped", () => {
    const state = createState(verifiedLookup());
    applyScheduleTransition(state, { type: "START" });
    applyScheduleTransition(state, { type: "IDENTITY_CONFIRMED" });

    const result = applyScheduleTransition(state, {
      type: "REGISTRATION_SKIPPED",
    });

    expect(result.nextStep).toBe("visit_reason");
    expect(state.workflow.activeFlow).toBe("visit_reason");
  });

  it("completes the schedule workflow after booking", () => {
    const state = createState(verifiedLookup());
    applyScheduleTransition(state, { type: "START" });
    applyScheduleTransition(state, { type: "IDENTITY_CONFIRMED" });
    applyScheduleTransition(state, { type: "REGISTRATION_SKIPPED" });
    applyScheduleTransition(state, { type: "VISIT_REASON_CAPTURED" });
    applyScheduleTransition(state, { type: "SLOT_SELECTED" });

    const result = applyScheduleTransition(state, {
      type: "BOOKING_COMPLETED",
    });

    expect(result.nextStep).toBeNull();
    expect(result.workflowComplete).toBe(true);
    expect(state.workflow.activeFlow).toBe("none");
  });

  it("rejects invalid transitions so schedule bugs fail loudly", () => {
    const state = createState(verifiedLookup());
    applyScheduleTransition(state, { type: "START" });

    expect(() =>
      transitionScheduleWorkflow(state, { type: "BOOKING_COMPLETED" }),
    ).toThrow("Invalid schedule transition");
  });

  it("maps task results into typed schedule events", () => {
    expect(
      mapScheduleTaskResultToEvent("identify_patient", {
        outcome: "registration_allowed",
      }),
    ).toEqual({ type: "REGISTRATION_ALLOWED" });
    expect(
      mapScheduleTaskResultToEvent("register_patient", {
        registered: false,
      }),
    ).toEqual({ type: "REGISTRATION_SKIPPED" });
    expect(
      mapScheduleTaskResultToEvent("booking", {
        booked: true,
      }),
    ).toEqual({ type: "BOOKING_COMPLETED" });
  });
});
