import { afterEach, describe, expect, it, vi } from "vitest";

const transferCallerToOfficeMock = vi.hoisted(() =>
  vi.fn(async () => ({
    handoffOfficeKey: "spring-hill",
    handoffTarget: "tel:+16182265883",
  })),
);

vi.mock("../tools/handoff.js", () => ({
  transferCallerToOffice: transferCallerToOfficeMock,
}));

import {
  CALLER_CANDIDATE_REF,
  clearAvailabilitySelection,
  createCanonicalCallState,
  storeAvailabilitySlotPrivateData,
} from "../state/call-state.js";
import {
  add_patient,
  book_appt,
  cancel_appt,
  check_insurance,
  confirm_patient_identity,
  get_availability,
  record_turn_context,
  route_to_spring_hill,
  transfer_call,
  update_insurance,
} from "../tools/index.js";

type TestCallState = ReturnType<typeof createCanonicalCallState>;

function createState(): TestCallState {
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

function createToolContext(state: TestCallState) {
  return {
    session: {
      userData: state,
      say: vi.fn(async () => undefined),
    },
    speechHandle: { allowInterruptions: true },
  };
}

function markSchedulingTriaged(
  state: TestCallState,
  appointmentLane: "medical_md" | "routine_od" = "medical_md",
) {
  state.turnContext.last = {
    intent: "schedule",
    appointmentLane,
    isEmergency: false,
    confidence: 0.92,
  };
  state.scheduling.visitType =
    appointmentLane === "routine_od" ? "routine_vision" : "medical";
}

describe("direct session state cleanup", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    transferCallerToOfficeMock.mockClear();
  });

  it("returns public slots while storing booking tokens privately", async () => {
    const state = createState();
    clearAvailabilitySelection(state);
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        status: "success",
        outcome: "availability_found",
        availabilityFound: true,
        requestedDate: "2026-06-01",
        actualDate: "2026-06-01",
        searchedFrom: "2026-06-01",
        searchedThrough: "2026-06-01",
        shouldRetrySameSearch: false,
        slots: [
          {
            provider: "Dr. Austin Bach",
            date: "2026-06-01",
            time: "9:00 AM",
            datetime: "2026-06-01T09:00:00",
            bookingToken: "private-token",
            columnId: 123,
            profileId: 456,
            duration: 15,
          },
        ],
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const ctx = createToolContext(state);

    const result = (await get_availability.execute(
      {
        date: "2026-06-01",
      },
      {
        ctx: ctx as never,
        toolCallId: "tool-1",
      } as never,
    )) as Record<string, unknown>;

    expect([
      "One moment while I check availability.",
      "Let me check what times are open.",
      "I'll look up available appointments now.",
      "Give me a second to check the schedule.",
    ]).toContain(vi.mocked(ctx.session.say).mock.calls[0]?.[0]);
    expect(result).toMatchObject({
      result: "slots_found",
      reply: "I found June 1 at 9:00 AM with Dr. Bach. Does that work?",
      next: "offer_slot",
      slotId: "A",
      slots: [
        {
          slotId: "A",
          spoken: "June 1 at 9:00 AM with Dr. Bach",
          provider: "Dr. Bach",
          date: "2026-06-01",
          time: "9:00 AM",
        },
      ],
    });
    expect(result).not.toHaveProperty("bookingToken");
    expect(JSON.stringify(result)).not.toContain("private-token");
    expect(state.private.availability.bookingTokens).toEqual({
      A: "private-token",
    });
    expect(state.private.availability).not.toHaveProperty("rawSlots");
    expect(state.scheduling.availabilitySlots).toEqual([
      {
        slotId: "A",
        spoken: "2026-06-01 9:00 AM with Dr. Bach",
        provider: "Dr. Bach",
        date: "2026-06-01",
        time: "9:00 AM",
        datetime: "2026-06-01T09:00:00",
        routing: "all_three",
      },
    ]);
  });

  it("uses routine vision lane instead of verified-patient Bach routing for availability", async () => {
    const state = createState();
    state.officeKey = "hollywood";
    state.patient.insurance = {
      plan: "Aetna",
      canonicalPlan: "Aetna",
      coverageType: "medical",
      currentCarrier: "Aetna",
    };
    state.checkedInsurance = {
      plan: "Aetna",
      canonicalPlan: "Aetna",
      coverageType: "medical",
      currentCarrier: "Aetna",
    };
    state.scheduling.routing = "bach_only";
    state.scheduling.latestAvailabilityRouting = "bach_only";
    state.scheduling.availabilitySlots = [
      {
        slotId: "old",
        spoken: "June 1 at 9:00 AM with Dr. Bach",
        provider: "Dr. Bach",
        date: "2026-06-01",
        time: "9:00 AM",
        datetime: "2026-06-01T09:00:00",
        routing: "bach_only",
      },
    ];

    await record_turn_context.execute(
      {
        intent: "schedule",
        appointmentLane: "routine_od",
        isEmergency: false,
        confidence: 0.92,
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    );

    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        status: "success",
        outcome: "availability_found",
        availabilityFound: true,
        requestedDate: "2026-06-01",
        actualDate: "2026-06-01",
        searchedFrom: "2026-06-01",
        searchedThrough: "2026-06-01",
        shouldRetrySameSearch: false,
        slots: [
          {
            provider: "Dr. Kyler Farnan",
            date: "2026-06-01",
            time: "10:00 AM",
            datetime: "2026-06-01T10:00:00",
            bookingToken: "routine-token",
            columnId: 1555,
            profileId: 2075,
            duration: 30,
          },
        ],
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = (await get_availability.execute(
      {
        date: "2026-06-01",
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-2",
      } as never,
    )) as Record<string, unknown>;

    expect(state.scheduling.visitType).toBe("routine_vision");
    expect(state.scheduling.latestAvailabilityRouting).toBe("optical_only");
    expect(state.scheduling.availabilitySlots).toEqual([
      {
        slotId: "A",
        spoken: "2026-06-01 10:00 AM with Dr. Kyler Farnan",
        provider: "Dr. Kyler Farnan",
        date: "2026-06-01",
        time: "10:00 AM",
        datetime: "2026-06-01T10:00:00",
        routing: "optical_only",
      },
    ]);
    expect(result).toMatchObject({
      result: "slots_found",
      slotId: "A",
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toMatchObject(
      {
        date: "2026-06-01",
        dob: "01/01/1980",
        office: "+19542872010",
        routing: "optical_only",
      },
    );
  });

  it("asks for a date before checking availability", async () => {
    const state = createState();

    await expect(
      get_availability.execute(
        {
          date: "",
        },
        {
          ctx: createToolContext(state) as never,
          toolCallId: "tool-1",
        } as never,
      ),
    ).rejects.toThrow(
      "Ask what date or starting day the caller wants before checking availability.",
    );
  });

  it("requires recorded scheduling triage before booking", async () => {
    const state = createState();
    storeAvailabilitySlotPrivateData(state, "A", "private-token");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      book_appt.execute(
        {
          slotId: "A",
          appointmentReason: "blurry vision",
        },
        {
          ctx: createToolContext(state) as never,
          toolCallId: "tool-1",
        } as never,
      ),
    ).rejects.toThrow(
      "Call record_turn_context with intent schedule and appointmentLane medical_md or routine_od before booking.",
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires a fresh private booking token before booking", async () => {
    const state = createState();
    markSchedulingTriaged(state);
    const ctx = createToolContext(state);

    await expect(
      book_appt.execute(
        {
          slotId: "A",
          appointmentReason: "blurry vision",
        },
        {
          ctx: ctx as never,
          toolCallId: "tool-1",
        } as never,
      ),
    ).rejects.toThrow(
      "Search availability again before booking because the selected slot expired.",
    );

    expect(ctx.speechHandle.allowInterruptions).toBe(false);
    expect(state.scheduling.availabilitySlots).toEqual([]);
  });

  it("books an active slot with private state and returns speech-ready text", async () => {
    const state = createState();
    markSchedulingTriaged(state);
    storeAvailabilitySlotPrivateData(state, "A", "private-token");
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        status: "booked",
        appointmentId: 123,
        providerName: "Doctor Smith",
        locationName: "Spring Hill",
        appointmentTypeName: "Medical",
        message: "Appointment booked successfully",
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const ctx = createToolContext(state);

    const result = await book_appt.execute(
      {
        slotId: "A",
        appointmentReason: "blurry vision",
      },
      {
        ctx: ctx as never,
        toolCallId: "tool-1",
      } as never,
    );

    expect(ctx.speechHandle.allowInterruptions).toBe(false);
    expect(result).toBe("Booked June 1 at 9:00 AM with Doctor Smith.");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toMatchObject({
      bookingToken: "private-token",
      patientId: "patient-1",
      appointmentReason: "blurry vision",
      referringDoctor: "none",
      visitCategory: "medical",
      visitKind: "medical",
      visitReason: "blurry vision",
      patientStatus: "established",
      patientName: "Jane Doe",
      dob: "01/01/1980",
      routing: "all_three",
    });
    expect(body).not.toHaveProperty("appointmentKind");
    expect(body).not.toHaveProperty("columnId");
    expect(state.patient.appointments).toEqual([
      {
        id: 123,
        date: "2026-06-01",
        time: "9:00 AM",
        provider: "Doctor Smith",
        type: "Medical",
        facility: "Spring Hill",
        confirmed: true,
      },
    ]);
    expect(state.scheduling.availabilitySlots).toEqual([]);
  });

  it("does not confirm booking when middleware omits the appointment ID", async () => {
    const state = createState();
    markSchedulingTriaged(state);
    storeAvailabilitySlotPrivateData(state, "A", "private-token");
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        status: "success",
        message: "Appointment booked successfully",
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await book_appt.execute(
      {
        slotId: "A",
        appointmentReason: "blurry vision",
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    );

    expect(result).toBe(
      "I could not confirm the booking because the appointment ID was missing. Check availability again before booking.",
    );
    expect(state.patient.appointments).toEqual([]);
    expect(state.scheduling.availabilitySlots).toEqual([]);
  });

  it("removes unavailable slots and returns the next bookable option", async () => {
    const state = createState();
    markSchedulingTriaged(state);
    state.scheduling.availabilitySlots.push({
      slotId: "B",
      spoken: "2026-06-01 2:00 PM with Doctor Smith",
      provider: "Doctor Smith",
      date: "2026-06-01",
      time: "2:00 PM",
      datetime: "2026-06-01T14:00:00",
      routing: "all_three",
    });
    storeAvailabilitySlotPrivateData(state, "A", "private-token");
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        status: "error",
        outcome: "slot_unavailable",
        message: "This time slot is no longer available.",
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await book_appt.execute(
      {
        slotId: "A",
        appointmentReason: "blurry vision",
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    );

    expect(result).toBe(
      "That time is no longer available. I can offer June 1 at 2:00 PM with Doctor Smith instead.",
    );
    expect(
      state.scheduling.availabilitySlots.map((slot) => slot.slotId),
    ).toEqual(["B"]);
  });

  it("returns a speech-ready result after creating a patient", async () => {
    const state = createState();
    state.patient.patientId = null;
    state.patient.name = null;
    state.patient.identityConfirmed = false;
    state.checkedInsurance = {
      plan: "self pay",
      canonicalPlan: "self pay",
      coverageType: "medical",
      currentCarrier: "self pay",
    };
    const ctx = createToolContext(state);
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        status: "created",
        patientId: "patient-new",
        name: "Jane Doe",
        phone: "+17275551212",
        insuranceCarrier: "self pay",
        routing: "all_three",
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await add_patient.execute(
      {
        firstName: "Jane",
        lastName: "Doe",
        dob: "01/01/1980",
        street: "123 Main St",
        aptSuite: "",
        city: "Spring Hill",
        state: "FL",
        zip: "34606",
        sex: "female",
        insurance: "self pay",
        subscriberName: "Jane Doe",
        subscriberNum: "self pay",
        inboundPhoneConfirmed: true,
        readBack: true,
      },
      { ctx: ctx as never, toolCallId: "tool-1" } as never,
    );

    expect(ctx.speechHandle.allowInterruptions).toBe(false);
    expect(result).toBe(
      "Created a patient chart for Jane Doe. Continue with scheduling.",
    );
    expect(state.patient.patientId).toBe("patient-new");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      firstName: "Jane",
      lastName: "Doe",
      phone: "+17275551212",
      insurance: "self pay",
      subscriberNum: "self pay",
    });
  });

  it("requires read-back confirmation before creating a patient", async () => {
    const state = createState();
    state.patient.patientId = null;
    state.patient.name = null;
    state.patient.identityConfirmed = false;
    state.checkedInsurance = {
      plan: "self pay",
      canonicalPlan: "self pay",
      coverageType: "medical",
      currentCarrier: "self pay",
    };
    const ctx = createToolContext(state);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await add_patient.execute(
      {
        firstName: "Jane",
        lastName: "Doe",
        dob: "01/01/1980",
        street: "123 Main St",
        aptSuite: "",
        city: "Spring Hill",
        state: "FL",
        zip: "34606",
        sex: "female",
        insurance: "self pay",
        subscriberName: "Jane Doe",
        subscriberNum: "self pay",
        phone: "7275551212",
      },
      { ctx: ctx as never, toolCallId: "tool-1" } as never,
    );

    expect(result).toBe(
      "Read back the new patient details first: patient name, date of birth, sex, address, callback phone, email if provided, insurance plan, policyholder name, and member ID. Call add_patient again only after the caller confirms the details are correct.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ctx.speechHandle.allowInterruptions).toBe(true);
  });

  it("asks before using the inbound caller phone for a new patient chart", async () => {
    const state = createState();
    state.patient.patientId = null;
    state.patient.name = null;
    state.patient.identityConfirmed = false;
    state.checkedInsurance = {
      plan: "self pay",
      canonicalPlan: "self pay",
      coverageType: "medical",
      currentCarrier: "self pay",
    };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await add_patient.execute(
      {
        firstName: "Jane",
        lastName: "Doe",
        dob: "01/01/1980",
        street: "123 Main St",
        aptSuite: "",
        city: "Spring Hill",
        state: "FL",
        zip: "34606",
        sex: "female",
        insurance: "self pay",
        subscriberName: "Jane Doe",
        subscriberNum: "self pay",
        readBack: true,
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    );

    expect(result).toBe(
      "Ask the caller: Is the number you are calling from a good callback number to put on file? If yes, call add_patient again with inboundPhoneConfirmed set to true. If not, collect the callback phone number and pass it as phone.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the inbound caller phone after explicit confirmation", async () => {
    const state = createState();
    state.patient.patientId = null;
    state.patient.name = null;
    state.patient.identityConfirmed = false;
    state.checkedInsurance = {
      plan: "self pay",
      canonicalPlan: "self pay",
      coverageType: "medical",
      currentCarrier: "self pay",
    };
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        status: "created",
        patientId: "patient-new",
        name: "Jane Doe",
        phone: "+17275551212",
        insuranceCarrier: "self pay",
        routing: "all_three",
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await add_patient.execute(
      {
        firstName: "Jane",
        lastName: "Doe",
        dob: "01/01/1980",
        street: "123 Main St",
        aptSuite: "",
        city: "Spring Hill",
        state: "FL",
        zip: "34606",
        sex: "female",
        insurance: "self pay",
        subscriberName: "Jane Doe",
        subscriberNum: "self pay",
        phone: "   ",
        inboundPhoneConfirmed: true,
        readBack: true,
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    );

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      phone: "+17275551212",
    });
  });

  it("returns a speech-ready result after confirming identity by lookup", async () => {
    const state = createState();
    state.patient.patientId = null;
    state.patient.name = null;
    state.patient.identityConfirmed = false;
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        status: "verified",
        patientId: "patient-1",
        name: "Jane Doe",
        dob: "01/01/1980",
        phone: "+17275551212",
        insuranceCarrier: "self pay",
        routing: "all_three",
        allowedProviders: [],
        routingAmbiguous: false,
        preauthRequired: false,
        appointmentsStatus: "found",
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
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await confirm_patient_identity.execute(
      {
        firstName: "Jane",
        lastName: "Doe",
        dob: "01/01/1980",
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    expect(result).toBe(
      "Verified existing patient Jane Doe. Insurance on file: self pay. Loaded 1 appointment: June 1 at 9:00 AM with Dr. Bach.",
    );
    expect(state.patient.patientId).toBe("patient-1");
    expect(state.patient.appointments).toHaveLength(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      firstName: "Jane",
      lastName: "Doe",
      dob: "01/01/1980",
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty(
      "phone",
    );
  });

  it("clearly reports verified existing patients without insurance on file", async () => {
    const state = createState();
    state.patient.patientId = null;
    state.patient.name = null;
    state.patient.identityConfirmed = false;
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        status: "verified",
        patientId: "patient-1",
        name: "TEST,CHASE",
        dob: "04/07/2000",
        phone: "(954) 609-7250",
        insuranceCarrier: null,
        insPlanId: null,
        respPartyId: "resp-1",
        routing: null,
        allowedProviders: [],
        routingAmbiguous: false,
        preauthRequired: false,
        appointmentsStatus: "none",
        appointments: [],
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await confirm_patient_identity.execute(
      {
        firstName: "Chase",
        lastName: "Test",
        dob: "04/07/2000",
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    expect(result).toBe(
      "Verified existing patient TEST,CHASE. No insurance is currently on file. No upcoming appointments are loaded.",
    );
    expect(state.patient.patientId).toBe("patient-1");
    expect(state.patient.identityConfirmed).toBe(true);
  });

  it("confirms a pre-call single match from first name without middleware lookup", async () => {
    const state = createCanonicalCallState({
      preCall: {
        status: "single_match_pending_confirmation",
        source: "phone_lookup",
        callerPhone: "+17275551212",
        candidates: [
          {
            ref: CALLER_CANDIDATE_REF,
            firstName: "Jane",
            lastName: "Doe",
            dob: "01/01/1980",
            patientId: "patient-1",
            relationshipToCaller: "self",
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
            insuranceCarrier: "Aetna",
            insPlanId: "plan-1",
            respPartyId: "resp-1",
            routing: "all_three",
            allowedProviders: ["Dr. Bach"],
            routingAmbiguous: false,
            preauthRequired: false,
          },
        ],
        selectedCandidateRef: CALLER_CANDIDATE_REF,
        appointmentLoadStatus: "found",
        identityPromotion: "none",
      },
      preCallLookup: {
        status: "verified",
        durationMs: 42,
        candidateCount: 1,
        appointmentsStatus: "found",
      },
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
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await confirm_patient_identity.execute(
      {
        firstName: "Jaaane",
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toBe(
      "Verified existing patient Jane Doe. Insurance on file: Aetna. Loaded 1 appointment: June 1 at 9:00 AM with Dr. Bach.",
    );
    expect(state.preCall?.status).toBe("single_match_confirmed");
    expect(state.patient.identityConfirmed).toBe(true);
    expect(state.patient.patientId).toBe("patient-1");
    expect(state.patient.insurance?.currentCarrier).toBe("Aetna");
    expect(state.scheduling.routing).toBe("all_three");
  });

  it("confirms a unique multiple-match pre-call candidate from first name only", async () => {
    const state = createState();
    state.patient = {
      ...state.patient,
      status: "unknown",
      identityConfirmed: false,
      patientId: null,
      name: null,
      dob: null,
      phone: null,
      insurance: undefined,
      appointments: [],
      appointmentsStatus: null,
    };
    state.preCall = {
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
          relationshipToCaller: "unknown",
          appointments: [],
          appointmentsStatus: "none",
          insuranceCarrier: null,
          insPlanId: null,
          respPartyId: "resp-chase",
          routing: null,
          allowedProviders: [],
          routingAmbiguous: false,
          preauthRequired: false,
        },
        {
          ref: "precall:2",
          firstName: "KYLE",
          lastName: "TEST",
          dob: "08/18/2000",
          patientId: "patient-kyle",
          relationshipToCaller: "unknown",
          appointments: [],
          appointmentsStatus: "none",
          insuranceCarrier: "Oscar",
          insPlanId: "plan-kyle",
          respPartyId: "resp-kyle",
          routing: "bach_licht",
          allowedProviders: ["Dr. Licht"],
          routingAmbiguous: false,
          preauthRequired: false,
        },
      ],
      identityPromotion: "none",
    };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await confirm_patient_identity.execute(
      {
        firstName: "Chase",
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toBe(
      "Verified existing patient CHASE TEST. No insurance is currently on file. No upcoming appointments are loaded.",
    );
    expect(state.preCall.status).toBe("multiple_match_confirmed");
    expect(state.preCall.selectedCandidateRef).toBe("precall:1");
    expect(state.patient.identityConfirmed).toBe(true);
    expect(state.patient.patientId).toBe("patient-chase");
  });

  it("asks for more identity details when multiple pre-call candidates share a first name", async () => {
    const state = createState();
    state.patient = {
      ...state.patient,
      status: "unknown",
      identityConfirmed: false,
      patientId: null,
      name: null,
      dob: null,
      phone: null,
      insurance: undefined,
      appointments: [],
      appointmentsStatus: null,
    };
    state.preCall = {
      status: "multiple_matches_pending_selection",
      source: "phone_lookup",
      callerPhone: "+19546097250",
      candidates: [
        {
          ref: "precall:1",
          firstName: "KYLE",
          lastName: "TEST",
          dob: "08/18/2000",
          patientId: "patient-kyle",
          appointments: [],
        },
        {
          ref: "precall:2",
          firstName: "KYLEE",
          lastName: "TEST",
          dob: "10/10/2015",
          patientId: "patient-kylee",
          appointments: [],
        },
      ],
      identityPromotion: "none",
    };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      confirm_patient_identity.execute(
        {
          firstName: "Kyle",
        },
        {
          ctx: createToolContext(state) as never,
          toolCallId: "tool-1",
        } as never,
      ),
    ).rejects.toThrow(
      "More than one preloaded patient matches that first name. Ask for the patient's date of birth or full name, then call confirm_patient_identity again.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.patient.identityConfirmed).toBe(false);
  });

  it("does not call middleware until full identity is provided", async () => {
    const state = createState();
    state.preCall = {
      status: "no_match",
      source: "phone_lookup",
      callerPhone: "+17275551212",
      candidates: [],
      identityPromotion: "none",
    };
    state.patient.patientId = null;
    state.patient.name = null;
    state.patient.identityConfirmed = false;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      confirm_patient_identity.execute(
        {
          firstName: "Jane",
        },
        {
          ctx: createToolContext(state) as never,
          toolCallId: "tool-1",
        } as never,
      ),
    ).rejects.toThrow(
      "Collect the patient's first name, last name, and date of birth before looking up identity.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stores accepted insurance from check_insurance", async () => {
    const state = createState();

    const result = (await check_insurance.execute(
      {
        plan: "Blue Cross",
        coverageType: "medical",
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    )) as Record<string, unknown>;

    expect(result).toEqual({
      status: "accepted",
      canProceed: true,
      canonicalPlan: "Florida Blue",
      clarificationNeeded: null,
      callerMessage: "yeah we take Blue Cross Blue Shield.",
    });
    expect(result).not.toHaveProperty("outcome");
    expect(result).not.toHaveProperty("facts");
    expect(result).not.toHaveProperty("retryable");
    expect(state.checkedInsurance).toEqual({
      plan: "Blue Cross",
      canonicalPlan: "Florida Blue",
      coverageType: "medical",
      currentCarrier: "Florida Blue",
    });
    expect(state.scheduling.coverageType).toBe("medical");
  });

  it("returns a Spring Hill routing option when Crystal River does not accept the plan", async () => {
    const state = createState();
    state.officeKey = "crystal-river";

    const result = (await check_insurance.execute(
      {
        plan: "Humana PPO",
        coverageType: "medical",
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    )) as Record<string, unknown>;

    expect(result).toMatchObject({
      status: "not_accepted",
      canProceed: false,
      canonicalPlan: null,
      acceptedAtAlternateOffice: "Spring Hill",
      alternateCanonicalPlan: "Humana PPO",
      routeTool: "route_to_spring_hill",
    });
    expect(result.callerMessage).toContain("Spring Hill accepts Humana PPO");
    expect(result.callerMessage).toContain(
      "Would you like to schedule there instead?",
    );
    expect(state.checkedInsurance.canonicalPlan).toBeNull();
    expect(state.scheduling.coverageType).toBeNull();
  });

  it("updates insurance from the checked medical plan in session state", async () => {
    const state = createState();
    state.patient.insurance = {
      plan: "Old Plan",
      canonicalPlan: "Old Plan",
      coverageType: "medical",
      currentCarrier: "Old Plan",
    };
    state.checkedInsurance = {
      plan: "Aetna",
      canonicalPlan: "Aetna Commercial",
      coverageType: "medical",
      currentCarrier: "Aetna Commercial",
    };
    state.private.patientBackend = {
      insPlanId: "ins-old",
      respPartyId: "resp-1",
    };
    const ctx = createToolContext(state);
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        status: "updated",
        patientId: "patient-1",
        oldInsurance: "Old Plan",
        newInsurance: "Aetna Commercial",
        routing: "bach_only",
        allowedProviders: ["Dr. Bach"],
        routingAmbiguous: false,
        preauthRequired: true,
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await update_insurance.execute(
      {
        subscriberNum: "ABC123",
      },
      { ctx: ctx as never, toolCallId: "tool-1" } as never,
    );

    expect(ctx.speechHandle.allowInterruptions).toBe(false);
    expect(result).toBe("Updated insurance to Aetna Commercial.");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      patientId: "patient-1",
      dob: "01/01/1980",
      insPlanId: "ins-old",
      respPartyId: "resp-1",
      oldInsurance: "Old Plan",
      insurance: "Aetna Commercial",
      coverageType: "medical",
      subscriberNum: "ABC123",
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty(
      "subscriberName",
    );
    expect(state.patient.insurance).toEqual({
      plan: "Aetna Commercial",
      canonicalPlan: "Aetna Commercial",
      coverageType: "medical",
      currentCarrier: "Aetna Commercial",
    });
    expect(state.checkedInsurance).toEqual(state.patient.insurance);
    expect(state.private.patientBackend).toEqual({
      insPlanId: null,
      respPartyId: "resp-1",
    });
    expect(state.scheduling.coverageType).toBe("medical");
    expect(state.scheduling.routing).toBe("bach_only");
    expect(state.scheduling.allowedProviders).toEqual(["Dr. Bach"]);
    expect(state.scheduling.preauthRequired).toBe(true);
    expect(state.scheduling.availabilitySlots).toEqual([]);
  });

  it("uses self pay without collecting a member ID", async () => {
    const state = createState();
    state.checkedInsurance = {
      plan: "Self Pay",
      canonicalPlan: "Self Pay",
      coverageType: "medical",
      currentCarrier: "Self Pay",
    };
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        status: "updated",
        newInsurance: "Self Pay",
        routing: "all_three",
        allowedProviders: [],
        routingAmbiguous: false,
        preauthRequired: false,
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await update_insurance.execute({}, {
      ctx: createToolContext(state) as never,
      toolCallId: "tool-1",
    } as never);

    expect(result).toBe("Updated insurance to Self Pay.");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      insurance: "Self Pay",
      subscriberNum: "self pay",
    });
  });

  it("cancels a loaded appointment and removes it from session state", async () => {
    const state = createState();
    state.patient.appointments = [
      {
        id: 123,
        date: "June 5",
        time: "10:00 AM",
        provider: "Dr. Bach",
        type: "Follow-up",
        facility: "Spring Hill",
        confirmed: false,
      },
    ];
    const ctx = createToolContext(state);
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        status: "cancelled",
        appointmentId: 123,
        message: "Appointment cancelled successfully",
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await cancel_appt.execute(
      {
        appointmentId: 123,
      },
      { ctx: ctx as never, toolCallId: "tool-1" } as never,
    );

    expect(ctx.speechHandle.allowInterruptions).toBe(false);
    expect(result).toBe("Cancelled the appointment on June 5 at 10:00 AM.");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      appointmentId: 123,
      patientId: "patient-1",
      office: "+17275919997",
    });
    expect(state.patient.appointments).toEqual([]);
    expect(state.private.appointments).toEqual({});
  });

  it("cancels a loaded appointment selected by caller date", async () => {
    const state = createState();
    state.patient.appointments = [
      {
        id: 111,
        date: "Monday, June 1, 2026",
        time: "9:00 AM",
        provider: "Dr. Bach",
        type: "Follow-up",
        facility: "Spring Hill",
        confirmed: false,
      },
      {
        id: 222,
        date: "Tuesday, June 2, 2026",
        time: "10:00 AM",
        provider: "Dr. Licht",
        type: "Routine Vision",
        facility: "Crystal River",
        confirmed: false,
      },
    ];
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        status: "cancelled",
        appointmentId: 222,
        message: "Appointment cancelled successfully",
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await cancel_appt.execute(
      {
        appointmentDate: "June 2nd",
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    );

    expect(result).toBe(
      "Cancelled the appointment on Tuesday, June 2, 2026 at 10:00 AM.",
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      appointmentId: 222,
      patientId: "patient-1",
      office: "+17275919997",
    });
    expect(
      state.patient.appointments.map((appointment) => appointment.id),
    ).toEqual([111]);
  });

  it("asks for clarification when a caller date matches multiple appointments", async () => {
    const state = createState();
    state.patient.appointments = [
      {
        id: 111,
        date: "Tuesday, June 2, 2026",
        time: "9:00 AM",
        provider: "Dr. Bach",
        type: "Follow-up",
        facility: "Spring Hill",
        confirmed: false,
      },
      {
        id: 222,
        date: "Tuesday, June 2, 2026",
        time: "2:00 PM",
        provider: "Dr. Licht",
        type: "Routine Vision",
        facility: "Crystal River",
        confirmed: false,
      },
    ];
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await cancel_appt.execute(
      {
        appointmentDate: "June 2",
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    );

    expect(result).toBe(
      "I found more than one matching appointment. Loaded appointments: Tuesday, June 2, 2026 at 9:00 AM with Dr. Bach; Tuesday, June 2, 2026 at 2:00 PM with Dr. Licht.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cancels the latest booked appointment without replaying stale pre-call appointments", async () => {
    const state = createState();
    markSchedulingTriaged(state, "routine_od");
    state.scheduling.availabilitySlots[0] = {
      ...state.scheduling.availabilitySlots[0],
      routing: "optical_only",
    };
    state.scheduling.latestAvailabilityRouting = "optical_only";
    state.preCall = {
      status: "multiple_match_confirmed",
      source: "phone_lookup",
      callerPhone: "+17275551212",
      candidates: [
        {
          ref: "precall:1",
          firstName: "Jane",
          lastName: "Doe",
          dob: "01/01/1980",
          patientId: "patient-1",
          relationshipToCaller: "unknown",
          appointments: [],
          appointmentsStatus: "none",
        },
      ],
      selectedCandidateRef: "precall:1",
      identityPromotion: "confirmed_by_identity_tool",
    };
    storeAvailabilitySlotPrivateData(state, "A", "private-token");
    const fetchMock = vi.fn(async (url: string | URL) => {
      const path = String(url);
      if (path.includes("/api/appointment/book")) {
        return {
          ok: true,
          json: async () => ({
            status: "booked",
            appointmentId: 456,
            providerName: "Doctor Smith",
            locationName: "Spring Hill",
            appointmentTypeName: "Routine Vision",
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          status: "cancelled",
          appointmentId: 456,
          message: "Appointment cancelled successfully",
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    await book_appt.execute(
      {
        slotId: "A",
        appointmentReason: "eye exam",
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    );

    expect(state.patient.appointments).toEqual([
      {
        id: 456,
        date: "2026-06-01",
        time: "9:00 AM",
        provider: "Doctor Smith",
        type: "Routine Vision",
        facility: "Spring Hill",
        confirmed: true,
      },
    ]);
    expect(state.patient.appointmentsStatus).toBe("found");

    const result = await cancel_appt.execute({}, {
      ctx: createToolContext(state) as never,
      toolCallId: "tool-2",
    } as never);

    expect(result).toBe("Cancelled the appointment on 2026-06-01 at 9:00 AM.");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      appointmentId: 456,
      patientId: "patient-1",
      office: "+17275919997",
    });
    expect(state.patient.appointments).toEqual([]);
  });

  it("requires a loaded appointment before cancelling", async () => {
    const state = createState();

    await expect(
      cancel_appt.execute(
        {
          appointmentId: 999,
        },
        {
          ctx: createToolContext(state) as never,
          toolCallId: "tool-1",
        } as never,
      ),
    ).rejects.toThrow(
      "No loaded appointment matches that appointment ID. Load appointments again and confirm the exact appointment before cancelling.",
    );
  });

  it("returns a speech-ready result after routing scheduling to Spring Hill", async () => {
    const state = createState();
    state.officeKey = "crystal-river";
    state.runtime.officePhoneOverrides = {
      "crystal-river": "+13523202007",
    };
    state.scheduling.routing = "bach_only";
    state.scheduling.availabilitySlots = [
      {
        slotId: "B",
        spoken: "2026-06-02 10:00 AM with Doctor Licht",
        provider: "Doctor Licht",
        date: "2026-06-02",
        time: "10:00 AM",
        datetime: "2026-06-02T10:00:00",
        routing: "bach_only",
      },
    ];
    const ctx = createToolContext(state);

    const result = await route_to_spring_hill.execute({}, {
      ctx: ctx as never,
      toolCallId: "tool-1",
    } as never);

    expect(ctx.speechHandle.allowInterruptions).toBe(false);
    expect(result).toBe(
      "Scheduling is now routed to Spring Hill. Continue without transferring the caller.",
    );
    expect(state.officeKey).toBe("spring-hill");
    expect(state.runtime.officePhoneOverrides?.["spring-hill"]).toBe(
      "+17275919997",
    );
    expect(state.scheduling.routing).toBe("all_three");
    expect(state.scheduling.availabilitySlots).toEqual([]);
  });

  it("speaks the transfer notice before transferring the caller", async () => {
    const state = createState();
    const ctx = createToolContext(state);

    const result = await transfer_call.execute({}, {
      ctx: ctx as never,
      toolCallId: "tool-1",
    } as never);

    expect(ctx.speechHandle.allowInterruptions).toBe(false);
    expect(ctx.session.say).toHaveBeenCalledWith(
      "I'm going to transfer you to the office now. They may be with a patient, so please leave a message and we will get back to you as soon as possible.",
      { allowInterruptions: false },
    );
    expect(transferCallerToOfficeMock).toHaveBeenCalledWith(state);
    expect(result).toBe("Transfer started to the spring-hill office.");
    expect(state.runtime.transferred).toBe(true);
  });
});
