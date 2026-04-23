import { describe, expect, it } from "vitest";
import { createInitialCallState, type PhoneLookupResult } from "../tools.js";
import {
  applyCancelTransition,
  transitionCancelWorkflow,
} from "../workflows/engine/cancel-transition.js";

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

describe("cancel transition engine", () => {
  it("starts the cancel workflow from a single entrypoint", () => {
    const state = createState(verifiedLookup());

    const result = applyCancelTransition(state, { type: "START" });

    expect(result.nextStep).toBe("identify_patient");
    expect(state.workflow.intent).toBe("cancel");
    expect(state.workflow.appointmentIntent).toBe("cancel");
    expect(state.workflow.activeFlow).toBe("identify");
  });

  it("stops safely when no existing patient can be resolved", () => {
    const state = createState();
    applyCancelTransition(state, { type: "START" });

    const result = applyCancelTransition(state, {
      type: "IDENTITY_UNRESOLVED",
    });

    expect(result.workflowStopped).toBe(true);
    expect(state.workflow.activeFlow).toBe("none");
  });

  it("moves from appointment selection to cancellation", () => {
    const state = createState(verifiedLookup());
    applyCancelTransition(state, { type: "START" });
    const identifyResult = applyCancelTransition(state, {
      type: "IDENTITY_CONFIRMED",
    });

    expect(identifyResult.nextStep).toBe("existing_appointment");
    expect(state.workflow.activeFlow).toBe("existing_appointment");

    const result = applyCancelTransition(state, {
      type: "EXISTING_APPOINTMENT_SELECTED",
    });

    expect(result.nextStep).toBe("cancel_original");
    expect(state.workflow.activeFlow).toBe("cancel");
  });

  it("completes after cancellation", () => {
    const state = createState(verifiedLookup());
    applyCancelTransition(state, { type: "START" });
    applyCancelTransition(state, { type: "IDENTITY_CONFIRMED" });
    applyCancelTransition(state, { type: "EXISTING_APPOINTMENT_SELECTED" });

    const result = applyCancelTransition(state, {
      type: "CANCELLATION_COMPLETED",
    });

    expect(result.workflowComplete).toBe(true);
    expect(result.nextStep).toBeNull();
    expect(state.workflow.activeFlow).toBe("none");
  });

  it("rejects invalid transitions so cancel bugs fail loudly", () => {
    const state = createState(verifiedLookup());
    applyCancelTransition(state, { type: "START" });

    expect(() =>
      transitionCancelWorkflow(state, {
        type: "CANCELLATION_COMPLETED",
      }),
    ).toThrow("Invalid cancel transition");
  });
});
