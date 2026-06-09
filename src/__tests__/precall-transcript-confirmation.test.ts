import { describe, expect, it } from "vitest";
import {
  CALLER_CANDIDATE_REF,
  createCanonicalCallState,
} from "../state/call-state.js";
import { confirmPreCallIdentityFromTranscript } from "../runtime/precall-transcript-confirmation.js";

type TestCallState = ReturnType<typeof createCanonicalCallState>;

function createState(): TestCallState {
  return createCanonicalCallState({
    preCallLookup: { status: "not_attempted", durationMs: null },
    officeKey: "crystal-river",
    amdOfficePhone: "+13523202007",
    sipRoomName: "test-room",
    sipParticipantIdentity: "sip-caller",
    callId: "call-test",
    callerPhone: "+19546097250",
    trunkPhone: "+13523202007",
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

describe("pre-call transcript confirmation", () => {
  it("confirms a unique multiple-match candidate from a spelled first name", () => {
    const state = createState();
    state.identity.preCall = {
      status: "multiple_matches_pending_selection",
      source: "phone_lookup",
      callerPhone: "+19546097250",
      candidates: [
        {
          ref: "precall:1",
          firstName: "CHASE",
          lastName: "TEST",
          dob: "04/07/2000",
          patientId: "patient-chase",
          appointments: [],
        },
        {
          ref: "precall:2",
          firstName: "LARRY",
          lastName: "TEST",
          dob: "08/18/2020",
          patientId: "patient-larry",
          appointments: [],
          appointmentsStatus: "none",
          insuranceCarrier: "FLORIDA BLUE SHIELD",
          insPlanId: "plan-larry",
          respPartyId: "resp-larry",
          routing: "all_three",
          allowedProviders: ["Dr. Licht"],
          routingAmbiguous: false,
          preauthRequired: false,
        },
        {
          ref: "precall:3",
          firstName: "TEST",
          lastName: "TEST",
          dob: "10/10/2015",
          patientId: "patient-test",
          appointments: [],
        },
      ],
      identityPromotion: "none",
    };

    const confirmation = confirmPreCallIdentityFromTranscript({
      state,
      transcript: "L-A-R-R-Y.",
      lastAssistantText:
        "Got it. Could you please spell the first name for me?",
    });

    expect(confirmation?.candidateRef).toBe("precall:2");
    expect(confirmation?.systemMessage).toContain("Patient: LARRY TEST.");
    expect(confirmation?.systemMessage).toContain("Patient ID: patient-larry.");
    expect(confirmation?.systemMessage).toContain(
      "No upcoming appointments are loaded.",
    );
    expect(confirmation?.systemMessage).toContain(
      "Do not ask for last name or date of birth again.",
    );
    expect(confirmation?.systemMessage).toContain(
      "appointment questions, booking, or cancellation",
    );
    expect(state.identity.preCall.status).toBe("multiple_match_confirmed");
    expect(state.identity.preCall.selectedCandidateRef).toBe("precall:2");
    expect(state.identity.preCall.identityPromotion).toBe(
      "confirmed_by_transcript",
    );
    expect(state.identity.patient.identityConfirmed).toBe(true);
    expect(state.identity.patient.patientId).toBe("patient-larry");
    expect(state.identity.patient.name).toBe("LARRY TEST");
  });

  it("includes loaded appointments in the durable confirmation message", () => {
    const state = createState();
    state.identity.preCall = {
      status: "multiple_matches_pending_selection",
      source: "phone_lookup",
      callerPhone: "+19546097250",
      candidates: [
        {
          ref: "precall:1",
          firstName: "CHASE",
          lastName: "TEST",
          dob: "04/07/2000",
          patientId: "patient-chase",
          appointments: [
            {
              id: 123,
              date: "June 1",
              time: "9:00 AM",
              provider: "Dr. Bach",
              type: "Office Visit",
              facility: "Spring Hill",
              confirmed: false,
            },
          ],
          appointmentsStatus: "found",
        },
        {
          ref: "precall:2",
          firstName: "LARRY",
          lastName: "TEST",
          dob: "08/18/2020",
          patientId: "patient-larry",
          appointments: [],
          appointmentsStatus: "none",
        },
      ],
      identityPromotion: "none",
    };

    const confirmation = confirmPreCallIdentityFromTranscript({
      state,
      transcript: "Chase",
      lastAssistantText: "Who is the appointment for?",
    });

    expect(confirmation?.candidateRef).toBe("precall:1");
    expect(confirmation?.systemMessage).toContain(
      "Upcoming appointments loaded: June 1 at 9:00 AM with Dr. Bach.",
    );
  });

  it("switches active patient to another pre-call candidate from a first-name prompt", () => {
    const state = createState();
    state.identity.preCall = {
      status: "multiple_match_confirmed",
      source: "phone_lookup",
      callerPhone: "+19546097250",
      selectedCandidateRef: "precall:1",
      candidates: [
        {
          ref: "precall:1",
          firstName: "DAVID",
          lastName: "MEJIA",
          dob: "04/07/2014",
          patientId: "patient-david",
          appointments: [],
          appointmentsStatus: "none",
        },
        {
          ref: "precall:2",
          firstName: "ELLIE",
          lastName: "MEJIA",
          dob: "08/18/2020",
          patientId: "patient-ellie",
          appointments: [],
          appointmentsStatus: "none",
          insuranceCarrier: "self pay",
          routing: "all_three",
          allowedProviders: ["Dr. Calero"],
          routingAmbiguous: false,
          preauthRequired: false,
        },
      ],
      identityPromotion: "confirmed_by_transcript",
    };
    state.identity.patient = {
      ...state.identity.patient,
      status: "verified",
      identityConfirmed: true,
      patientId: "patient-david",
      name: "DAVID MEJIA",
      dob: "04/07/2014",
      appointments: [
        {
          id: 123,
          date: "2026-07-30",
          time: "9:15 AM",
          provider: "Dr. Calero",
          type: "Established Routine",
          facility: "Sweetwater",
          confirmed: true,
        },
      ],
      appointmentsStatus: "found",
    };
    state.identity.latestBookedAppointmentId = 123;
    state.availability.slots = [
      {
        slotId: "A",
        spoken: "2026-07-30 9:15 AM with Dr. Calero",
        provider: "Dr. Calero",
        date: "2026-07-30",
        time: "9:15 AM",
        datetime: "2026-07-30T09:15:00",
        routing: "all_three",
      },
    ];
    state.availability.bookingTokensBySlotId = { A: "old-token" };

    const confirmation = confirmPreCallIdentityFromTranscript({
      state,
      transcript: "For this, Ellie Mejia.",
      lastAssistantText:
        "Yeah, I can help with the second patient too. What's their first name?",
    });

    expect(confirmation?.candidateRef).toBe("precall:2");
    expect(confirmation?.systemMessage).toContain(
      "active patient switched to another pre-call phone candidate",
    );
    expect(state.identity.preCall.selectedCandidateRef).toBe("precall:2");
    expect(state.identity.preCall.identityPromotion).toBe(
      "switched_by_transcript",
    );
    expect(state.identity.patient.patientId).toBe("patient-ellie");
    expect(state.identity.patient.name).toBe("ELLIE MEJIA");
    expect(state.availability.slots).toEqual([]);
    expect(state.availability.bookingTokensBySlotId).toEqual({});
    expect(state.identity.latestBookedAppointmentId).toBeUndefined();
  });

  it("does not confirm a first-name candidate while collecting last name", () => {
    const state = createState();
    state.identity.preCall = {
      status: "multiple_matches_pending_selection",
      source: "phone_lookup",
      callerPhone: "+19546097250",
      candidates: [
        {
          ref: "precall:1",
          firstName: "LARRY",
          lastName: "TEST",
          patientId: "patient-larry",
          appointments: [],
        },
        {
          ref: "precall:2",
          firstName: "TEST",
          lastName: "TEST",
          patientId: "patient-test",
          appointments: [],
        },
      ],
      identityPromotion: "none",
    };

    const confirmation = confirmPreCallIdentityFromTranscript({
      state,
      transcript: "T-E-S-T.",
      lastAssistantText: "Thank you. And what is your last name?",
    });

    expect(confirmation).toBeNull();
    expect(state.identity.preCall.status).toBe(
      "multiple_matches_pending_selection",
    );
    expect(state.identity.patient.identityConfirmed).toBe(false);
  });

  it("does not confirm when multiple candidates share the same first-name signal", () => {
    const state = createState();
    state.identity.preCall = {
      status: "multiple_matches_pending_selection",
      source: "phone_lookup",
      callerPhone: "+19546097250",
      candidates: [
        {
          ref: "precall:1",
          firstName: "KYLE",
          lastName: "TEST",
          patientId: "patient-kyle",
          appointments: [],
        },
        {
          ref: "precall:2",
          firstName: "KYLEE",
          lastName: "TEST",
          patientId: "patient-kylee",
          appointments: [],
        },
      ],
      identityPromotion: "none",
    };

    const confirmation = confirmPreCallIdentityFromTranscript({
      state,
      transcript: "Kyle",
      lastAssistantText: "Who is the appointment for?",
    });

    expect(confirmation).toBeNull();
    expect(state.identity.patient.identityConfirmed).toBe(false);
  });

  it("confirms a single pre-call candidate from first name", () => {
    const state = createState();
    state.identity.preCall = {
      status: "single_match_pending_confirmation",
      source: "phone_lookup",
      callerPhone: "+19546097250",
      selectedCandidateRef: CALLER_CANDIDATE_REF,
      candidates: [
        {
          ref: CALLER_CANDIDATE_REF,
          firstName: "JANE",
          lastName: "DOE",
          patientId: "patient-jane",
          appointments: [],
          appointmentsStatus: "none",
        },
      ],
      identityPromotion: "none",
    };

    const confirmation = confirmPreCallIdentityFromTranscript({
      state,
      transcript: "Jane",
      lastAssistantText:
        "I see a patient record associated with this phone number. Could you please spell the first name for me?",
    });

    expect(confirmation?.candidateRef).toBe(CALLER_CANDIDATE_REF);
    expect(state.identity.preCall.status).toBe("single_match_confirmed");
    expect(state.identity.patient.identityConfirmed).toBe(true);
    expect(state.identity.patient.patientId).toBe("patient-jane");
  });
});
