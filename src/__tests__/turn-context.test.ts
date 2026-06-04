import { describe, expect, it } from "vitest";
import {
  applyTurnContextToState,
  createCanonicalCallState,
  workflowContextGuideFor,
  workflowContextNameForTurn,
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

describe("turn context state", () => {
  it("records the latest scheduling turn", () => {
    const state = createState();

    const turn = {
      intent: "schedule",
      appointmentLane: "medical_md",
      isEmergency: false,
      confidence: 0.9,
    } as const;

    applyTurnContextToState(state, turn);

    expect(state.workflow.current).toEqual(turn);
    expect(workflowContextNameForTurn(turn)).toBe("scheduling");
  });

  it("replaces the latest turn instead of preserving a backend workflow field", () => {
    const state = createState();
    applyTurnContextToState(state, {
      intent: "schedule",
      appointmentLane: "routine_od",
      isEmergency: false,
      confidence: 0.88,
    });

    applyTurnContextToState(state, {
      intent: "question",
      appointmentLane: "not_applicable",
      isEmergency: false,
      confidence: 0.86,
    });

    expect(state.workflow.current).toEqual({
      intent: "question",
      appointmentLane: "not_applicable",
      isEmergency: false,
      confidence: 0.86,
    });
    const lastTurn = state.workflow.current;
    expect(lastTurn).toBeDefined();
    expect(
      workflowContextGuideFor(workflowContextNameForTurn(lastTurn!)),
    ).toMatchObject({
      name: "general_question",
      guidance: expect.arrayContaining([
        expect.stringContaining("Answer the caller's question directly"),
      ]),
    });
  });

  it("keeps low confidence as part of the latest turn context", () => {
    const state = createState();

    applyTurnContextToState(state, {
      intent: "schedule",
      appointmentLane: "medical_md",
      isEmergency: false,
      confidence: 0.42,
    });

    expect(state.workflow.current).toEqual({
      intent: "schedule",
      appointmentLane: "medical_md",
      isEmergency: false,
      confidence: 0.42,
    });
    const lastTurn = state.workflow.current;
    expect(lastTurn).toBeDefined();
    expect(workflowContextNameForTurn(lastTurn!)).toBe("scheduling");
  });

  it("derives emergency context from the latest turn", () => {
    const state = createState();

    applyTurnContextToState(state, {
      intent: "schedule",
      appointmentLane: "medical_md",
      isEmergency: true,
      confidence: 0.65,
    });

    expect(state.workflow.current).toEqual({
      intent: "schedule",
      appointmentLane: "medical_md",
      isEmergency: true,
      confidence: 0.65,
    });
    const lastTurn = state.workflow.current;
    expect(lastTurn).toBeDefined();
    expect(
      workflowContextGuideFor(workflowContextNameForTurn(lastTurn!)),
    ).toMatchObject({
      name: "emergency",
      guidance: expect.arrayContaining([expect.stringContaining("urgent")]),
    });
  });
});
