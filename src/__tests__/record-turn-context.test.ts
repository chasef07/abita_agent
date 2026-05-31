import { describe, expect, it } from "vitest";
import { createCanonicalCallState } from "../state/call-state.js";
import { record_turn_context } from "../tools/index.js";

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

describe("record_turn_context tool", () => {
  it("validates committed workflow selections", () => {
    const parameters = record_turn_context.parameters as {
      parse: (value: unknown) => unknown;
      safeParse: (value: unknown) => { success: boolean };
    };

    expect(
      parameters.parse({
        intent: "schedule",
        appointmentLane: "medical_md",
        isEmergency: false,
        confidence: 0.82,
      }),
    ).toEqual({
      intent: "schedule",
      appointmentLane: "medical_md",
      isEmergency: false,
      confidence: 0.82,
    });

    expect(() =>
      parameters.parse({
        intent: "schedule",
        appointmentLane: "medical_md",
        isEmergency: false,
        confidence: 1.2,
      }),
    ).toThrow();

    expect(
      parameters.safeParse({
        intent: "unknown",
        appointmentLane: "not_applicable",
        isEmergency: false,
        confidence: 0.82,
      }).success,
    ).toBe(false);

    expect(
      parameters.safeParse({
        intent: "schedule",
        appointmentLane: "unknown",
        isEmergency: false,
        confidence: 0.82,
      }).success,
    ).toBe(false);

    expect(
      parameters.safeParse({
        intent: "schedule",
        appointmentLane: "not_applicable",
        isEmergency: false,
        confidence: 0.82,
      }).success,
    ).toBe(false);

    expect(
      parameters.safeParse({
        intent: "question",
        appointmentLane: "medical_md",
        isEmergency: false,
        confidence: 0.82,
      }).success,
    ).toBe(false);
  });

  it("records turn context and returns a compact state summary", async () => {
    const state = createState();

    const result = await record_turn_context.execute(
      {
        intent: "schedule",
        appointmentLane: "medical_md",
        isEmergency: false,
        confidence: 0.91,
      },
      {
        ctx: { session: { userData: state } },
        toolCallId: "tool-1",
      } as never,
    );

    expect(result).toEqual({
      recorded: true,
      workflowContext: {
        name: "scheduling",
        guidance: expect.arrayContaining([
          expect.stringContaining("Typical path"),
        ]),
      },
    });
    expect(state.turnContext.last).toEqual({
      intent: "schedule",
      appointmentLane: "medical_md",
      isEmergency: false,
      confidence: 0.91,
    });
  });
});
