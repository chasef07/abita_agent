import { describe, expect, it } from "vitest";
import { createInitialCallState, type PhoneLookupResult } from "../tools.js";
import {
  applyRescheduleTransition,
  mapRescheduleTaskResultToEvent,
  transitionRescheduleWorkflow,
} from "../workflows/engine/reschedule-transition.js";

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

describe("reschedule transition engine", () => {
  it("starts the reschedule workflow from a single entrypoint", () => {
    const state = createState(verifiedLookup());

    const result = applyRescheduleTransition(state, { type: "START" });

    expect(result.nextStep).toBe("identify_patient");
    expect(result.activeFlow).toBe("identify");
    expect(state.workflow.intent).toBe("reschedule");
    expect(state.workflow.appointmentIntent).toBe("reschedule");
  });

  it("stops safely when no existing patient can be resolved", () => {
    const state = createState();
    applyRescheduleTransition(state, { type: "START" });

    const result = applyRescheduleTransition(state, {
      type: "IDENTITY_UNRESOLVED",
    });

    expect(result.nextStep).toBeNull();
    expect(result.workflowStopped).toBe(true);
    expect(state.workflow.activeFlow).toBe("none");
  });

  it("routes from appointment selection to visit reason when the reason is missing", () => {
    const state = createState(verifiedLookup());
    applyRescheduleTransition(state, { type: "START" });
    const identifyResult = applyRescheduleTransition(state, {
      type: "IDENTITY_CONFIRMED",
    });

    expect(identifyResult.nextStep).toBe("existing_appointment");
    expect(state.workflow.activeFlow).toBe("existing_appointment");

    const result = applyRescheduleTransition(state, {
      type: "EXISTING_APPOINTMENT_SELECTED",
    });

    expect(result.nextStep).toBe("visit_reason");
    expect(state.workflow.activeFlow).toBe("visit_reason");
  });

  it("skips visit reason when one is already known", () => {
    const state = createState(verifiedLookup());
    state.scheduling.reasonForVisit = "follow up";
    applyRescheduleTransition(state, { type: "START" });
    applyRescheduleTransition(state, { type: "IDENTITY_CONFIRMED" });

    const result = applyRescheduleTransition(state, {
      type: "EXISTING_APPOINTMENT_SELECTED",
    });

    expect(result.nextStep).toBe("availability");
    expect(state.workflow.activeFlow).toBe("availability");
  });

  it("stops when no current appointment can be found", () => {
    const state = createState(verifiedLookup());
    applyRescheduleTransition(state, { type: "START" });
    applyRescheduleTransition(state, { type: "IDENTITY_CONFIRMED" });

    const result = applyRescheduleTransition(state, {
      type: "NO_EXISTING_APPOINTMENT",
    });

    expect(result.workflowStopped).toBe(true);
    expect(result.workflowComplete).toBe(false);
    expect(result.nextStep).toBeNull();
    expect(state.workflow.activeFlow).toBe("none");
  });

  it("moves from replacement booking to original cancellation", () => {
    const state = createState(verifiedLookup());
    applyRescheduleTransition(state, { type: "START" });
    applyRescheduleTransition(state, { type: "IDENTITY_CONFIRMED" });
    applyRescheduleTransition(state, { type: "EXISTING_APPOINTMENT_SELECTED" });
    applyRescheduleTransition(state, { type: "VISIT_REASON_CAPTURED" });
    applyRescheduleTransition(state, { type: "SLOT_SELECTED" });

    const result = applyRescheduleTransition(state, {
      type: "BOOKING_COMPLETED",
    });

    expect(result.nextStep).toBe("cancel_original");
    expect(state.workflow.activeFlow).toBe("cancel");
  });

  it("completes the reschedule workflow after cancellation", () => {
    const state = createState(verifiedLookup());
    applyRescheduleTransition(state, { type: "START" });
    applyRescheduleTransition(state, { type: "IDENTITY_CONFIRMED" });
    applyRescheduleTransition(state, { type: "EXISTING_APPOINTMENT_SELECTED" });
    applyRescheduleTransition(state, { type: "VISIT_REASON_CAPTURED" });
    applyRescheduleTransition(state, { type: "SLOT_SELECTED" });
    applyRescheduleTransition(state, { type: "BOOKING_COMPLETED" });

    const result = applyRescheduleTransition(state, {
      type: "CANCELLATION_COMPLETED",
    });

    expect(result.nextStep).toBeNull();
    expect(result.workflowComplete).toBe(true);
    expect(state.workflow.activeFlow).toBe("none");
  });

  it("rejects invalid transitions so reschedule bugs fail loudly", () => {
    const state = createState(verifiedLookup());
    applyRescheduleTransition(state, { type: "START" });

    expect(() =>
      transitionRescheduleWorkflow(state, {
        type: "BOOKING_COMPLETED",
      }),
    ).toThrow("Invalid reschedule transition");
  });

  it("maps reschedule task ids into typed events", () => {
    expect(mapRescheduleTaskResultToEvent("existing_appointment")).toEqual({
      type: "EXISTING_APPOINTMENT_SELECTED",
    });
    expect(
      mapRescheduleTaskResultToEvent("existing_appointment", {
        appointmentId: null,
      }),
    ).toEqual({
      type: "NO_EXISTING_APPOINTMENT",
    });
    expect(mapRescheduleTaskResultToEvent("booking")).toEqual({
      type: "BOOKING_COMPLETED",
    });
    expect(mapRescheduleTaskResultToEvent("cancel_original")).toEqual({
      type: "CANCELLATION_COMPLETED",
    });
  });
});
