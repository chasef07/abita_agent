import { describe, expect, it } from "vitest";
import { createCanonicalCallState } from "../state/call-state.js";
import { book_appt } from "../tools/index.js";

function createState() {
  const state = createCanonicalCallState({
    preCallLookup: { status: "not_attempted", durationMs: null },
    officeKey: "spring-hill",
    amdOfficePhone: "+17275919997",
    sipRoomName: "test-room",
    sipParticipantIdentity: "sip-caller",
    callId: "call-test",
    callerPhone: "+17275551212",
    trunkPhone: "+17275919997",
    patientId: "patient-1",
    patientName: "Jane Doe",
    dob: "01/01/1980",
    insuranceCarrier: "self pay",
    insPlanId: null,
    respPartyId: null,
    checkedInsurancePlan: "self pay",
    checkedInsuranceCoverageType: "medical",
    routing: "all_three",
    lastAvailabilityRouting: "all_three",
    lastAvailabilitySlots: [],
    allowedProviders: [],
    routingAmbiguous: false,
    preauthRequired: false,
    appointmentsStatus: null,
    appointments: [],
    transferred: false,
  });
  state.patient.identityConfirmed = true;
  state.scheduling.availabilitySlots = [
    {
      slotId: "A",
      spoken: "2026-06-01 9:00 AM with Doctor Smith",
      provider: "Doctor Smith",
      date: "2026-06-01",
      time: "9:00 AM",
      datetime: "2026-06-01T09:00:00",
      routing: "all_three",
    },
  ];
  return state;
}

function createToolContext(state: ReturnType<typeof createState>) {
  return {
    session: { userData: state },
    speechHandle: { allowInterruptions: true },
  };
}

describe("direct session state cleanup", () => {
  it("uses session.userData as the booking state source", async () => {
    const state = createState();

    const result = await book_appt.execute(
      {
        slotId: "A",
        appointmentKind: "medical",
        appointmentReason: "blurry vision",
        referringDoctor: "none",
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    );

    expect(result).toMatchObject({
      outcome: "not_allowed",
      facts: { reason: "booking_requires_booking_token" },
    });
  });
});
