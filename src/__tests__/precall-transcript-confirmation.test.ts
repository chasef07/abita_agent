import { describe, expect, it } from "vitest";
import { CALLER_CANDIDATE_REF } from "../state/call-state.js";
import { confirmPreCallIdentityFromTranscript } from "../runtime/precall-transcript-confirmation.js";
import { createTestCallState } from "./support/call-state.js";

type TestCallState = ReturnType<typeof createTestCallState>;

function createState(): TestCallState {
  return createTestCallState({
    officeKey: "crystal-river",
    amdOfficePhone: "+13523202007",
    callerPhone: "+19546097250",
    trunkPhone: "+13523202007",
  });
}

async function confirmTranscript(
  input: Parameters<typeof confirmPreCallIdentityFromTranscript>[0],
) {
  return confirmPreCallIdentityFromTranscript(input, async () => {
    throw new Error("Fully verified pre-call candidates must not be hydrated");
  });
}

describe("pre-call transcript confirmation", () => {
  it("confirms a unique multiple-match candidate from a spelled first name", async () => {
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

    const confirmation = await confirmTranscript({
      state,
      transcript: "L-A-R-R-Y.",
      lastAssistantText:
        "To help with the appointment, could you spell the patient's first name?",
    });

    expect(confirmation?.candidateRef).toBe("precall:2");
    expect(confirmation?.systemMessage).toContain("Patient: LARRY TEST.");
    expect(confirmation?.systemMessage).not.toContain("patient-larry");
    expect(confirmation?.systemMessage).toContain(
      "Insurance on file: FLORIDA BLUE SHIELD.",
    );
    expect(confirmation?.systemMessage).not.toContain("plan-larry");
    expect(confirmation?.systemMessage).not.toContain("resp-larry");
    expect(confirmation?.systemMessage).toContain(
      "No upcoming appointments are loaded.",
    );
    expect(confirmation?.systemMessage).toContain(
      "Do not ask for last name or date of birth again for this active patient.",
    );
    expect(confirmation?.systemMessage).toContain(
      "appointment questions, booking, or cancellation",
    );
    expect(confirmation?.systemMessage).toContain(
      "different non-preloaded patient",
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

  it("selects the first mentioned pre-call patient when the caller names multiple patients", async () => {
    const state = createState();
    state.identity.preCall = {
      status: "multiple_matches_pending_selection",
      source: "phone_lookup",
      callerPhone: "+17863488102",
      candidates: [
        {
          ref: "precall:1",
          firstName: "BRANDEN",
          lastName: "ANDERSON",
          dob: "04/05/2012",
          patientId: "patient-branden",
          appointments: [],
          appointmentsStatus: "none",
        },
        {
          ref: "precall:2",
          firstName: "BRANDON",
          lastName: "ANDERSON",
          dob: "04/05/2012",
          patientId: "patient-brandon",
          appointments: [],
          appointmentsStatus: "none",
        },
        {
          ref: "precall:3",
          firstName: "MONIQUE",
          lastName: "HAMILTON",
          dob: "12/21/2016",
          patientId: "patient-monique",
          appointments: [],
          appointmentsStatus: "none",
        },
      ],
      identityPromotion: "none",
    };

    const confirmation = await confirmTranscript({
      state,
      transcript: "Brandon and Monique, Brandon Anderson and Monique Hamilton.",
      lastAssistantText:
        "I see a few patient records on file for this number, who's the appointment for?",
    });

    expect(confirmation?.candidateRef).toBe("precall:2");
    expect(confirmation?.systemMessage).toContain("Patient: BRANDON ANDERSON.");
    expect(confirmation?.systemMessage).toContain(
      "The caller also mentioned another patient.",
    );
    expect(confirmation?.systemMessage).toContain(
      "Finish BRANDON ANDERSON first.",
    );
    expect(confirmation?.systemMessage).toContain("resolve_patient");
    expect(confirmation?.systemMessage).not.toContain("Insurance on file:");
    expect(confirmation?.systemMessage).not.toContain(
      "No insurance is currently on file.",
    );
    expect(confirmation?.systemMessage).not.toContain("MONIQUE");
    expect(confirmation?.systemMessage).not.toContain("HAMILTON");
    expect(confirmation?.systemMessage).not.toContain("patient-monique");
    expect(confirmation?.systemMessage).not.toContain("04/05/2012");
    expect(confirmation?.systemMessage).not.toContain("12/21/2016");
    expect(state.identity.preCall.status).toBe("multiple_match_confirmed");
    expect(state.identity.preCall.selectedCandidateRef).toBe("precall:2");
    expect(state.identity.preCall.identityPromotion).toBe(
      "confirmed_by_transcript",
    );
    expect(state.identity.patient.identityConfirmed).toBe(true);
    expect(state.identity.patient.patientId).toBe("patient-brandon");
    expect(state.identity.patient.name).toBe("BRANDON ANDERSON");
  });

  it("keeps only the selected patient in post-confirmation context", async () => {
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
              cancellationToken: "selected-private-cancellation-token",
              date: "June 1",
              time: "9:00 AM",
              provider: "Dr. Bach",
              type: "Office Visit",
              facility: "Spring Hill",
              confirmed: false,
            },
          ],
          appointmentsStatus: "found",
          insuranceCarrier: "SELECTED HEALTH",
        },
        {
          ref: "precall:2",
          firstName: "LARRY",
          lastName: "TEST",
          dob: "08/18/2020",
          patientId: "patient-larry",
          appointments: [
            {
              id: 456,
              cancellationToken: "unselected-private-cancellation-token",
              date: "June 2",
              time: "10:00 AM",
              provider: "Dr. Licht",
              type: "Office Visit",
              facility: "Spring Hill",
              confirmed: false,
            },
          ],
          appointmentsStatus: "found",
          insuranceCarrier: "UNSELECTED HEALTH",
          allowedProviders: ["private-provider-reference"],
        },
      ],
      identityPromotion: "none",
    };

    const confirmation = await confirmTranscript({
      state,
      transcript: "Chase",
      lastAssistantText: "Who is the appointment for?",
    });
    expect(confirmation).not.toBeNull();

    const modelContext = confirmation!.systemMessage;

    expect(confirmation?.candidateRef).toBe("precall:1");
    const appointmentRef =
      state.identity.patient.appointments[0]?.appointmentRef;
    expect(appointmentRef).toMatch(/^appointment-[a-z0-9]+$/);
    expect(modelContext).toContain(
      `Upcoming appointments loaded: June 1 at 9:00 AM with Dr. Bach (appointmentRef ${appointmentRef}).`,
    );
    expect(modelContext).toContain("Insurance on file: SELECTED HEALTH.");
    expect(modelContext).toContain("Patient: CHASE TEST.");
    expect(modelContext).not.toContain("patient-chase");
    expect(modelContext).not.toContain("LARRY TEST");
    expect(modelContext).not.toContain("UNSELECTED HEALTH");
    expect(modelContext).not.toContain("selected-private-cancellation-token");
    expect(modelContext).not.toContain("unselected-private-cancellation-token");
    expect(modelContext).not.toContain("private-provider-reference");
  });

  it("does not confirm a first-name candidate while collecting last name", async () => {
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

    const confirmation = await confirmTranscript({
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

  it("does not confirm when multiple candidates share the same first-name signal", async () => {
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

    const confirmation = await confirmTranscript({
      state,
      transcript: "Kyle",
      lastAssistantText: "Who is the appointment for?",
    });

    expect(confirmation).toBeNull();
    expect(state.identity.patient.identityConfirmed).toBe(false);
  });

  it("prefers the spoken name over earlier filler words", async () => {
    const state = createState();
    state.identity.preCall = {
      status: "multiple_matches_pending_selection",
      source: "phone_lookup",
      callerPhone: "+19546097250",
      candidates: [
        {
          ref: "precall:1",
          firstName: "IAN",
          lastName: "DOE",
          patientId: "patient-ian",
          appointments: [],
        },
        {
          ref: "precall:2",
          firstName: "JANE",
          lastName: "DOE",
          patientId: "patient-jane",
          appointments: [],
        },
      ],
      identityPromotion: "none",
    };

    const confirmation = await confirmTranscript({
      state,
      transcript: "Can I schedule Jane?",
      lastAssistantText: "Who is the appointment for?",
    });

    expect(confirmation?.candidateRef).toBe("precall:2");
    expect(state.identity.patient.patientId).toBe("patient-jane");
  });

  it("fuzzily confirms a pre-call candidate from a near-name transcript", async () => {
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
        },
      ],
      identityPromotion: "none",
    };

    const confirmation = await confirmTranscript({
      state,
      transcript: "Jayne",
      lastAssistantText:
        "I see a patient record associated with this phone number. Could you please spell the first name for me?",
    });

    expect(confirmation?.candidateRef).toBe(CALLER_CANDIDATE_REF);
    expect(state.identity.patient.identityConfirmed).toBe(true);
    expect(state.identity.patient.patientId).toBe("patient-jane");
  });

  it("does not auto-confirm a short-name candidate from unrelated speech", async () => {
    const state = createState();
    state.identity.preCall = {
      status: "single_match_pending_confirmation",
      source: "phone_lookup",
      callerPhone: "+19546097250",
      selectedCandidateRef: CALLER_CANDIDATE_REF,
      candidates: [
        {
          ref: CALLER_CANDIDATE_REF,
          firstName: "IAN",
          lastName: "DOE",
          patientId: "patient-ian",
          appointments: [],
        },
      ],
      identityPromotion: "none",
    };

    const confirmation = await confirmTranscript({
      state,
      transcript: "I am calling for my son.",
      lastAssistantText:
        "I see a patient record associated with this phone number. Could you please spell the first name for me?",
    });

    expect(confirmation).toBeNull();
    expect(state.identity.patient.identityConfirmed).toBe(false);
  });

  it("does not promote a pre-call candidate after the caller confirms a new-chart path", async () => {
    const state = createState();
    state.identity.patient = {
      ...state.identity.patient,
      status: "new",
      identityConfirmed: false,
      patientId: null,
      name: null,
      appointments: [],
      appointmentsStatus: null,
    };
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
        },
      ],
      identityPromotion: "none",
    };

    const confirmation = await confirmTranscript({
      state,
      transcript: "Jane",
      lastAssistantText: "What is the patient's first name for the new chart?",
    });

    expect(confirmation).toBeNull();
    expect(state.identity.patient.status).toBe("new");
    expect(state.identity.patient.identityConfirmed).toBe(false);
    expect(state.identity.patient.patientId).toBeNull();
  });

  it.each([
    "To help with the appointment, could you spell the patient's first name?",
    "Para ayudar con la cita, ¿podría deletrear el primer nombre del paciente?",
  ])(
    "confirms a single pre-call candidate after %s",
    async (lastAssistantText) => {
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

      const confirmation = await confirmTranscript({
        state,
        transcript: "Jane",
        lastAssistantText,
      });

      expect(confirmation?.candidateRef).toBe(CALLER_CANDIDATE_REF);
      expect(state.identity.preCall.status).toBe("single_match_confirmed");
      expect(state.identity.patient.identityConfirmed).toBe(true);
      expect(state.identity.patient.patientId).toBe("patient-jane");
    },
  );
});
