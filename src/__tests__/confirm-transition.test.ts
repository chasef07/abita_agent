import { describe, expect, it } from "vitest";
import { createInitialCallState, type PhoneLookupResult } from "../tools.js";
import {
  applyConfirmTransition,
  transitionConfirmWorkflow,
} from "../workflows/engine/confirm-transition.js";

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

describe("confirm transition engine", () => {
  it("starts the confirm workflow from a single entrypoint", () => {
    const state = createState(verifiedLookup());

    const result = applyConfirmTransition(state, { type: "START" });

    expect(result.nextStep).toBe("identify_patient");
    expect(state.workflow.intent).toBe("confirm");
    expect(state.workflow.appointmentIntent).toBe("confirm");
    expect(state.workflow.activeFlow).toBe("identify");
  });

  it("stops safely when no existing patient can be resolved", () => {
    const state = createState();
    applyConfirmTransition(state, { type: "START" });

    const result = applyConfirmTransition(state, {
      type: "IDENTITY_UNRESOLVED",
    });

    expect(result.workflowStopped).toBe(true);
    expect(state.workflow.activeFlow).toBe("none");
  });

  it("completes after an appointment is selected", () => {
    const state = createState(verifiedLookup());
    applyConfirmTransition(state, { type: "START" });
    const identifyResult = applyConfirmTransition(state, {
      type: "IDENTITY_CONFIRMED",
    });

    expect(identifyResult.nextStep).toBe("existing_appointment");
    expect(state.workflow.activeFlow).toBe("existing_appointment");

    const result = applyConfirmTransition(state, {
      type: "EXISTING_APPOINTMENT_SELECTED",
    });

    expect(result.workflowComplete).toBe(true);
    expect(result.nextStep).toBeNull();
    expect(state.workflow.activeFlow).toBe("none");
  });

  it("rejects invalid transitions so confirm bugs fail loudly", () => {
    const state = createState(verifiedLookup());
    applyConfirmTransition(state, { type: "START" });
    applyConfirmTransition(state, { type: "IDENTITY_CONFIRMED" });
    applyConfirmTransition(state, { type: "EXISTING_APPOINTMENT_SELECTED" });

    expect(() =>
      transitionConfirmWorkflow(state, {
        type: "IDENTITY_CONFIRMED",
      }),
    ).toThrow("Invalid confirm transition");
  });
});
