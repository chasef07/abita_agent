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
  storeAvailabilityBookingToken,
} from "../state/call-state.js";
import {
  add_patient,
  book_appt,
  cancel_appt,
  check_insurance,
  confirm_patient_identity,
  get_availability,
  record_turn_context,
  reschedule_appt,
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
  state.identity.patient.identityConfirmed = true;
  state.availability.slots = [
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
  state.workflow.current = {
    intent: "schedule",
    appointmentLane,
    isEmergency: false,
    confidence: 0.92,
  };
}

function markAppointmentChangeContext(state: TestCallState) {
  state.workflow.current = {
    intent: "change_appointment",
    appointmentLane: "not_applicable",
    isEmergency: false,
    confidence: 0.92,
  };
}

function clearSchedulingContext(state: TestCallState) {
  state.workflow.current = undefined;
  state.workflow.routing.routing = null;
  state.availability.latestRouting = null;
  state.insurance.onFile = null;
  state.insurance.lastEligibilityCheck = null;
}

function markAcceptedInsurance(
  state: TestCallState,
  input: {
    plan: string;
    canonicalPlan: string;
    coverageType: "medical" | "routine_vision";
    currentCarrier?: string;
  } = {
    plan: "self pay",
    canonicalPlan: "self pay",
    coverageType: "medical",
  },
) {
  state.insurance.lastEligibilityCheck = {
    ...input,
    currentCarrier: input.currentCarrier ?? input.canonicalPlan,
    accepted: true,
  };
}

describe("direct session state cleanup", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    transferCallerToOfficeMock.mockClear();
  });

  it("returns public slots while storing booking tokens privately", async () => {
    const state = createState();
    clearAvailabilitySelection(state);
    markSchedulingTriaged(state);
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
    expect(state.availability.bookingTokensBySlotId).toEqual({
      A: "private-token",
    });
    expect(state.availability).not.toHaveProperty("rawSlots");
    expect(state.workflow.current).toEqual({
      intent: "schedule",
      appointmentLane: "medical_md",
      isEmergency: false,
      confidence: 0.92,
    });
    expect(state.availability.slots).toEqual([
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
    state.office.activeKey = "hollywood";
    state.insurance.onFile = {
      plan: "Aetna",
      canonicalPlan: "Aetna",
      coverageType: "medical",
      currentCarrier: "Aetna",
    };
    state.insurance.lastEligibilityCheck = {
      plan: "Aetna",
      canonicalPlan: "Aetna",
      coverageType: "medical",
      currentCarrier: "Aetna",
      accepted: true,
    };
    state.workflow.routing.routing = "bach_only";
    state.availability.latestRouting = "bach_only";
    state.availability.slots = [
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

    expect(state.workflow.current?.appointmentLane).toBe("routine_od");
    expect(state.availability.latestRouting).toBe("optical_only");
    expect(state.availability.slots).toEqual([
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

  it("checks availability for a loaded appointment change without faking schedule intent", async () => {
    const state = createState();
    markAppointmentChangeContext(state);
    state.identity.patient.appointments = [
      {
        id: 123,
        date: "Tuesday, June 9, 2026",
        time: "8:30 AM",
        provider: "Dr. Austin Bach",
        type: "Established Pediatric Medical (Follow Up)",
        appointmentTypeId: 1005,
        facility: "Abita Eye Group Hollywood",
        confirmed: false,
      },
    ];
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        status: "success",
        outcome: "availability_found",
        availabilityFound: true,
        requestedDate: "2026-07-09",
        actualDate: "2026-07-09",
        searchedFrom: "2026-07-09",
        searchedThrough: "2026-07-09",
        shouldRetrySameSearch: false,
        slots: [
          {
            provider: "Dr. Austin Bach",
            date: "2026-07-09",
            time: "9:45 AM",
            datetime: "2026-07-09T09:45:00",
            bookingToken: "reschedule-token",
            columnId: 1478,
            profileId: 620,
            duration: 15,
          },
        ],
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = (await get_availability.execute(
      {
        date: "2026-07-09",
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    )) as Record<string, unknown>;

    expect(state.workflow.current).toEqual({
      intent: "change_appointment",
      appointmentLane: "not_applicable",
      isEmergency: false,
      confidence: 0.92,
    });
    expect(result).toMatchObject({
      result: "slots_found",
      slotId: "A",
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toMatchObject(
      {
        date: "2026-07-09",
        dob: "01/01/1980",
        office: "+17275919997",
        routing: "all_three",
      },
    );
  });

  it("routes routine-vision reschedule availability through Spring Hill without schedule intent", async () => {
    const state = createState();
    markAppointmentChangeContext(state);
    state.office.activeKey = "crystal-river";
    state.office.phoneOverrides = {
      "crystal-river": "+13523202007",
    };
    state.identity.patient.appointments = [
      {
        id: 123,
        date: "Tuesday, June 9, 2026",
        time: "8:30 AM",
        provider: "Dr. Licht",
        type: "Routine Vision / Glasses",
        appointmentTypeId: 6167,
        facility: "Crystal River",
        confirmed: false,
      },
    ];
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        status: "success",
        outcome: "availability_found",
        availabilityFound: true,
        requestedDate: "2026-07-09",
        actualDate: "2026-07-09",
        searchedFrom: "2026-07-09",
        searchedThrough: "2026-07-09",
        shouldRetrySameSearch: false,
        slots: [
          {
            provider: "Dr. Kyler Farnan",
            date: "2026-07-09",
            time: "10:00 AM",
            datetime: "2026-07-09T10:00:00",
            bookingToken: "routine-reschedule-token",
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
        date: "2026-07-09",
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    )) as Record<string, unknown>;

    expect(state.workflow.current).toEqual({
      intent: "change_appointment",
      appointmentLane: "not_applicable",
      isEmergency: false,
      confidence: 0.92,
    });
    expect(state.office.activeKey).toBe("spring-hill");
    expect(state.availability.latestRouting).toBe("optical_only");
    expect(result).toMatchObject({
      result: "slots_found",
      slotId: "A",
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toMatchObject(
      {
        date: "2026-07-09",
        dob: "01/01/1980",
        office: "+17275919997",
        routing: "optical_only",
      },
    );
  });

  it("checks availability for a single loaded appointment even before appointment-change context is recorded", async () => {
    const state = createState();
    state.identity.patient.appointments = [
      {
        id: 123,
        date: "Tuesday, June 9, 2026",
        time: "8:30 AM",
        provider: "Dr. Austin Bach",
        type: "Established Pediatric Medical (Follow Up)",
        appointmentTypeId: 1005,
        facility: "Abita Eye Group Hollywood",
        confirmed: false,
      },
    ];
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        status: "success",
        outcome: "availability_found",
        availabilityFound: true,
        requestedDate: "2026-07-09",
        actualDate: "2026-07-09",
        searchedFrom: "2026-07-09",
        searchedThrough: "2026-07-09",
        shouldRetrySameSearch: false,
        slots: [],
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await get_availability.execute(
      {
        date: "2026-07-09",
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(state.workflow.current).toBeUndefined();
  });

  it("requires scheduling or existing appointment context before checking availability", async () => {
    const state = createState();
    clearSchedulingContext(state);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      get_availability.execute(
        {
          date: "2026-06-01",
        },
        {
          ctx: createToolContext(state) as never,
          toolCallId: "tool-1",
        } as never,
      ),
    ).rejects.toThrow(
      "Call record_turn_context with intent schedule and appointmentLane medical_md or routine_od, or identify the existing appointment to move, before checking availability.",
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires an inferable scheduling lane before booking", async () => {
    const state = createState();
    clearSchedulingContext(state);
    storeAvailabilityBookingToken(state, "A", "private-token");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      book_appt.execute(
        {
          slotId: "A",
          appointmentReason: "blurry vision",
          referringDoctor: "none",
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
          referringDoctor: "none",
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
    expect(state.availability.slots).toEqual([]);
  });

  it("requires referring doctor information before booking", async () => {
    const state = createState();
    markSchedulingTriaged(state);
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
      'Ask whether the caller has a referring doctor before booking. If they have none, pass "none".',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("books an active slot with private state and returns a structured receipt", async () => {
    const state = createState();
    markSchedulingTriaged(state);
    storeAvailabilityBookingToken(state, "A", "private-token");
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
        referringDoctor: "none",
      },
      {
        ctx: ctx as never,
        toolCallId: "tool-1",
      } as never,
    );

    expect(ctx.speechHandle.allowInterruptions).toBe(false);
    expect(result).toMatchObject({
      status: "booked",
      appointmentId: 123,
      providerName: "Doctor Smith",
      locationName: "Spring Hill",
      appointmentTypeName: "Medical",
      message: "Booked June 1 at 9:00 AM with Doctor Smith.",
    });
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
    expect(state.identity.patient.appointments).toEqual([
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
    expect(state.availability.slots).toEqual([]);
  });

  it("does not book another slot after a successful booking", async () => {
    const state = createState();
    markSchedulingTriaged(state);
    storeAvailabilityBookingToken(state, "A", "private-token");
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        status: "booked",
        appointmentId: 123,
        providerName: "Doctor Smith",
        locationName: "Spring Hill",
        appointmentTypeName: "Medical",
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await book_appt.execute(
      {
        slotId: "A",
        appointmentReason: "blurry vision",
        referringDoctor: "none",
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    );

    state.availability.slots.push({
      slotId: "B",
      spoken: "2026-06-01 2:00 PM with Doctor Smith",
      provider: "Doctor Smith",
      date: "2026-06-01",
      time: "2:00 PM",
      datetime: "2026-06-01T14:00:00",
      routing: "all_three",
    });
    storeAvailabilityBookingToken(state, "B", "private-token-b");

    const result = await book_appt.execute(
      {
        slotId: "B",
        appointmentReason: "blurry vision",
        referringDoctor: "none",
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-2",
      } as never,
    );

    expect(result).toBe(
      "The appointment is already booked. Tell the caller the confirmed appointment details instead of booking again.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(state.availability.slots).toEqual([]);
  });

  it("allows another booking after switching to a different active patient", async () => {
    const state = createState();
    markSchedulingTriaged(state);
    storeAvailabilityBookingToken(state, "A", "private-token");
    let nextAppointmentId = 123;
    const fetchMock = vi.fn(async () => {
      const appointmentId = nextAppointmentId;
      nextAppointmentId = 456;
      return {
        ok: true,
        json: async () => ({
          status: "booked",
          appointmentId,
          providerName: "Doctor Smith",
          locationName: "Spring Hill",
          appointmentTypeName: "Medical",
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    await book_appt.execute(
      {
        slotId: "A",
        appointmentReason: "blurry vision",
        referringDoctor: "none",
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    );

    state.identity.patient = {
      ...state.identity.patient,
      status: "verified",
      identityConfirmed: true,
      patientId: "patient-2",
      name: "Esa Arshed",
      dob: "10/03/2020",
      appointments: [],
      appointmentsStatus: null,
    };
    state.availability.slots.push({
      slotId: "B",
      spoken: "2026-06-01 2:00 PM with Doctor Smith",
      provider: "Doctor Smith",
      date: "2026-06-01",
      time: "2:00 PM",
      datetime: "2026-06-01T14:00:00",
      routing: "all_three",
    });
    storeAvailabilityBookingToken(state, "B", "private-token-b");

    const result = await book_appt.execute(
      {
        slotId: "B",
        appointmentReason: "glasses",
        referringDoctor: "none",
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-2",
      } as never,
    );

    expect(result).toMatchObject({
      status: "booked",
      appointmentId: 456,
      providerName: "Doctor Smith",
      locationName: "Spring Hill",
      appointmentTypeName: "Medical",
      message: "Booked June 1 at 2:00 PM with Doctor Smith.",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({
      bookingToken: "private-token-b",
      patientId: "patient-2",
      patientName: "Esa Arshed",
      dob: "10/03/2020",
    });
    expect(state.identity.patient.appointments).toEqual([
      {
        id: 456,
        date: "2026-06-01",
        time: "2:00 PM",
        provider: "Doctor Smith",
        type: "Medical",
        facility: "Spring Hill",
        confirmed: true,
      },
    ]);
  });

  it("does not confirm booking when middleware omits the appointment ID", async () => {
    const state = createState();
    markSchedulingTriaged(state);
    storeAvailabilityBookingToken(state, "A", "private-token");
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
        referringDoctor: "none",
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    );

    expect(result).toBe(
      "I could not confirm the booking because the appointment ID was missing. Check availability again before booking.",
    );
    expect(state.identity.patient.appointments).toEqual([]);
    expect(state.availability.slots).toEqual([]);
  });

  it("removes unavailable slots and returns the next bookable option", async () => {
    const state = createState();
    markSchedulingTriaged(state);
    state.availability.slots.push({
      slotId: "B",
      spoken: "2026-06-01 2:00 PM with Doctor Smith",
      provider: "Doctor Smith",
      date: "2026-06-01",
      time: "2:00 PM",
      datetime: "2026-06-01T14:00:00",
      routing: "all_three",
    });
    storeAvailabilityBookingToken(state, "A", "private-token");
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
        referringDoctor: "none",
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    );

    expect(result).toBe(
      "That time is no longer available. I can offer June 1 at 2:00 PM with Doctor Smith instead.",
    );
    expect(state.availability.slots.map((slot) => slot.slotId)).toEqual(["B"]);
  });

  it("returns a speech-ready result after creating a patient", async () => {
    const state = createState();
    state.identity.patient.patientId = null;
    state.identity.patient.name = null;
    state.identity.patient.identityConfirmed = false;
    markSchedulingTriaged(state);
    markAcceptedInsurance(state);
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
    expect(state.identity.patient.patientId).toBe("patient-new");
    expect(state.identity.patient.status).toBe("created");
    expect(state.insurance.onFile).toEqual({
      plan: "self pay",
      canonicalPlan: "self pay",
      coverageType: "medical",
      currentCarrier: "self pay",
    });
    expect(state.insurance.lastEligibilityCheck).toBeNull();
    expect(state.workflow.current).toEqual({
      intent: "schedule",
      appointmentLane: "medical_md",
      isEmergency: false,
      confidence: 0.92,
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      firstName: "Jane",
      lastName: "Doe",
      phone: "+17275551212",
      insurance: "self pay",
      subscriberNum: "self pay",
    });
  });

  it("marks a created chart as new-patient state when middleware omits status", async () => {
    const state = createState();
    state.identity.patient.patientId = null;
    state.identity.patient.name = null;
    state.identity.patient.identityConfirmed = false;
    markSchedulingTriaged(state);
    markAcceptedInsurance(state);
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        patientId: "patient-new",
        name: "Jane Doe",
        phone: "+17275551212",
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
        inboundPhoneConfirmed: true,
        readBack: true,
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    );

    expect(state.identity.patient.status).toBe("created");
    expect(state.insurance.onFile).toEqual({
      plan: "self pay",
      canonicalPlan: "self pay",
      coverageType: "medical",
      currentCarrier: "self pay",
    });
    expect(state.insurance.lastEligibilityCheck).toBeNull();
  });

  it("blocks new chart creation when a pending pre-call candidate matches last name and DOB", async () => {
    const state = createState();
    state.identity.patient = {
      ...state.identity.patient,
      status: "unknown",
      identityConfirmed: false,
      patientId: null,
      name: null,
      dob: null,
      phone: null,
      appointments: [],
      appointmentsStatus: null,
    };
    state.identity.preCall = {
      status: "single_match_pending_confirmation",
      source: "phone_lookup",
      callerPhone: "+17275551212",
      candidates: [
        {
          ref: CALLER_CANDIDATE_REF,
          firstName: "ESA",
          lastName: "ARSHED",
          dob: "10/03/2020",
          patientId: "patient-esa",
          relationshipToCaller: "self",
          appointments: [],
          appointmentsStatus: "none",
          insuranceCarrier: "Florida Blue Shield",
          routing: "bach_only",
          allowedProviders: ["Dr. Bach"],
          routingAmbiguous: false,
          preauthRequired: false,
        },
      ],
      selectedCandidateRef: CALLER_CANDIDATE_REF,
      identityPromotion: "none",
    };
    markSchedulingTriaged(state);
    state.insurance.lastEligibilityCheck = {
      plan: "Florida Blue Shield",
      canonicalPlan: "Florida Blue Shield",
      coverageType: "routine_vision",
      currentCarrier: "Florida Blue Shield",
      accepted: true,
    };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await add_patient.execute(
      {
        firstName: "Lisa",
        lastName: "Arshed",
        dob: "10/03/2020",
        street: "123 Main St",
        aptSuite: "",
        city: "Spring Hill",
        state: "FL",
        zip: "34606",
        sex: "male",
        insurance: "Florida Blue Shield",
        subscriberName: "Adam Arshed",
        subscriberNum: "FWZ975W06612",
        inboundPhoneConfirmed: true,
        readBack: true,
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    );

    expect(result).toBe(
      "A patient record may already exist for that last name and date of birth from the caller phone lookup. Confirm the existing patient record before creating a new chart.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires recorded scheduling context before creating a patient", async () => {
    const state = createState();
    state.identity.patient.patientId = null;
    state.identity.patient.name = null;
    state.identity.patient.identityConfirmed = false;
    clearSchedulingContext(state);
    markAcceptedInsurance(state);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      add_patient.execute(
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
          readBack: true,
        },
        {
          ctx: createToolContext(state) as never,
          toolCallId: "tool-1",
        } as never,
      ),
    ).rejects.toThrow(
      "Call record_turn_context with intent schedule and appointmentLane medical_md or routine_od before creating a patient.",
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires read-back confirmation before creating a patient", async () => {
    const state = createState();
    state.identity.patient.patientId = null;
    state.identity.patient.name = null;
    state.identity.patient.identityConfirmed = false;
    markSchedulingTriaged(state);
    markAcceptedInsurance(state);
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
    state.identity.patient.patientId = null;
    state.identity.patient.name = null;
    state.identity.patient.identityConfirmed = false;
    markSchedulingTriaged(state);
    markAcceptedInsurance(state);
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
    state.identity.patient.patientId = null;
    state.identity.patient.name = null;
    state.identity.patient.identityConfirmed = false;
    markSchedulingTriaged(state);
    markAcceptedInsurance(state);
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
    state.identity.patient.patientId = null;
    state.identity.patient.name = null;
    state.identity.patient.identityConfirmed = false;
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
    expect(state.identity.patient.patientId).toBe("patient-1");
    expect(state.identity.patient.appointments).toHaveLength(1);
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
    state.identity.patient.patientId = null;
    state.identity.patient.name = null;
    state.identity.patient.identityConfirmed = false;
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
    expect(state.identity.patient.patientId).toBe("patient-1");
    expect(state.identity.patient.identityConfirmed).toBe(true);
    expect(state.insurance.onFile).toBeNull();
    expect(state.insurance.lastEligibilityCheck).toBeNull();
  });

  it("confirms a pre-call single match from full identity without middleware lookup", async () => {
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
        lastName: "Doe",
        dob: "01/01/1980",
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toBe(
      "Verified existing patient Jane Doe. Insurance on file: Aetna. Loaded 1 appointment: June 1 at 9:00 AM with Dr. Bach.",
    );
    expect(state.identity.preCall?.status).toBe("single_match_confirmed");
    expect(state.identity.patient.identityConfirmed).toBe(true);
    expect(state.identity.patient.patientId).toBe("patient-1");
    expect(state.insurance.onFile?.currentCarrier).toBe("Aetna");
    expect(state.workflow.routing.routing).toBe("all_three");
  });

  it("asks for first-name spelling after lookup fails for a pre-call single match with matching last name and DOB", async () => {
    const state = createState();
    state.identity.patient = {
      ...state.identity.patient,
      status: "unknown",
      identityConfirmed: false,
      patientId: null,
      name: null,
      dob: null,
      phone: null,
      appointments: [],
      appointmentsStatus: null,
    };
    state.identity.preCall = {
      status: "single_match_pending_confirmation",
      source: "phone_lookup",
      callerPhone: "+17275551212",
      candidates: [
        {
          ref: CALLER_CANDIDATE_REF,
          firstName: "ESA",
          lastName: "ARSHED",
          dob: "10/03/2020",
          patientId: "patient-esa",
          relationshipToCaller: "self",
          appointments: [],
          appointmentsStatus: "none",
          insuranceCarrier: "Florida Blue Shield",
          routing: "bach_only",
          allowedProviders: ["Dr. Bach"],
          routingAmbiguous: false,
          preauthRequired: false,
        },
      ],
      selectedCandidateRef: CALLER_CANDIDATE_REF,
      identityPromotion: "none",
    };
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        status: "not_found",
        message: "No patient found matching that first name.",
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await confirm_patient_identity.execute(
      {
        firstName: "Lisa",
        lastName: "Arshed",
        dob: "10/03/2020",
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    expect(result).toBe(
      "I found a record with that last name and date of birth, but the first name does not match what I heard. Could you spell the patient's first name?",
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      firstName: "Lisa",
      lastName: "Arshed",
      dob: "10/03/2020",
    });
    expect(state.identity.preCall.status).toBe(
      "single_match_pending_confirmation",
    );
    expect(state.identity.patient.identityConfirmed).toBe(false);
  });

  it("preserves backend lookup errors instead of using the pre-call spelling fallback", async () => {
    const state = createState();
    state.identity.patient = {
      ...state.identity.patient,
      status: "unknown",
      identityConfirmed: false,
      patientId: null,
      name: null,
      dob: null,
      phone: null,
      appointments: [],
      appointmentsStatus: null,
    };
    state.identity.preCall = {
      status: "single_match_pending_confirmation",
      source: "phone_lookup",
      callerPhone: "+17275551212",
      candidates: [
        {
          ref: CALLER_CANDIDATE_REF,
          firstName: "ESA",
          lastName: "ARSHED",
          dob: "10/03/2020",
          patientId: "patient-esa",
          relationshipToCaller: "self",
          appointments: [],
          appointmentsStatus: "none",
          insuranceCarrier: "Florida Blue Shield",
          routing: "bach_only",
          allowedProviders: ["Dr. Bach"],
          routingAmbiguous: false,
          preauthRequired: false,
        },
      ],
      selectedCandidateRef: CALLER_CANDIDATE_REF,
      identityPromotion: "none",
    };
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        status: "error",
        message: "Patient lookup failed. Try again.",
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await confirm_patient_identity.execute(
      {
        firstName: "Lisa",
        lastName: "Arshed",
        dob: "10/03/2020",
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    expect(result).toBe("Patient lookup failed. Try again.");
    expect(state.identity.preCall.status).toBe(
      "single_match_pending_confirmation",
    );
    expect(state.identity.patient.identityConfirmed).toBe(false);
  });

  it("verifies a backend patient before spelling fallback when a pre-call single match shares last name and DOB", async () => {
    const state = createState();
    state.identity.patient = {
      ...state.identity.patient,
      status: "unknown",
      identityConfirmed: false,
      patientId: null,
      name: null,
      dob: null,
      phone: null,
      appointments: [],
      appointmentsStatus: null,
    };
    state.identity.preCall = {
      status: "single_match_pending_confirmation",
      source: "phone_lookup",
      callerPhone: "+17275551212",
      candidates: [
        {
          ref: CALLER_CANDIDATE_REF,
          firstName: "ESA",
          lastName: "ARSHED",
          dob: "10/03/2020",
          patientId: "patient-esa",
          relationshipToCaller: "self",
          appointments: [],
          appointmentsStatus: "none",
          insuranceCarrier: "Florida Blue Shield",
          routing: "bach_only",
          allowedProviders: ["Dr. Bach"],
          routingAmbiguous: false,
          preauthRequired: false,
        },
      ],
      selectedCandidateRef: CALLER_CANDIDATE_REF,
      identityPromotion: "none",
    };
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        status: "verified",
        patientId: "patient-ella",
        name: "ELLA ARSHED",
        dob: "10/03/2020",
        phone: "+17275551212",
        insuranceCarrier: "Aetna",
        routing: "all_three",
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
        firstName: "Ella",
        lastName: "Arshed",
        dob: "10/03/2020",
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    expect(result).toBe(
      "Verified existing patient ELLA ARSHED. Insurance on file: Aetna. No upcoming appointments are loaded.",
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      firstName: "Ella",
      lastName: "Arshed",
      dob: "10/03/2020",
    });
    expect(state.identity.patient.identityConfirmed).toBe(true);
    expect(state.identity.patient.patientId).toBe("patient-ella");
  });

  it("confirms a unique multiple-match pre-call candidate from full identity", async () => {
    const state = createState();
    state.identity.patient = {
      ...state.identity.patient,
      status: "unknown",
      identityConfirmed: false,
      patientId: null,
      name: null,
      dob: null,
      phone: null,
      appointments: [],
      appointmentsStatus: null,
    };
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
        lastName: "Test",
        dob: "04/07/2000",
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toBe(
      "Verified existing patient CHASE TEST. No insurance is currently on file. No upcoming appointments are loaded.",
    );
    expect(state.identity.preCall.status).toBe("multiple_match_confirmed");
    expect(state.identity.preCall.selectedCandidateRef).toBe("precall:1");
    expect(state.identity.patient.identityConfirmed).toBe(true);
    expect(state.identity.patient.patientId).toBe("patient-chase");
  });

  it("requires full identity before resolving pre-call candidates through the tool", async () => {
    const state = createState();
    state.identity.patient = {
      ...state.identity.patient,
      status: "unknown",
      identityConfirmed: false,
      patientId: null,
      name: null,
      dob: null,
      phone: null,
      appointments: [],
      appointmentsStatus: null,
    };
    state.identity.preCall = {
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
      "Collect the patient's first name, last name, and date of birth before looking up identity.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.identity.patient.identityConfirmed).toBe(false);
  });

  it("does not call middleware until full identity is provided", async () => {
    const state = createState();
    state.identity.preCall = {
      status: "no_match",
      source: "phone_lookup",
      callerPhone: "+17275551212",
      candidates: [],
      identityPromotion: "none",
    };
    state.identity.patient.patientId = null;
    state.identity.patient.name = null;
    state.identity.patient.identityConfirmed = false;
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
      callerFacingPlan: "Blue Cross Blue Shield",
      clarificationNeeded: null,
      callerMessage: "Yes, we take Blue Cross Blue Shield.",
    });
    expect(result).not.toHaveProperty("canonicalPlan");
    expect(result).not.toHaveProperty("outcome");
    expect(result).not.toHaveProperty("facts");
    expect(result).not.toHaveProperty("retryable");
    expect(state.insurance.lastEligibilityCheck).toEqual({
      plan: "Blue Cross",
      canonicalPlan: "Florida Blue",
      coverageType: "medical",
      currentCarrier: "Blue Cross Blue Shield",
      accepted: true,
    });
    expect(state.workflow.current).toBeUndefined();
  });

  it("passes the checked canonical insurance plan to new patient creation", async () => {
    const state = createState();
    state.identity.patient.patientId = null;
    state.identity.patient.name = null;
    state.identity.patient.identityConfirmed = false;
    state.insurance.onFile = null;
    markSchedulingTriaged(state);
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        status: "created",
        patientId: "patient-new",
        name: "Jane Doe",
        phone: "+17275551212",
        insuranceCarrier: "Florida Blue",
        routing: "all_three",
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await check_insurance.execute(
      {
        plan: "I have Blue Cross",
        coverageType: "medical",
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

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
        insurance: "Blue Cross",
        subscriberName: "Jane Doe",
        subscriberNum: "ABC123",
        inboundPhoneConfirmed: true,
        readBack: true,
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-2" } as never,
    );

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      insurance: "Florida Blue",
      subscriberNum: "ABC123",
    });
    expect(state.insurance.onFile).toEqual({
      plan: "Florida Blue",
      canonicalPlan: "Florida Blue",
      coverageType: "medical",
      currentCarrier: "Florida Blue",
    });
    expect(state.insurance.lastEligibilityCheck).toBeNull();
    expect(state.workflow.current).toEqual({
      intent: "schedule",
      appointmentLane: "medical_md",
      isEmergency: false,
      confidence: 0.92,
    });
  });

  it("keeps canonical insurance internal for caller-facing alias responses", async () => {
    const state = createState();

    const result = (await check_insurance.execute(
      {
        plan: "Ambetter",
        coverageType: "routine_vision",
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    )) as Record<string, unknown>;

    expect(result).toEqual({
      status: "accepted",
      canProceed: true,
      callerFacingPlan: "Ambetter",
      clarificationNeeded: null,
      callerMessage: "Yes, we take Ambetter.",
    });
    expect(result).not.toHaveProperty("canonicalPlan");
    expect(state.insurance.lastEligibilityCheck).toEqual({
      plan: "Ambetter",
      canonicalPlan: "Envolve",
      coverageType: "routine_vision",
      currentCarrier: "Ambetter",
      accepted: true,
    });
  });

  it("returns a Spring Hill routing option when Crystal River does not accept the plan", async () => {
    const state = createState();
    state.office.activeKey = "crystal-river";

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
      callerFacingPlan: "Humana PPO",
      acceptedAtAlternateOffice: "Spring Hill",
      alternateCallerFacingPlan: "Humana PPO",
      routeTool: "route_to_spring_hill",
    });
    expect(result).not.toHaveProperty("canonicalPlan");
    expect(result.callerMessage).toContain("Spring Hill accepts Humana PPO");
    expect(result.callerMessage).toContain(
      "Would you like to schedule there instead?",
    );
    expect(state.insurance.lastEligibilityCheck).toMatchObject({
      plan: "Humana PPO",
      canonicalPlan: null,
      coverageType: null,
      currentCarrier: "Humana PPO",
      accepted: false,
    });
  });

  it("updates insurance from the checked medical plan in session state", async () => {
    const state = createState();
    state.insurance.onFile = {
      plan: "Old Plan",
      canonicalPlan: "Old Plan",
      coverageType: "medical",
      currentCarrier: "Old Plan",
    };
    state.insurance.lastEligibilityCheck = {
      plan: "Aetna",
      canonicalPlan: "Aetna Commercial",
      coverageType: "medical",
      currentCarrier: "Aetna Commercial",
      accepted: true,
    };
    state.identity.patientBackend = {
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
        newInsurance: "Aetna",
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
    expect(result).toBe("Updated insurance to Aetna.");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      patientId: "patient-1",
      dob: "01/01/1980",
      insPlanId: "ins-old",
      respPartyId: "resp-1",
      oldInsurance: "Old Plan",
      insurance: "Aetna",
      coverageType: "medical",
      subscriberNum: "ABC123",
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty(
      "subscriberName",
    );
    expect(state.insurance.onFile).toEqual({
      plan: "Aetna",
      canonicalPlan: "Aetna Commercial",
      coverageType: "medical",
      currentCarrier: "Aetna",
    });
    expect(state.insurance.lastEligibilityCheck).toBeNull();
    expect(state.identity.patientBackend).toEqual({
      insPlanId: null,
      respPartyId: "resp-1",
    });
    expect(state.workflow.routing.routing).toBe("bach_only");
    expect(state.workflow.routing.allowedProviders).toEqual(["Dr. Bach"]);
    expect(state.workflow.routing.preauthRequired).toBe(true);
    expect(state.availability.slots).toEqual([]);
  });

  it("updates routine vision insurance with the checked caller plan", async () => {
    const state = createState();
    state.office.activeKey = "hollywood";
    state.insurance.onFile = null;
    state.insurance.lastEligibilityCheck = {
      plan: "Sunshine Health",
      canonicalPlan: "Envolve",
      coverageType: "routine_vision",
      currentCarrier: "Sunshine",
      accepted: true,
    };
    state.identity.patientBackend = {
      insPlanId: null,
      respPartyId: "resp-1",
    };
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        status: "updated",
        patientId: "patient-1",
        oldInsurance: "",
        newInsurance: "Sunshine Health",
        routing: "optical_only",
        allowedProviders: [],
        routingAmbiguous: false,
        preauthRequired: false,
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await update_insurance.execute(
      {
        subscriberNum: "946-327-2674",
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    expect(result).toBe("Updated insurance to Sunshine Health.");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      patientId: "patient-1",
      dob: "01/01/1980",
      insPlanId: "",
      respPartyId: "resp-1",
      oldInsurance: "",
      insurance: "Sunshine Health",
      coverageType: "routine_vision",
      subscriberNum: "946-327-2674",
    });
    expect(state.insurance.onFile).toEqual({
      plan: "Sunshine Health",
      canonicalPlan: "Envolve",
      coverageType: "routine_vision",
      currentCarrier: "Sunshine Health",
    });
    expect(state.insurance.lastEligibilityCheck).toBeNull();
    expect(state.identity.patientBackend).toEqual({
      insPlanId: null,
      respPartyId: "resp-1",
    });
    expect(state.workflow.routing.routing).toBe("optical_only");
    expect(state.workflow.routing.allowedProviders).toEqual([]);
    expect(state.workflow.routing.preauthRequired).toBe(false);
    expect(state.availability.slots).toEqual([]);
  });

  it("treats middleware update-insurance failures as tool errors", async () => {
    const state = createState();
    state.insurance.onFile = null;
    state.insurance.lastEligibilityCheck = {
      plan: "Sunshine Health",
      canonicalPlan: "Envolve",
      coverageType: "routine_vision",
      currentCarrier: "Sunshine",
      accepted: true,
    };
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        status: "error",
        message:
          'Insurance not recognized: "Sunshine Health". Please use an insurance name from the accepted list.',
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      update_insurance.execute(
        {
          subscriberNum: "946-327-2674",
        },
        {
          ctx: createToolContext(state) as never,
          toolCallId: "tool-1",
        } as never,
      ),
    ).rejects.toThrow(
      'Insurance not recognized: "Sunshine Health". Please use an insurance name from the accepted list.',
    );
    expect(state.insurance.onFile).toBeNull();
  });

  it("uses self pay without collecting a member ID", async () => {
    const state = createState();
    state.insurance.lastEligibilityCheck = {
      plan: "Self Pay",
      canonicalPlan: "Self Pay",
      coverageType: "medical",
      currentCarrier: "Self Pay",
      accepted: true,
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
    state.identity.patient.appointments = [
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
    expect(state.identity.patient.appointments).toEqual([]);
  });

  it("cancels a loaded appointment selected by caller date", async () => {
    const state = createState();
    state.identity.patient.appointments = [
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
      state.identity.patient.appointments.map((appointment) => appointment.id),
    ).toEqual([111]);
  });

  it("asks for clarification when a caller date matches multiple appointments", async () => {
    const state = createState();
    state.identity.patient.appointments = [
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
    state.availability.slots[0] = {
      ...state.availability.slots[0],
      routing: "optical_only",
    };
    state.availability.latestRouting = "optical_only";
    state.identity.preCall = {
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
    storeAvailabilityBookingToken(state, "A", "private-token");
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
        referringDoctor: "none",
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    );

    expect(state.identity.patient.appointments).toEqual([
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
    expect(state.identity.patient.appointmentsStatus).toBe("found");

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
    expect(state.identity.patient.appointments).toEqual([]);
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

  it("reschedules from appointment-change context without faking schedule intent", async () => {
    const state = createState();
    markAppointmentChangeContext(state);
    state.office.activeKey = "crystal-river";
    state.office.phoneOverrides = {
      "crystal-river": "+13523202007",
    };
    state.identity.patient.appointments = [
      {
        id: 123,
        date: "Monday, June 1, 2026",
        time: "9:00 AM",
        provider: "Dr. Licht",
        type: "Crystal River New Patient",
        appointmentTypeId: 6167,
        facility: "Crystal River",
        confirmed: false,
      },
    ];
    storeAvailabilityBookingToken(state, "A", "private-token");
    const fetchMock = vi.fn(async (url: string | URL) => {
      const path = String(url);
      if (path.includes("/api/appointment/book")) {
        return {
          ok: true,
          json: async () => ({
            status: "booked",
            appointmentId: 456,
            providerName: "Doctor Smith",
            locationName: "Crystal River",
            appointmentTypeId: 6167,
            appointmentTypeName: "Crystal River New Patient",
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          status: "cancelled",
          appointmentId: 123,
          message: "Appointment cancelled successfully",
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await reschedule_appt.execute(
      {
        slotId: "A",
        appointmentReason: "move my appointment",
        referringDoctor: "none",
        appointmentId: 123,
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    );

    expect(result).toMatchObject({
      status: "rescheduled",
      bookingStatus: "booked",
      appointmentId: 456,
      appointmentDate: "2026-06-01",
      appointmentTime: "9:00 AM",
      startDatetime: "2026-06-01T09:00:00",
      providerName: "Doctor Smith",
      locationName: "Crystal River",
      appointmentTypeId: 6167,
      appointmentTypeName: "Crystal River New Patient",
      cancelledAppointmentId: 123,
      cancelledAppointmentDate: "Monday, June 1, 2026",
      cancelledAppointmentTime: "9:00 AM",
      cancellationStatus: "cancelled",
      message:
        "Rescheduled the appointment to June 1 at 9:00 AM with Doctor Smith. Cancelled the old appointment on Monday, June 1, 2026 at 9:00 AM.",
    });
    expect(
      fetchMock.mock.calls.map((call) =>
        String(call[0]).includes("/api/appointment/book") ? "book" : "cancel",
      ),
    ).toEqual(["book", "cancel"]);
    const bookingBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(bookingBody).toMatchObject({
      bookingToken: "private-token",
      patientId: "patient-1",
      appointmentReason: "move my appointment",
      referringDoctor: "none",
      appointmentTypeId: 6167,
      patientStatus: "new",
    });
    expect(state.workflow.current).toEqual({
      intent: "change_appointment",
      appointmentLane: "not_applicable",
      isEmergency: false,
      confidence: 0.92,
    });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string)).toEqual({
      appointmentId: 123,
      patientId: "patient-1",
      office: "+13523202007",
    });
    expect(state.identity.patient.appointments).toEqual([
      {
        id: 456,
        date: "2026-06-01",
        time: "9:00 AM",
        provider: "Doctor Smith",
        type: "Crystal River New Patient",
        appointmentTypeId: 6167,
        facility: "Crystal River",
        confirmed: true,
      },
    ]);
  });

  it("cancels the old appointment through its original office after routine reschedule routing", async () => {
    const state = createState();
    markSchedulingTriaged(state, "routine_od");
    state.office.activeKey = "spring-hill";
    state.office.phoneOverrides = {
      "crystal-river": "+13523202007",
      "spring-hill": "+17275919997",
    };
    state.identity.patient.appointments = [
      {
        id: 123,
        date: "Monday, June 1, 2026",
        time: "9:00 AM",
        provider: "Dr. Licht",
        type: "Crystal River New Patient",
        appointmentTypeId: 6167,
        facility: "Crystal River",
        confirmed: false,
      },
    ];
    state.availability.slots = [
      {
        slotId: "A",
        spoken: "2026-06-03 10:00 AM with Doctor Smith",
        provider: "Doctor Smith",
        date: "2026-06-03",
        time: "10:00 AM",
        datetime: "2026-06-03T10:00:00",
        routing: "optical_only",
      },
    ];
    storeAvailabilityBookingToken(state, "A", "private-token");
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
          appointmentId: 123,
          message: "Appointment cancelled successfully",
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await reschedule_appt.execute(
      {
        slotId: "A",
        appointmentReason: "move my appointment",
        referringDoctor: "none",
        appointmentId: 123,
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    );

    expect(result).toMatchObject({
      status: "rescheduled",
      bookingStatus: "booked",
      appointmentId: 456,
      appointmentDate: "2026-06-03",
      appointmentTime: "10:00 AM",
      startDatetime: "2026-06-03T10:00:00",
      providerName: "Doctor Smith",
      locationName: "Spring Hill",
      appointmentTypeName: "Routine Vision",
      cancelledAppointmentId: 123,
      cancellationStatus: "cancelled",
      message:
        "Rescheduled the appointment to June 3 at 10:00 AM with Doctor Smith. Cancelled the old appointment on Monday, June 1, 2026 at 9:00 AM.",
    });
    const bookingBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(bookingBody).toMatchObject({
      bookingToken: "private-token",
      patientId: "patient-1",
      patientStatus: "new",
      routing: "optical_only",
    });
    expect(bookingBody).not.toHaveProperty("appointmentTypeId");
    expect(bookingBody).not.toHaveProperty("office");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string)).toEqual({
      appointmentId: 123,
      patientId: "patient-1",
      office: "+13523202007",
    });
  });

  it("does not cancel the old appointment when reschedule booking fails", async () => {
    const state = createState();
    markSchedulingTriaged(state);
    state.identity.patient.appointments = [
      {
        id: 123,
        date: "Monday, June 1, 2026",
        time: "9:00 AM",
        provider: "Dr. Licht",
        type: "Follow-up",
        facility: "Spring Hill",
        confirmed: false,
      },
    ];
    storeAvailabilityBookingToken(state, "A", "private-token");
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        status: "error",
        outcome: "slot_unavailable",
        message: "This time slot is no longer available.",
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await reschedule_appt.execute(
      {
        slotId: "A",
        appointmentReason: "move my appointment",
        referringDoctor: "none",
        appointmentId: 123,
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    );

    expect(result).toBe(
      "That time is no longer available. Check availability again before booking. I did not cancel the existing appointment.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      state.identity.patient.appointments.map((appointment) => appointment.id),
    ).toEqual([123]);
  });

  it("does not book when the old appointment selection is ambiguous", async () => {
    const state = createState();
    markSchedulingTriaged(state);
    state.identity.patient.appointments = [
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
        facility: "Spring Hill",
        confirmed: false,
      },
    ];
    storeAvailabilityBookingToken(state, "A", "private-token");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await reschedule_appt.execute(
      {
        slotId: "A",
        appointmentReason: "move my appointment",
        referringDoctor: "none",
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

  it("keeps both appointments when reschedule cancellation fails after booking", async () => {
    const state = createState();
    markSchedulingTriaged(state);
    state.identity.patient.appointments = [
      {
        id: 123,
        date: "Monday, June 1, 2026",
        time: "9:00 AM",
        provider: "Dr. Licht",
        type: "Follow-up",
        facility: "Spring Hill",
        confirmed: false,
      },
    ];
    storeAvailabilityBookingToken(state, "A", "private-token");
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
            appointmentTypeName: "Medical",
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          status: "error",
          message: "Unable to verify appointment before cancellation.",
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await reschedule_appt.execute(
      {
        slotId: "A",
        appointmentReason: "move my appointment",
        referringDoctor: "none",
        appointmentId: 123,
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    );

    expect(result).toBe(
      "Booked the new appointment for June 1 at 9:00 AM with Doctor Smith, but I could not cancel the old appointment. Unable to verify appointment before cancellation. I need to transfer you so the office can finish the cancellation.",
    );
    expect(
      state.identity.patient.appointments.map((appointment) => appointment.id),
    ).toEqual([123, 456]);
  });

  it("keeps both appointments when reschedule cancellation request throws after booking", async () => {
    const state = createState();
    markSchedulingTriaged(state);
    state.identity.patient.appointments = [
      {
        id: 123,
        date: "Monday, June 1, 2026",
        time: "9:00 AM",
        provider: "Dr. Licht",
        type: "Follow-up",
        facility: "Spring Hill",
        confirmed: false,
      },
    ];
    storeAvailabilityBookingToken(state, "A", "private-token");
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
            appointmentTypeName: "Medical",
          }),
        };
      }
      return {
        ok: false,
        text: async () => "cancel failed",
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await reschedule_appt.execute(
      {
        slotId: "A",
        appointmentReason: "move my appointment",
        referringDoctor: "none",
        appointmentId: 123,
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    );

    expect(result).toBe(
      "Booked the new appointment for June 1 at 9:00 AM with Doctor Smith, but I could not cancel the old appointment. The old appointment was not cancelled. I need to transfer you so the office can finish the cancellation.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      state.identity.patient.appointments.map((appointment) => appointment.id),
    ).toEqual([123, 456]);
  });

  it("requires a loaded appointment before rescheduling", async () => {
    const state = createState();
    clearSchedulingContext(state);

    await expect(
      reschedule_appt.execute(
        {
          slotId: "A",
          appointmentReason: "move my appointment",
          referringDoctor: "none",
          appointmentId: 123,
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
    state.office.activeKey = "crystal-river";
    state.office.phoneOverrides = {
      "crystal-river": "+13523202007",
    };
    state.workflow.routing.routing = "bach_only";
    state.insurance.lastEligibilityCheck = {
      plan: "Humana PPO",
      canonicalPlan: "Humana PPO",
      coverageType: "medical",
      currentCarrier: "Humana PPO",
      accepted: true,
    };
    state.availability.slots = [
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
    expect(state.office.activeKey).toBe("spring-hill");
    expect(state.office.phoneOverrides?.["spring-hill"]).toBe("+17275919997");
    expect(state.insurance.lastEligibilityCheck).toBeNull();
    expect(state.workflow.routing.routing).toBe("all_three");
    expect(state.availability.slots).toEqual([]);
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
