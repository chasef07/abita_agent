import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  type CallerAppointment,
  type PreCallContextState,
  type StoredAvailabilitySlot,
} from "../state/call-state.js";
import {
  add_patient,
  book_appt,
  cancel_appt,
  check_insurance,
  get_availability,
  resolve_patient,
  reschedule_appt,
  route_to_spring_hill,
  transfer_call,
  update_insurance,
} from "../tools/index.js";

type TestCallState = ReturnType<typeof createCanonicalCallState>;
type PreCallCandidate = PreCallContextState["candidates"][number];

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
  const spokenHandle = {
    waitForPlayout: vi.fn(async () => undefined),
    interrupt: vi.fn(),
    done: vi.fn(() => false),
    interrupted: false,
  };
  return {
    session: {
      userData: state,
      say: vi.fn(() => spokenHandle),
      generateReply: vi.fn(() => spokenHandle),
    },
    speechHandle: { allowInterruptions: true },
    waitForPlayout: vi.fn(async () => undefined),
    spokenHandle,
  };
}

function markSchedulingTriaged(
  state: TestCallState,
  appointmentLane: "medical_md" | "routine_od" = "medical_md",
) {
  state.workflow.current = {
    intent: "schedule",
    appointmentLane,
  };
}

function markNewPatientPathConfirmed(state: TestCallState) {
  state.identity.patient = {
    ...state.identity.patient,
    status: "new",
    identityConfirmed: false,
    patientId: null,
    name: null,
    dob: null,
    appointments: [],
    appointmentsStatus: null,
  };
}

function markAppointmentChangeContext(state: TestCallState) {
  state.workflow.current = {
    intent: "change_appointment",
    appointmentLane: "not_applicable",
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

function setPatientUnknown(state: TestCallState) {
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
}

function appointment(
  overrides: Partial<CallerAppointment> = {},
): CallerAppointment {
  return {
    id: 123,
    date: "Monday, June 1, 2026",
    time: "9:00 AM",
    provider: "Dr. Licht",
    type: "Follow-up",
    facility: "Spring Hill",
    confirmed: false,
    ...overrides,
  };
}

function availabilitySlot(
  overrides: Partial<StoredAvailabilitySlot> = {},
): StoredAvailabilitySlot {
  return {
    slotId: "A",
    spoken: "2026-06-01 9:00 AM with Doctor Smith",
    provider: "Doctor Smith",
    date: "2026-06-01",
    time: "9:00 AM",
    datetime: "2026-06-01T09:00:00",
    routing: "all_three",
    ...overrides,
  };
}

function setLoadedAppointments(
  state: TestCallState,
  ...appointments: CallerAppointment[]
) {
  state.identity.patient.appointments = appointments;
}

function preCallCandidate(
  overrides: Partial<PreCallCandidate> = {},
): PreCallCandidate {
  return {
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
    ...overrides,
  };
}

function setSingleArshedPreCallCandidate(state: TestCallState) {
  setPatientUnknown(state);
  state.identity.preCall = {
    status: "single_match_pending_confirmation",
    source: "phone_lookup",
    callerPhone: "+17275551212",
    candidates: [preCallCandidate()],
    selectedCandidateRef: CALLER_CANDIDATE_REF,
    identityPromotion: "none",
  };
}

function setMultiplePreCallCandidates(
  state: TestCallState,
  candidates: PreCallCandidate[],
  options: {
    status?: PreCallContextState["status"];
    callerPhone?: string;
    selectedCandidateRef?: string;
    identityPromotion?: string;
  } = {},
) {
  state.identity.preCall = {
    status: options.status ?? "multiple_matches_pending_selection",
    source: "phone_lookup",
    callerPhone: options.callerPhone ?? "+19546097250",
    candidates,
    ...(options.selectedCandidateRef
      ? { selectedCandidateRef: options.selectedCandidateRef }
      : {}),
    identityPromotion: options.identityPromotion ?? "none",
  };
}

function stubFetchJson(...responses: Record<string, unknown>[]) {
  const fetchMock = vi.fn();
  for (const response of responses) {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => response,
    });
  }
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function noAvailabilityResponse(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    status: "success",
    outcome: "no_availability",
    availabilityFound: false,
    requestedDate: "2026-07-09",
    searchedFrom: "2026-07-09",
    searchedThrough: "2026-07-23",
    shouldRetrySameSearch: false,
    slots: [],
    ...overrides,
  };
}

function availabilityFoundResponse(
  slot: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    status: "success",
    outcome: "availability_found",
    availabilityFound: true,
    requestedDate: "2026-07-09",
    actualDate: "2026-07-09",
    searchedFrom: "2026-07-09",
    searchedThrough: "2026-07-09",
    shouldRetrySameSearch: false,
    slots: [slot],
    ...overrides,
  };
}

async function getMedicalAvailability(
  ctx: ReturnType<typeof createToolContext>,
  toolCallId: string,
) {
  return get_availability.execute(
    {
      date: "2026-07-09",
      appointmentLane: "medical_md",
    },
    {
      ctx: ctx as never,
      toolCallId,
    } as never,
  );
}

function stubRescheduleFetch(
  bookResponse: Record<string, unknown>,
  cancelResponse: Record<string, unknown> = {
    status: "cancelled",
    appointmentId: 123,
    message: "Appointment cancelled successfully",
  },
) {
  const fetchMock = vi.fn(async (url: string | URL) => {
    const path = String(url);
    return {
      ok: true,
      json: async () =>
        path.includes("/api/appointment/book") ? bookResponse : cancelResponse,
    };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function prepareRescheduleState(
  state: TestCallState,
  {
    context = "schedule",
    appointmentOverrides,
    token = "private-token",
  }: {
    context?: "schedule" | "change_appointment";
    appointmentOverrides?: Partial<CallerAppointment>;
    token?: string;
  } = {},
) {
  if (context === "change_appointment") {
    markAppointmentChangeContext(state);
  } else {
    markSchedulingTriaged(state);
  }
  setLoadedAppointments(state, appointment(appointmentOverrides));
  storeAvailabilityBookingToken(state, "A", token);
}

function fetchCallKinds(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.map((call) =>
    String(call[0]).includes("/api/appointment/book") ? "book" : "cancel",
  );
}

describe("direct session state cleanup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-30T16:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
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
        appointmentLane: "medical_md",
      },
      {
        ctx: ctx as never,
        toolCallId: "tool-1",
      } as never,
    )) as Record<string, unknown>;

    expect(ctx.session.say).not.toHaveBeenCalled();
    expect(ctx.session.generateReply).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      result: "slots_found",
      reply: "I found June 1 at 9:00 AM with Dr. Bach. Does that work?",
      next: "offer_slot",
      slotId: "S1",
      slots: [
        {
          slotId: "S1",
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
      S1: "private-token",
    });
    expect(state.availability).not.toHaveProperty("rawSlots");
    expect(state.workflow.current).toEqual({
      intent: "schedule",
      appointmentLane: "medical_md",
    });
    expect(state.availability.slots).toEqual([
      {
        slotId: "S1",
        spoken: "2026-06-01 9:00 AM with Dr. Bach",
        provider: "Dr. Bach",
        date: "2026-06-01",
        time: "9:00 AM",
        datetime: "2026-06-01T09:00:00",
        routing: "all_three",
      },
    ]);
  });

  it("keeps earlier offered slots bookable after a later availability search", async () => {
    const state = createState();
    clearAvailabilitySelection(state);
    markSchedulingTriaged(state);
    const fetchMock = stubFetchJson(
      availabilityFoundResponse(
        {
          provider: "Dr. Austin Bach",
          date: "2026-07-09",
          time: "9:00 AM",
          datetime: "2026-07-09T09:00:00",
          bookingToken: "first-private-token",
        },
        {
          requestedDate: "2026-07-09",
          actualDate: "2026-07-09",
          searchedFrom: "2026-07-09",
          searchedThrough: "2026-07-09",
        },
      ),
      availabilityFoundResponse(
        {
          provider: "Dr. Austin Bach",
          date: "2026-07-10",
          time: "10:00 AM",
          datetime: "2026-07-10T10:00:00",
          bookingToken: "second-private-token",
        },
        {
          requestedDate: "2026-07-10",
          actualDate: "2026-07-10",
          searchedFrom: "2026-07-10",
          searchedThrough: "2026-07-10",
        },
      ),
      {
        status: "booked",
        appointmentId: 789,
      },
    );
    const ctx = createToolContext(state);

    const firstResult = (await get_availability.execute(
      {
        date: "2026-07-09",
        appointmentLane: "medical_md",
      },
      {
        ctx: ctx as never,
        toolCallId: "tool-1",
      } as never,
    )) as Record<string, unknown>;
    const secondResult = (await get_availability.execute(
      {
        date: "2026-07-10",
        appointmentLane: "medical_md",
      },
      {
        ctx: ctx as never,
        toolCallId: "tool-2",
      } as never,
    )) as Record<string, unknown>;

    expect(firstResult).toMatchObject({
      slotId: "S1",
      slots: [expect.objectContaining({ slotId: "S1", date: "2026-07-09" })],
    });
    expect(secondResult).toMatchObject({
      slotId: "S2",
      slots: [expect.objectContaining({ slotId: "S2", date: "2026-07-10" })],
    });
    expect(state.availability.bookingTokensBySlotId).toEqual({
      S1: "first-private-token",
      S2: "second-private-token",
    });

    const result = await book_appt.execute(
      {
        slotId: "S1",
        appointmentReason: "eye exam",
        referringDoctor: "none",
        readBack: true,
      },
      {
        ctx: ctx as never,
        toolCallId: "tool-3",
      } as never,
    );

    expect(result).toMatchObject({
      status: "booked",
      appointmentId: 789,
    });
    expect(JSON.parse(fetchMock.mock.calls[2][1].body as string)).toMatchObject(
      {
        bookingToken: "first-private-token",
      },
    );
    expect(state.availability.slots.map((slot) => slot.slotId)).toEqual(["S2"]);
    expect(state.availability.bookingTokensBySlotId).toEqual({
      S2: "second-private-token",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
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
        appointmentLane: "routine_od",
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
        slotId: "S1",
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
      slotId: "S1",
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

  it("generates an availability status update only while a lookup is still running", async () => {
    const state = createState();
    clearAvailabilitySelection(state);
    markSchedulingTriaged(state);
    let resolveFetch: (response: {
      ok: true;
      json: () => Promise<Record<string, unknown>>;
    }) => void = () => undefined;
    const fetchMock = vi.fn(
      () =>
        new Promise<{
          ok: true;
          json: () => Promise<Record<string, unknown>>;
        }>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const ctx = createToolContext(state);
    const execution = get_availability.execute(
      {
        date: "2026-06-01",
        appointmentLane: "medical_md",
      },
      {
        ctx: ctx as never,
        toolCallId: "tool-1",
      } as never,
    ) as Promise<Record<string, unknown>>;

    await vi.advanceTimersByTimeAsync(499);
    expect(ctx.session.generateReply).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(ctx.waitForPlayout).toHaveBeenCalledTimes(1);
    expect(ctx.session.generateReply).toHaveBeenCalledWith({
      instructions: expect.stringContaining(
        "checking appointment availability",
      ),
      allowInterruptions: true,
      toolChoice: "none",
    });

    resolveFetch({
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
          },
        ],
      }),
    });

    const result = await execution;

    expect(ctx.spokenHandle.interrupt).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      result: "slots_found",
      next: "offer_slot",
      slotId: "S1",
    });
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

  it("blocks same-day and past-date availability locally", async () => {
    vi.setSystemTime(new Date("2026-06-08T18:00:00.000Z"));
    const state = createState();
    markSchedulingTriaged(state);
    state.availability.latestRouting = "all_three";
    storeAvailabilityBookingToken(state, "A", "stale-token");
    const ctx = createToolContext(state);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await get_availability.execute(
      {
        date: "2026-06-08",
        appointmentLane: "medical_md",
      },
      {
        ctx: ctx as never,
        toolCallId: "tool-1",
      } as never,
    );

    expect(result).toEqual({
      result: "invalid_date",
      reply:
        "Same-day and past-date appointments are not available. Ask for tomorrow or a later date.",
      next: "ask_future_date",
      earliestDate: "2026-06-09",
      slots: [],
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ctx.session.say).not.toHaveBeenCalled();
    expect(ctx.session.generateReply).not.toHaveBeenCalled();
    expect(state.availability.slots).toEqual([]);
    expect(state.availability.latestRouting).toBeNull();
    expect(state.availability.bookingTokensBySlotId).toEqual({});
  });

  it("returns cached no-availability for an identical search instead of fetching again", async () => {
    const state = createState();
    markSchedulingTriaged(state);
    const ctx = createToolContext(state);
    const fetchMock = stubFetchJson(noAvailabilityResponse());

    const firstResult = await getMedicalAvailability(ctx, "tool-1");
    const secondResult = await getMedicalAvailability(ctx, "tool-2");

    expect(firstResult).toEqual({
      result: "no_slots_found",
      reply:
        "I checked July 9 through July 23 and did not find openings. Ask if they want me to check starting July 24, or if they prefer a different day or time.",
      next: "ask_next_search_or_new_preference",
      searched: "2026-07-09 through 2026-07-23",
      nextSearchDate: "2026-07-24",
      slots: [],
    });
    expect(secondResult).toEqual(firstResult);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ctx.session.generateReply).not.toHaveBeenCalled();
  });

  it("does not cache retryable availability responses", async () => {
    const state = createState();
    markSchedulingTriaged(state);
    const ctx = createToolContext(state);
    const fetchMock = stubFetchJson(
      {
        status: "success",
        outcome: "availability_search_incomplete",
        requestedDate: "2026-07-09",
        searchedFrom: "2026-07-09",
        searchedThrough: "2026-07-23",
        shouldRetrySameSearch: true,
        slots: [],
      },
      noAvailabilityResponse(),
    );

    const firstResult = await getMedicalAvailability(ctx, "tool-1");
    const secondResult = await getMedicalAvailability(ctx, "tool-2");

    expect(firstResult).toMatchObject({
      result: "retry",
      next: "retry_search_once",
      slots: [],
    });
    expect(secondResult).toMatchObject({
      result: "no_slots_found",
      next: "ask_next_search_or_new_preference",
      slots: [],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(ctx.session.generateReply).not.toHaveBeenCalled();
  });

  it("does not cache availability error responses that ask for a new date or time", async () => {
    const state = createState();
    markSchedulingTriaged(state);
    const ctx = createToolContext(state);
    const fetchMock = stubFetchJson(
      {
        outcome: "scheduler_error",
        message: "The scheduler could not complete that search.",
        shouldRetrySameSearch: false,
      },
      noAvailabilityResponse(),
    );

    const firstResult = await getMedicalAvailability(ctx, "tool-1");
    const secondResult = await getMedicalAvailability(ctx, "tool-2");

    expect(firstResult).toEqual({
      result: "error",
      reply: "The scheduler could not complete that search.",
      next: "ask_new_date_or_time",
      slots: [],
    });
    expect(secondResult).toMatchObject({
      result: "no_slots_found",
      next: "ask_next_search_or_new_preference",
      slots: [],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(ctx.session.generateReply).not.toHaveBeenCalled();
  });

  it("requires a loaded patient before checking availability", async () => {
    const state = createState();
    markSchedulingTriaged(state);
    state.identity.patient.patientId = null;
    state.identity.patient.identityConfirmed = false;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await get_availability.execute(
      {
        date: "2026-06-01",
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    );

    expect(result).toEqual({
      result: "missing_patient",
      reply: "Verify or create the patient before checking availability.",
      next: "resolve_or_create_patient",
      slots: [],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("switches between preloaded phone-match patients and clears patient-scoped booking state", async () => {
    const state = createState();
    state.identity.patient = {
      ...state.identity.patient,
      status: "verified",
      identityConfirmed: true,
      patientId: "child-a",
      name: "DAVID MEJIA",
      dob: "01/01/2015",
      appointments: [],
      appointmentsStatus: "none",
    };
    state.identity.patientBackend = {
      insPlanId: "old-ins-plan",
      respPartyId: "old-resp-party",
    };
    state.identity.preCall = {
      status: "multiple_match_confirmed",
      source: "phone_lookup",
      callerPhone: "+17275551212",
      candidates: [
        {
          ref: "precall:1",
          firstName: "DAVID",
          lastName: "MEJIA",
          dob: "01/01/2015",
          patientId: "child-a",
          appointments: [],
          appointmentsStatus: "none",
          insuranceCarrier: "Aetna",
          insPlanId: "david-ins-plan",
          respPartyId: "shared-resp-party",
          routing: "all_three",
          allowedProviders: ["Dr. Bach"],
          routingAmbiguous: false,
          preauthRequired: false,
        },
        {
          ref: "precall:2",
          firstName: "ELLIE",
          lastName: "MEJIA",
          dob: "02/02/2017",
          patientId: "child-b",
          appointments: [
            {
              id: 456,
              date: "Tuesday, June 16, 2026",
              time: "10:00 AM",
              provider: "Dr. Licht",
              type: "Follow-up",
              facility: "Spring Hill",
              confirmed: false,
            },
          ],
          appointmentsStatus: "found",
          insuranceCarrier: "Humana PPO",
          insPlanId: "ellie-ins-plan",
          respPartyId: "shared-resp-party",
          routing: "bach_only",
          allowedProviders: ["Dr. Bach"],
          routingAmbiguous: false,
          preauthRequired: true,
        },
      ],
      selectedCandidateRef: "precall:1",
      identityPromotion: "confirmed_by_transcript",
    };
    state.runtime.trunkPhone = "+13523202007";
    state.office.activeKey = "spring-hill";
    state.office.phoneOverrides = {
      "crystal-river": "+13523202007",
      "spring-hill": "+17275919997",
    };
    markSchedulingTriaged(state, "routine_od");
    state.availability.latestRouting = "all_three";
    storeAvailabilityBookingToken(state, "A", "stale-token");
    state.identity.latestBookedAppointmentId = 123;
    state.insurance.lastEligibilityCheck = {
      plan: "Aetna",
      canonicalPlan: "Aetna",
      coverageType: "medical",
      currentCarrier: "Aetna",
      accepted: true,
    };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await resolve_patient.execute(
      {
        firstName: "Ellie",
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-resolve",
      } as never,
    );

    expect(result).toBe(
      "Switched active patient to ELLIE MEJIA. Check availability again before booking.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.identity.patient).toMatchObject({
      status: "verified",
      identityConfirmed: true,
      patientId: "child-b",
      name: "ELLIE MEJIA",
      dob: "02/02/2017",
      appointmentsStatus: "found",
    });
    expect(state.identity.patient.appointments).toEqual([
      {
        id: 456,
        date: "Tuesday, June 16, 2026",
        time: "10:00 AM",
        provider: "Dr. Licht",
        type: "Follow-up",
        facility: "Spring Hill",
        confirmed: false,
      },
    ]);
    expect(state.identity.preCall).toMatchObject({
      status: "multiple_match_confirmed",
      selectedCandidateRef: "precall:2",
      identityPromotion: "switched_by_identity_tool",
    });
    expect(state.identity.patientBackend).toEqual({
      insPlanId: "ellie-ins-plan",
      respPartyId: "shared-resp-party",
    });
    expect(state.insurance.onFile).toEqual({
      plan: "Humana PPO",
      canonicalPlan: "Humana PPO",
      coverageType: null,
      currentCarrier: "Humana PPO",
    });
    expect(state.insurance.lastEligibilityCheck).toBeNull();
    expect(state.workflow.routing).toEqual({
      routing: "bach_only",
      allowedProviders: ["Dr. Bach"],
      routingAmbiguous: false,
      preauthRequired: true,
    });
    expect(state.workflow.current).toBeUndefined();
    expect(state.office.activeKey).toBe("crystal-river");
    expect(state.office.phoneOverrides["crystal-river"]).toBe("+13523202007");
    expect(state.availability.slots).toEqual([]);
    expect(state.availability.latestRouting).toBeNull();
    expect(state.availability.bookingTokensBySlotId).toEqual({});
    expect(state.identity.latestBookedAppointmentId).toBeUndefined();
  });

  it("checks availability for a loaded appointment change without faking schedule intent", async () => {
    const state = createState();
    markAppointmentChangeContext(state);
    setLoadedAppointments(
      state,
      appointment({
        id: 123,
        date: "Tuesday, June 9, 2026",
        time: "8:30 AM",
        provider: "Dr. Austin Bach",
        type: "Established Pediatric Medical (Follow Up)",
        appointmentTypeId: 1005,
        facility: "Abita Eye Group Hollywood",
      }),
    );
    const fetchMock = stubFetchJson(
      availabilityFoundResponse({
        provider: "Dr. Austin Bach",
        date: "2026-07-09",
        time: "9:45 AM",
        datetime: "2026-07-09T09:45:00",
        bookingToken: "reschedule-token",
        columnId: 1478,
        profileId: 620,
        duration: 15,
      }),
    );

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
    });
    expect(result).toMatchObject({
      result: "slots_found",
      slotId: "S2",
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
    setLoadedAppointments(
      state,
      appointment({
        id: 123,
        date: "Tuesday, June 9, 2026",
        time: "8:30 AM",
        type: "Routine Vision / Glasses",
        appointmentTypeId: 6167,
        facility: "Crystal River",
      }),
    );
    const fetchMock = stubFetchJson(
      availabilityFoundResponse({
        provider: "Dr. Kyler Farnan",
        date: "2026-07-09",
        time: "10:00 AM",
        datetime: "2026-07-09T10:00:00",
        bookingToken: "routine-reschedule-token",
        columnId: 1555,
        profileId: 2075,
        duration: 30,
      }),
    );

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
    });
    expect(state.office.activeKey).toBe("spring-hill");
    expect(state.availability.latestRouting).toBe("optical_only");
    expect(result).toMatchObject({
      result: "slots_found",
      slotId: "S1",
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

  it("routes vision appointment type reschedule availability through optical routing", async () => {
    const state = createState();
    markAppointmentChangeContext(state);
    state.office.activeKey = "sweetwater";
    state.office.phoneOverrides = {
      sweetwater: "+17864657475",
    };
    state.identity.patient.dob = "04/15/2015";
    state.workflow.routing.routing = "bach_only";
    state.workflow.routing.allowedProviders = ["Dr. Bach"];
    state.availability.latestRouting = "bach_only";
    setLoadedAppointments(
      state,
      appointment({
        id: 20396260,
        date: "Friday, June 12, 2026",
        time: "9:00 AM",
        provider: "Dr. Maria Casas",
        type: "Established Pediatric Vision",
        appointmentTypeId: 4245,
        facility: "Abita Eye Group Sweetwater",
      }),
    );
    const fetchMock = stubFetchJson(
      availabilityFoundResponse(
        {
          provider: "Dr. Maria Casas",
          date: "2026-07-23",
          time: "9:00 AM",
          datetime: "2026-07-23T09:00:00",
          bookingToken: "sweetwater-optical-token",
          columnId: 1296,
          profileId: 1996,
          duration: 30,
        },
        {
          requestedDate: "2026-07-23",
          actualDate: "2026-07-23",
          searchedFrom: "2026-07-23",
          searchedThrough: "2026-07-23",
        },
      ),
    );

    const result = (await get_availability.execute(
      {
        date: "2026-07-23",
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    )) as Record<string, unknown>;

    expect(state.workflow.current).toEqual({
      intent: "change_appointment",
      appointmentLane: "not_applicable",
    });
    expect(state.office.activeKey).toBe("sweetwater");
    expect(state.availability.latestRouting).toBe("optical_only");
    expect(result).toMatchObject({
      result: "slots_found",
      slotId: "S2",
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toMatchObject(
      {
        date: "2026-07-23",
        dob: "04/15/2015",
        office: "+17864657475",
        routing: "optical_only",
      },
    );
  });

  it("clears stale scheduling lane when no-lane availability uses a loaded appointment", async () => {
    const state = createState();
    markSchedulingTriaged(state, "medical_md");
    state.office.activeKey = "sweetwater";
    state.office.phoneOverrides = {
      sweetwater: "+17864657475",
    };
    state.identity.patient.dob = "04/15/2015";
    state.workflow.routing.routing = "bach_only";
    state.workflow.routing.allowedProviders = ["Dr. Bach"];
    state.availability.latestRouting = "all_three";
    state.availability.slots = [
      availabilitySlot({
        spoken: "2026-07-10 9:00 AM with Dr. Bach",
        provider: "Dr. Bach",
        date: "2026-07-10",
        time: "9:00 AM",
        datetime: "2026-07-10T09:00:00",
      }),
    ];
    state.availability.bookingTokensBySlotId = {
      A: "stale-new-schedule-token",
    };
    setLoadedAppointments(
      state,
      appointment({
        id: 20396260,
        date: "Friday, June 12, 2026",
        time: "9:00 AM",
        provider: "Dr. Maria Casas",
        type: "Established Pediatric Vision",
        appointmentTypeId: 4245,
        facility: "Abita Eye Group Sweetwater",
      }),
    );
    const fetchMock = stubFetchJson(
      availabilityFoundResponse(
        {
          provider: "Dr. Maria Casas",
          date: "2026-07-23",
          time: "9:00 AM",
          datetime: "2026-07-23T09:00:00",
          bookingToken: "sweetwater-optical-token",
          columnId: 1296,
          profileId: 1996,
          duration: 30,
        },
        {
          requestedDate: "2026-07-23",
          actualDate: "2026-07-23",
          searchedFrom: "2026-07-23",
          searchedThrough: "2026-07-23",
        },
      ),
    );

    await get_availability.execute(
      {
        date: "2026-07-23",
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    );

    expect(state.workflow.current).toEqual({
      intent: "change_appointment",
      appointmentLane: "not_applicable",
    });
    expect(state.availability.latestRouting).toBe("optical_only");
    expect(state.availability.bookingTokensBySlotId).toEqual({
      S1: "sweetwater-optical-token",
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toMatchObject(
      {
        date: "2026-07-23",
        dob: "04/15/2015",
        office: "+17864657475",
        routing: "optical_only",
      },
    );
  });

  it("records appointment-change context from a single loaded appointment", async () => {
    const state = createState();
    setLoadedAppointments(
      state,
      appointment({
        id: 123,
        date: "Tuesday, June 9, 2026",
        time: "8:30 AM",
        provider: "Dr. Austin Bach",
        type: "Established Pediatric Medical (Follow Up)",
        appointmentTypeId: 1005,
        facility: "Abita Eye Group Hollywood",
      }),
    );
    const fetchMock = stubFetchJson(
      availabilityFoundResponse({}, { slots: [] }),
    );

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
    expect(state.workflow.current).toEqual({
      intent: "change_appointment",
      appointmentLane: "not_applicable",
    });
  });

  it("requires scheduling or existing appointment context before checking availability", async () => {
    const state = createState();
    clearSchedulingContext(state);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await get_availability.execute(
      {
        date: "2026-06-01",
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    );

    expect(result).toEqual({
      result: "missing_availability_context",
      reply:
        "Before checking availability for a reschedule, load appointments by resolving the patient. If this is a new appointment instead, pass appointmentLane medical_md or routine_od.",
      next: "resolve_patient_or_pass_lane",
      slots: [],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats failed appointment loading as unresolved reschedule context", async () => {
    const state = createState();
    clearSchedulingContext(state);
    state.identity.patient.appointmentsStatus = "error";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await get_availability.execute(
      {
        date: "2026-06-01",
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    );

    expect(result).toEqual({
      result: "missing_availability_context",
      reply:
        "Before checking availability for a reschedule, load appointments by resolving the patient. If this is a new appointment instead, pass appointmentLane medical_md or routine_od.",
      next: "resolve_patient_or_pass_lane",
      slots: [],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("points no-lane availability toward loaded-appointment confirmation", async () => {
    const state = createState();
    clearSchedulingContext(state);
    setLoadedAppointments(
      state,
      appointment({ id: 123 }),
      appointment({ id: 456 }),
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await get_availability.execute(
      {
        date: "2026-06-01",
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    );

    expect(result).toEqual({
      result: "missing_availability_context",
      reply:
        "Before checking availability, ask which loaded appointment the caller wants to move. If this is a new appointment instead, pass appointmentLane medical_md or routine_od.",
      next: "confirm_loaded_appointment_or_pass_lane",
      slots: [],
    });
    expect(state.workflow.current).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns patient recovery before checking availability", async () => {
    const state = createState();
    setPatientUnknown(state);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await get_availability.execute(
      {
        date: "2026-06-01",
        appointmentLane: "medical_md",
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    );

    expect(result).toEqual({
      result: "missing_patient",
      reply: "Verify or create the patient before checking availability.",
      next: "resolve_or_create_patient",
      slots: [],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("books from cached availability after inline scheduling lane is recorded", async () => {
    const state = createState();
    clearSchedulingContext(state);
    markSchedulingTriaged(state);
    storeAvailabilityBookingToken(state, "A", "private-token");
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        status: "booked",
        appointmentId: 456,
        providerName: "Doctor Smith",
        locationName: "Spring Hill",
        appointmentTypeName: "Medical",
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await book_appt.execute(
      {
        slotId: "A",
        appointmentReason: "blurry vision",
        referringDoctor: "none",
        readBack: true,
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    );

    expect(result).toMatchObject({
      status: "booked",
      appointmentId: 456,
    });
    expect(state.workflow.current).toEqual({
      intent: "schedule",
      appointmentLane: "medical_md",
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toMatchObject(
      {
        bookingToken: "private-token",
        patientId: "patient-1",
        routing: "all_three",
      },
    );
  });

  it("blocks book_appt from consuming appointment-change availability", async () => {
    const state = createState();
    markAppointmentChangeContext(state);
    storeAvailabilityBookingToken(state, "A", "private-token");
    const ctx = createToolContext(state);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      book_appt.execute(
        {
          slotId: "A",
          appointmentReason: "move my appointment",
          referringDoctor: "none",
        },
        {
          ctx: ctx as never,
          toolCallId: "tool-1",
        } as never,
      ),
    ).rejects.toThrow(
      "Use reschedule_appt for appointment changes so the old appointment is cancelled after the new booking succeeds.",
    );

    expect(ctx.speechHandle.allowInterruptions).toBe(true);
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
          readBack: true,
        },
        {
          ctx: ctx as never,
          toolCallId: "tool-1",
        } as never,
      ),
    ).rejects.toThrow(
      "Search availability again before booking because the selected slot expired.",
    );

    expect(ctx.speechHandle.allowInterruptions).toBe(true);
    expect(state.availability.slots).toEqual([]);
  });

  it("requires read-back confirmation before booking", async () => {
    const state = createState();
    markSchedulingTriaged(state);
    storeAvailabilityBookingToken(state, "A", "private-token");
    const ctx = createToolContext(state);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

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

    expect(result).toBe(
      "Read back June 1 at 9:00 AM with Doctor Smith and ask the caller to confirm it. Call book_appt again only after the caller confirms the appointment details are correct.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ctx.speechHandle.allowInterruptions).toBe(true);
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
        readBack: true,
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
        readBack: true,
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
        readBack: true,
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
        readBack: true,
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
        readBack: true,
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
        readBack: true,
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
        readBack: true,
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
    markNewPatientPathConfirmed(state);
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
        appointmentLane: "medical_md",
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
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      firstName: "Jane",
      lastName: "Doe",
      phone: "+17275551212",
      insurance: "self pay",
      subscriberNum: "self pay",
    });
  });

  it("requires not-registered confirmation before creating a patient chart", async () => {
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
        appointmentLane: "medical_md",
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

    expect(result).toBe(
      "Before creating a new chart, ask whether the patient is already registered with us and call resolve_patient with registrationStatus not_registered after the caller confirms they are not registered.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("marks a created chart as new-patient state when middleware omits status", async () => {
    const state = createState();
    state.identity.patient.patientId = null;
    state.identity.patient.name = null;
    state.identity.patient.identityConfirmed = false;
    markNewPatientPathConfirmed(state);
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
        appointmentLane: "medical_md",
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
    setSingleArshedPreCallCandidate(state);
    state.identity.patient.status = "new";
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
        appointmentLane: "routine_od",
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

  it("requires appointment lane before creating a patient", async () => {
    const state = createState();
    state.identity.patient.patientId = null;
    state.identity.patient.name = null;
    state.identity.patient.identityConfirmed = false;
    markNewPatientPathConfirmed(state);
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
      "Pass appointmentLane medical_md or routine_od before creating a patient.",
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires appointment lane to match checked insurance coverage before creating a patient", async () => {
    const baseParams = {
      firstName: "Jane",
      lastName: "Doe",
      dob: "01/01/1980",
      street: "123 Main St",
      aptSuite: "",
      city: "Spring Hill",
      state: "FL",
      zip: "34606",
      sex: "female" as const,
      insurance: "self pay",
      subscriberName: "Jane Doe",
      subscriberNum: "self pay",
      phone: "7275551212",
      readBack: true,
    };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const medicalState = createState();
    medicalState.identity.patient.patientId = null;
    medicalState.identity.patient.name = null;
    medicalState.identity.patient.identityConfirmed = false;
    markNewPatientPathConfirmed(medicalState);
    clearSchedulingContext(medicalState);
    markAcceptedInsurance(medicalState, {
      plan: "self pay",
      canonicalPlan: "self pay",
      coverageType: "medical",
    });

    await expect(
      add_patient.execute(
        {
          ...baseParams,
          appointmentLane: "routine_od",
        },
        {
          ctx: createToolContext(medicalState) as never,
          toolCallId: "tool-1",
        } as never,
      ),
    ).rejects.toThrow(
      "Use appointmentLane medical_md with medical coverage, or routine_od with routine_vision coverage. Run check_insurance again for the correct coverage before creating a patient.",
    );

    const routineState = createState();
    routineState.identity.patient.patientId = null;
    routineState.identity.patient.name = null;
    routineState.identity.patient.identityConfirmed = false;
    markNewPatientPathConfirmed(routineState);
    clearSchedulingContext(routineState);
    markAcceptedInsurance(routineState, {
      plan: "self pay",
      canonicalPlan: "self pay",
      coverageType: "routine_vision",
    });

    await expect(
      add_patient.execute(
        {
          ...baseParams,
          appointmentLane: "medical_md",
        },
        {
          ctx: createToolContext(routineState) as never,
          toolCallId: "tool-2",
        } as never,
      ),
    ).rejects.toThrow(
      "Use appointmentLane medical_md with medical coverage, or routine_od with routine_vision coverage. Run check_insurance again for the correct coverage before creating a patient.",
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires read-back confirmation before creating a patient", async () => {
    const state = createState();
    state.identity.patient.patientId = null;
    state.identity.patient.name = null;
    state.identity.patient.identityConfirmed = false;
    markNewPatientPathConfirmed(state);
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
        appointmentLane: "medical_md",
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
    markNewPatientPathConfirmed(state);
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
        appointmentLane: "medical_md",
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
    markNewPatientPathConfirmed(state);
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
        appointmentLane: "medical_md",
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

    const result = await resolve_patient.execute(
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

  it("clears stale booking context before resolving a different full-identity patient", async () => {
    const state = createState();
    state.runtime.trunkPhone = "+13523202007";
    state.office.activeKey = "spring-hill";
    state.office.phoneOverrides = {
      "crystal-river": "+13523202007",
      "spring-hill": "+17275919997",
    };
    markSchedulingTriaged(state, "routine_od");
    state.availability.latestRouting = "optical_only";
    storeAvailabilityBookingToken(state, "A", "stale-token");
    state.identity.latestBookedAppointmentId = 123;
    state.insurance.lastEligibilityCheck = {
      plan: "Aetna",
      canonicalPlan: "Aetna",
      coverageType: "routine_vision",
      currentCarrier: "Aetna",
      accepted: true,
    };
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        status: "verified",
        patientId: "patient-2",
        name: "John Doe",
        dob: "02/02/1982",
        phone: "+17275551212",
        insuranceCarrier: "Aetna",
        routing: "bach_only",
        allowedProviders: ["Dr. Bach"],
        routingAmbiguous: false,
        preauthRequired: false,
        appointmentsStatus: "none",
        appointments: [],
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await resolve_patient.execute(
      {
        firstName: "John",
        lastName: "Doe",
        dob: "02/02/1982",
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    expect(result).toBe(
      "Verified existing patient John Doe. Insurance on file: Aetna. No upcoming appointments are loaded.",
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      firstName: "John",
      lastName: "Doe",
      dob: "02/02/1982",
      office: "+13523202007",
    });
    expect(state.identity.patient.patientId).toBe("patient-2");
    expect(state.workflow.current).toBeUndefined();
    expect(state.office.activeKey).toBe("crystal-river");
    expect(state.availability.slots).toEqual([]);
    expect(state.availability.bookingTokensBySlotId).toEqual({});
    expect(state.identity.latestBookedAppointmentId).toBeUndefined();
    expect(state.insurance.lastEligibilityCheck).toBeNull();
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

    const result = await resolve_patient.execute(
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

    const result = await resolve_patient.execute(
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
    setSingleArshedPreCallCandidate(state);
    const fetchMock = stubFetchJson({
      status: "not_found",
      message: "No patient found matching that first name.",
    });

    const result = await resolve_patient.execute(
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
    setSingleArshedPreCallCandidate(state);
    stubFetchJson({
      status: "error",
      message: "Patient lookup failed. Try again.",
    });

    const result = await resolve_patient.execute(
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
    setSingleArshedPreCallCandidate(state);
    const fetchMock = stubFetchJson({
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
    });

    const result = await resolve_patient.execute(
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
    setPatientUnknown(state);
    setMultiplePreCallCandidates(state, [
      preCallCandidate({
        ref: "precall:1",
        firstName: "CHASE",
        lastName: "TEST",
        dob: "04/07/2000",
        patientId: "patient-chase",
        relationshipToCaller: "unknown",
        insuranceCarrier: null,
        insPlanId: null,
        respPartyId: "resp-chase",
        routing: null,
        allowedProviders: [],
      }),
      preCallCandidate({
        ref: "precall:2",
        firstName: "KYLE",
        lastName: "TEST",
        dob: "08/18/2000",
        patientId: "patient-kyle",
        relationshipToCaller: "unknown",
        insuranceCarrier: "Oscar",
        insPlanId: "plan-kyle",
        respPartyId: "resp-kyle",
        routing: "bach_licht",
        allowedProviders: ["Dr. Licht"],
      }),
    ]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await resolve_patient.execute(
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

  it("switches an active pre-call patient when another preloaded patient is resolved", async () => {
    const state = createState();
    state.identity.patient = {
      ...state.identity.patient,
      status: "verified",
      identityConfirmed: true,
      patientId: "patient-brandon",
      name: "BRANDON ANDERSON",
      dob: "04/05/2012",
      phone: null,
      appointments: [],
      appointmentsStatus: "none",
    };
    setMultiplePreCallCandidates(
      state,
      [
        preCallCandidate({
          ref: "precall:1",
          firstName: "BRANDON",
          lastName: "ANDERSON",
          dob: "04/05/2012",
          patientId: "patient-brandon",
          insuranceCarrier: undefined,
          routing: undefined,
          allowedProviders: undefined,
        }),
        preCallCandidate({
          ref: "precall:2",
          firstName: "MONIQUE",
          lastName: "HAMILTON",
          dob: "12/21/2016",
          patientId: "patient-monique",
          insuranceCarrier: undefined,
          routing: undefined,
          allowedProviders: undefined,
        }),
      ],
      {
        status: "multiple_match_confirmed",
        callerPhone: "+17863488102",
        selectedCandidateRef: "precall:1",
        identityPromotion: "confirmed_by_transcript",
      },
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await resolve_patient.execute(
      {
        firstName: "Monique",
        lastName: "Hamilton",
        dob: "12/21/2016",
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toBe(
      "Switched active patient to MONIQUE HAMILTON. Check availability again before booking.",
    );
    expect(state.identity.preCall.selectedCandidateRef).toBe("precall:2");
    expect(state.identity.preCall.identityPromotion).toBe(
      "switched_by_identity_tool",
    );
    expect(state.identity.patient.identityConfirmed).toBe(true);
    expect(state.identity.patient.patientId).toBe("patient-monique");
    expect(state.identity.patient.name).toBe("MONIQUE HAMILTON");
  });

  it("does not clear booking state when resolving the already active pre-call patient", async () => {
    const state = createState();
    state.identity.patient = {
      ...state.identity.patient,
      status: "verified",
      identityConfirmed: true,
      patientId: "patient-brandon",
      name: "BRANDON ANDERSON",
      dob: "04/05/2012",
      phone: null,
      appointments: [],
      appointmentsStatus: "none",
    };
    setMultiplePreCallCandidates(
      state,
      [
        preCallCandidate({
          ref: "precall:1",
          firstName: "BRANDON",
          lastName: "ANDERSON",
          dob: "04/05/2012",
          patientId: "patient-brandon",
          insuranceCarrier: undefined,
          routing: undefined,
          allowedProviders: undefined,
        }),
      ],
      {
        status: "multiple_match_confirmed",
        callerPhone: "+17863488102",
        selectedCandidateRef: "precall:1",
        identityPromotion: "confirmed_by_identity_tool",
      },
    );
    storeAvailabilityBookingToken(state, "A", "token-a");
    state.identity.latestBookedAppointmentId = 123;
    state.insurance.lastEligibilityCheck = {
      plan: "Aetna",
      canonicalPlan: "Aetna",
      coverageType: "medical",
      currentCarrier: "Aetna",
      accepted: true,
    };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await resolve_patient.execute({ firstName: "Brandon" }, {
      ctx: createToolContext(state) as never,
      toolCallId: "tool-1",
    } as never);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toBe(
      "BRANDON ANDERSON is already the active patient. Continue with loaded patient state.",
    );
    expect(state.availability.slots.map((slot) => slot.slotId)).toEqual(["A"]);
    expect(state.availability.bookingTokensBySlotId).toEqual({
      A: "token-a",
    });
    expect(state.identity.latestBookedAppointmentId).toBe(123);
    expect(state.insurance.lastEligibilityCheck).toEqual({
      plan: "Aetna",
      canonicalPlan: "Aetna",
      coverageType: "medical",
      currentCarrier: "Aetna",
      accepted: true,
    });
  });

  it("resolves an exact short first name from pre-call candidates", async () => {
    const state = createState();
    setPatientUnknown(state);
    setMultiplePreCallCandidates(state, [
      preCallCandidate({
        ref: "precall:1",
        firstName: "AL",
        lastName: "DOE",
        dob: "01/01/1980",
        patientId: "patient-al",
        insuranceCarrier: undefined,
        routing: undefined,
        allowedProviders: undefined,
      }),
      preCallCandidate({
        ref: "precall:2",
        firstName: "BOB",
        lastName: "DOE",
        dob: "02/02/1980",
        patientId: "patient-bob",
        insuranceCarrier: undefined,
        routing: undefined,
        allowedProviders: undefined,
      }),
    ]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await resolve_patient.execute({ firstName: "Al" }, {
      ctx: createToolContext(state) as never,
      toolCallId: "tool-1",
    } as never);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toBe(
      "Patient record loaded from the phone lookup. Continue with scheduling.",
    );
    expect(state.identity.patient.identityConfirmed).toBe(true);
    expect(state.identity.patient.patientId).toBe("patient-al");
  });

  it("asks for clarification when a first-name pre-call match is ambiguous", async () => {
    const state = createState();
    setPatientUnknown(state);
    setMultiplePreCallCandidates(state, [
      preCallCandidate({
        ref: "precall:1",
        firstName: "KYLE",
        lastName: "TEST",
        dob: "08/18/2000",
        patientId: "patient-kyle",
        appointmentsStatus: undefined,
        insuranceCarrier: undefined,
        routing: undefined,
        allowedProviders: undefined,
      }),
      preCallCandidate({
        ref: "precall:2",
        firstName: "KYLEE",
        lastName: "TEST",
        dob: "10/10/2015",
        patientId: "patient-kylee",
        appointmentsStatus: undefined,
        insuranceCarrier: undefined,
        routing: undefined,
        allowedProviders: undefined,
      }),
    ]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await resolve_patient.execute(
      {
        firstName: "Kyle",
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    );
    expect(result).toBe(
      "More than one preloaded patient matched that first name. Ask for the patient's date of birth, then call resolve_patient with first name, last name, and DOB.",
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

    const result = await resolve_patient.execute(
      {
        firstName: "Jane",
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    );
    expect(result).toBe(
      "Collect the patient's last name and date of birth, then call resolve_patient again.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("marks the new-chart path before chart creation while preserving accepted insurance eligibility", async () => {
    const state = createState();
    state.identity.patient.patientId = null;
    state.identity.patient.name = null;
    state.identity.patient.identityConfirmed = false;
    storeAvailabilityBookingToken(state, "A", "stale-token");
    state.identity.latestBookedAppointmentId = 123;
    state.insurance.lastEligibilityCheck = {
      plan: "Aetna",
      canonicalPlan: "Aetna",
      coverageType: "medical",
      currentCarrier: "Aetna",
      accepted: true,
    };

    const result = await resolve_patient.execute(
      { registrationStatus: "not_registered" },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    expect(result).toBe(
      "New-chart path confirmed. Continue registration and call add_patient only after read-back confirmation.",
    );
    expect(state.identity.patient.status).toBe("new");
    expect(state.identity.patient.identityConfirmed).toBe(false);
    expect(state.identity.patient.patientId).toBeNull();
    expect(state.availability.slots).toEqual([]);
    expect(state.identity.latestBookedAppointmentId).toBeUndefined();
    expect(state.insurance.lastEligibilityCheck).toEqual({
      plan: "Aetna",
      canonicalPlan: "Aetna",
      coverageType: "medical",
      currentCarrier: "Aetna",
      accepted: true,
    });
    expect(state.insurance.onFile).toBeNull();
  });

  it("does not demote an already confirmed patient to the new-chart path", async () => {
    const state = createState();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await resolve_patient.execute(
      { registrationStatus: "not_registered" },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    expect(result).toBe(
      "Jane Doe is already loaded as an existing patient. Continue with the loaded patient state instead of creating a new chart.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.identity.patient).toMatchObject({
      status: "matched",
      identityConfirmed: true,
      patientId: "patient-1",
      name: "Jane Doe",
      dob: "01/01/1980",
    });
    expect(state.insurance.onFile).toEqual({
      plan: "self pay",
      canonicalPlan: "self pay",
      coverageType: "medical",
      currentCarrier: "self pay",
    });
  });

  it("does not demote a comma-formatted active patient name to the new-chart path", async () => {
    const state = createState();
    state.identity.patient.name = "TEST,CHASE";
    state.identity.patient.dob = "01/01/1980";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await resolve_patient.execute(
      {
        firstName: "Chase",
        lastName: "Test",
        dob: "01/01/1980",
        registrationStatus: "not_registered",
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    expect(result).toBe(
      "TEST,CHASE is already loaded as an existing patient. Continue with the loaded patient state instead of creating a new chart.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.identity.patient).toMatchObject({
      status: "matched",
      identityConfirmed: true,
      patientId: "patient-1",
      name: "TEST,CHASE",
      dob: "01/01/1980",
    });
  });

  it("allows the new-chart path for a different patient after another patient is active", async () => {
    const state = createState();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await resolve_patient.execute(
      {
        firstName: "John",
        registrationStatus: "not_registered",
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    expect(result).toBe(
      "New-chart path confirmed. Continue registration and call add_patient only after read-back confirmation.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.identity.patient).toMatchObject({
      status: "new",
      identityConfirmed: false,
      patientId: null,
      name: null,
      dob: null,
    });
    expect(state.insurance.onFile).toBeNull();
  });

  it("allows the new-chart path when the new first name is a substring of the active patient name", async () => {
    const state = createState();
    state.identity.patient.name = "Sally Doe";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await resolve_patient.execute(
      {
        firstName: "Al",
        registrationStatus: "not_registered",
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    expect(result).toBe(
      "New-chart path confirmed. Continue registration and call add_patient only after read-back confirmation.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.identity.patient).toMatchObject({
      status: "new",
      identityConfirmed: false,
      patientId: null,
      name: null,
      dob: null,
    });
  });

  it("does not let a not-registered answer activate a preloaded first-name match", async () => {
    const state = createState();
    state.identity.patient.patientId = null;
    state.identity.patient.name = null;
    state.identity.patient.identityConfirmed = false;
    state.identity.preCall = {
      status: "single_match_pending_confirmation",
      source: "phone_lookup",
      callerPhone: "+17275551212",
      selectedCandidateRef: CALLER_CANDIDATE_REF,
      candidates: [
        {
          ref: CALLER_CANDIDATE_REF,
          firstName: "JANE",
          lastName: "DOE",
          dob: "01/01/1980",
          patientId: "patient-jane",
          appointments: [],
          appointmentsStatus: "none",
        },
      ],
      identityPromotion: "none",
    };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await resolve_patient.execute(
      { firstName: "Jane", registrationStatus: "not_registered" },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    expect(result).toBe(
      "New-chart path confirmed. Continue registration and call add_patient only after read-back confirmation.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.identity.preCall.status).toBe(
      "single_match_pending_confirmation",
    );
    expect(state.identity.patient.status).toBe("new");
    expect(state.identity.patient.identityConfirmed).toBe(false);
    expect(state.identity.patient.patientId).toBeNull();
  });

  it("blocks new chart creation when a confirmed pre-call candidate has the same last name and DOB", async () => {
    const state = createState();
    markNewPatientPathConfirmed(state);
    markSchedulingTriaged(state);
    markAcceptedInsurance(state, {
      plan: "Aetna",
      canonicalPlan: "Aetna",
      coverageType: "medical",
    });
    state.identity.preCall = {
      status: "single_match_confirmed",
      source: "phone_lookup",
      callerPhone: "+17275551212",
      selectedCandidateRef: CALLER_CANDIDATE_REF,
      candidates: [
        {
          ref: CALLER_CANDIDATE_REF,
          firstName: "JANE",
          lastName: "DOE",
          dob: "01/01/1980",
          patientId: "patient-jane",
          appointments: [],
          appointmentsStatus: "none",
        },
      ],
      identityPromotion: "confirmed_by_identity_tool",
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
        insurance: "Aetna",
        appointmentLane: "medical_md",
        subscriberName: "Jane Doe",
        subscriberNum: "ABC123",
        inboundPhoneConfirmed: true,
        readBack: true,
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-2" } as never,
    );

    expect(result).toBe(
      "A patient record may already exist for that last name and date of birth from the caller phone lookup. Confirm the existing patient record before creating a new chart.",
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
      plan: "Blue Cross Blue Shield",
    });
    expect(result).not.toHaveProperty("callerMessage");
    expect(result).not.toHaveProperty("canProceed");
    expect(result).not.toHaveProperty("callerFacingPlan");
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
    markNewPatientPathConfirmed(state);
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
        appointmentLane: "medical_md",
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
    });
  });

  it("creates a chart when new-chart confirmation follows an accepted insurance check", async () => {
    const state = createState();
    state.office.activeKey = "hollywood";
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
        name: "Maria Santos",
        phone: "+17275551212",
        insuranceCarrier: "Care Plus",
        routing: "all_three",
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const params = {
      firstName: "Maria",
      lastName: "Santos",
      dob: "01/01/1980",
      street: "123 Main St",
      aptSuite: "",
      city: "Spring Hill",
      state: "FL",
      zip: "34606",
      sex: "female" as const,
      insurance: "Care Plus Medicare",
      appointmentLane: "medical_md" as const,
      subscriberName: "Maria Santos",
      subscriberNum: "ABC123",
      inboundPhoneConfirmed: true,
      readBack: true,
    };

    await check_insurance.execute(
      {
        plan: "Care Plus Medicare",
        coverageType: "medical",
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    const prematureResult = await add_patient.execute(params, {
      ctx: createToolContext(state) as never,
      toolCallId: "tool-2",
    } as never);
    expect(prematureResult).toBe(
      "Before creating a new chart, ask whether the patient is already registered with us and call resolve_patient with registrationStatus not_registered after the caller confirms they are not registered.",
    );

    await resolve_patient.execute({ registrationStatus: "not_registered" }, {
      ctx: createToolContext(state) as never,
      toolCallId: "tool-3",
    } as never);
    const result = await add_patient.execute(params, {
      ctx: createToolContext(state) as never,
      toolCallId: "tool-4",
    } as never);

    expect(result).toBe(
      "Created a patient chart for Maria Santos. Continue with scheduling.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      insurance: "CarePlus Medicare Medical",
      subscriberNum: "ABC123",
    });
    expect(state.insurance.onFile).toEqual({
      plan: "Care Plus",
      canonicalPlan: "CarePlus Medicare Medical",
      coverageType: "medical",
      currentCarrier: "Care Plus",
    });
    expect(state.insurance.lastEligibilityCheck).toBeNull();
  });

  it("treats duplicate add_patient after successful chart creation as already done", async () => {
    const state = createState();
    state.identity.patient.patientId = null;
    state.identity.patient.name = null;
    state.identity.patient.identityConfirmed = false;
    markNewPatientPathConfirmed(state);
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
    const params = {
      firstName: "Jane",
      lastName: "Doe",
      dob: "01/01/1980",
      street: "123 Main St",
      aptSuite: "",
      city: "Spring Hill",
      state: "FL",
      zip: "34606",
      sex: "female" as const,
      insurance: "self pay",
      appointmentLane: "medical_md" as const,
      subscriberName: "Jane Doe",
      subscriberNum: "self pay",
      inboundPhoneConfirmed: true,
      readBack: true,
    };

    await add_patient.execute(params, {
      ctx: createToolContext(state) as never,
      toolCallId: "tool-1",
    } as never);
    const result = await add_patient.execute(params, {
      ctx: createToolContext(state) as never,
      toolCallId: "tool-2",
    } as never);

    expect(result).toBe(
      "Patient chart is already created for Jane Doe. Continue with scheduling.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
      plan: "Ambetter",
    });
    expect(result).not.toHaveProperty("callerMessage");
    expect(result).not.toHaveProperty("canonicalPlan");
    expect(state.insurance.lastEligibilityCheck).toEqual({
      plan: "Ambetter",
      canonicalPlan: "Envolve",
      coverageType: "routine_vision",
      currentCarrier: "Ambetter",
      accepted: true,
    });
  });

  it("accepts Simply Healthcare for routine vision checks", async () => {
    const state = createState();
    state.office.activeKey = "hollywood";

    const result = (await check_insurance.execute(
      {
        plan: "Simply Healthcare Medicaid",
        coverageType: "routine_vision",
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    )) as Record<string, unknown>;

    expect(result).toEqual({
      status: "accepted",
      plan: "Simply Healthcare Medicaid",
    });
    expect(result).not.toHaveProperty("callerMessage");
    expect(result).not.toHaveProperty("canonicalPlan");
    expect(state.insurance.lastEligibilityCheck).toEqual({
      plan: "Simply Healthcare Medicaid",
      canonicalPlan: "iCare",
      coverageType: "routine_vision",
      currentCarrier: "Simply Healthcare Medicaid",
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
      plan: "Humana PPO",
      acceptedAtAlternateOffice: "Spring Hill",
      alternatePlan: "Humana PPO",
      routeTool: "route_to_spring_hill",
    });
    expect(result).not.toHaveProperty("canonicalPlan");
    expect(result).not.toHaveProperty("callerMessage");
    expect(result).not.toHaveProperty("canProceed");
    expect(result).not.toHaveProperty("callerFacingPlan");
    expect(state.insurance.lastEligibilityCheck).toMatchObject({
      plan: "Humana PPO",
      canonicalPlan: null,
      coverageType: "medical",
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
    setLoadedAppointments(
      state,
      appointment({
        id: 123,
        date: "June 5",
        time: "10:00 AM",
        provider: "Dr. Bach",
      }),
    );
    const ctx = createToolContext(state);
    const fetchMock = stubFetchJson({
      status: "cancelled",
      appointmentId: 123,
      message: "Appointment cancelled successfully",
    });

    const result = await cancel_appt.execute({}, {
      ctx: ctx as never,
      toolCallId: "tool-1",
    } as never);

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
    setLoadedAppointments(
      state,
      appointment({
        id: 111,
        date: "Monday, June 1, 2026",
        time: "9:00 AM",
        provider: "Dr. Bach",
      }),
      appointment({
        id: 222,
        date: "Tuesday, June 2, 2026",
        time: "10:00 AM",
        provider: "Dr. Licht",
        type: "Routine Vision",
        facility: "Crystal River",
      }),
    );
    const fetchMock = stubFetchJson({
      status: "cancelled",
      appointmentId: 222,
      message: "Appointment cancelled successfully",
    });

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

  it("cancels by caller date and time when a legacy appointment ID is wrong", async () => {
    const state = createState();
    setLoadedAppointments(
      state,
      appointment({
        id: 111,
        date: "Monday, June 1, 2026",
        time: "9:00 AM",
        provider: "Dr. Bach",
      }),
      appointment({
        id: 222,
        date: "Thursday, June 25, 2026",
        time: "3:15 PM",
        provider: "Dr. Calero",
      }),
    );
    const fetchMock = stubFetchJson({
      status: "cancelled",
      appointmentId: 222,
      message: "Appointment cancelled successfully",
    });

    const result = await cancel_appt.execute(
      {
        appointmentId: 1,
        appointmentDate: "June 25",
        appointmentTime: "3:15 PM",
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    );

    expect(result).toBe(
      "Cancelled the appointment on Thursday, June 25, 2026 at 3:15 PM.",
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

  it("treats duplicate cancel_appt for a cancelled appointment as already done", async () => {
    const state = createState();
    setLoadedAppointments(state, appointment({ provider: "Dr. Bach" }));
    const fetchMock = stubFetchJson({
      status: "cancelled",
      appointmentId: 123,
      message: "Appointment cancelled successfully",
    });

    await cancel_appt.execute(
      {
        appointmentDate: "June 1",
        appointmentTime: "9 AM",
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    );
    const result = await cancel_appt.execute(
      {
        appointmentDate: "June 1",
        appointmentTime: "9 AM",
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-2",
      } as never,
    );

    expect(result).toBe(
      "That appointment was already cancelled on this call: Monday, June 1, 2026 at 9:00 AM. Continue without calling cancel_appt again.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not replay a cancellation after switching active patients", async () => {
    const state = createState();
    setLoadedAppointments(state, appointment({ provider: "Dr. Bach" }));
    const fetchMock = stubFetchJson({
      status: "cancelled",
      appointmentId: 123,
      message: "Appointment cancelled successfully",
    });

    await cancel_appt.execute(
      {
        appointmentDate: "June 1",
        appointmentTime: "9 AM",
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    );
    state.identity.patient = {
      ...state.identity.patient,
      patientId: "patient-2",
      name: "John Doe",
      appointments: [],
      appointmentsStatus: "none",
    };

    await expect(
      cancel_appt.execute(
        {
          appointmentDate: "June 1",
          appointmentTime: "9 AM",
        },
        {
          ctx: createToolContext(state) as never,
          toolCallId: "tool-2",
        } as never,
      ),
    ).rejects.toThrow(
      "No loaded appointment matches those details. Load appointments again or ask which loaded appointment to cancel.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("asks for clarification when a caller date matches multiple appointments", async () => {
    const state = createState();
    setLoadedAppointments(
      state,
      appointment({
        id: 111,
        date: "Tuesday, June 2, 2026",
        time: "9:00 AM",
        provider: "Dr. Bach",
      }),
      appointment({
        id: 222,
        date: "Tuesday, June 2, 2026",
        time: "2:00 PM",
        provider: "Dr. Licht",
        type: "Routine Vision",
        facility: "Crystal River",
      }),
    );
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
        readBack: true,
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
    state.office.activeKey = "crystal-river";
    state.office.phoneOverrides = {
      "crystal-river": "+13523202007",
    };
    prepareRescheduleState(state, {
      context: "change_appointment",
      appointmentOverrides: {
        type: "Crystal River New Patient",
        appointmentTypeId: 6167,
        facility: "Crystal River",
      },
    });
    const fetchMock = stubRescheduleFetch({
      status: "booked",
      appointmentId: 456,
      providerName: "Doctor Smith",
      locationName: "Crystal River",
      appointmentTypeId: 6167,
      appointmentTypeName: "Crystal River New Patient",
    });

    const result = await reschedule_appt.execute(
      {
        newAppointmentSlotRef: "A",
        appointmentReason: "move my appointment",
        referringDoctor: "none",
        readBack: true,
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
    expect(fetchCallKinds(fetchMock)).toEqual(["book", "cancel"]);
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

  it("lets unsupported old appointment types resolve from reschedule routing", async () => {
    const state = createState();
    prepareRescheduleState(state, {
      context: "change_appointment",
      appointmentOverrides: {
        type: "Established Adult Medical (Follow Up)",
        appointmentTypeId: 3315,
        facility: "Spring Hill",
      },
    });
    const fetchMock = stubRescheduleFetch({
      status: "booked",
      appointmentId: 456,
      providerName: "Doctor Smith",
      locationName: "Spring Hill",
      appointmentTypeName: "Medical",
    });

    await reschedule_appt.execute(
      {
        newAppointmentSlotRef: "A",
        appointmentReason: "move my appointment",
        referringDoctor: "none",
        readBack: true,
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    );

    const bookingBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(bookingBody).toMatchObject({
      bookingToken: "private-token",
      patientId: "patient-1",
      patientStatus: "established",
      visitCategory: "medical",
      visitKind: "medical",
      routing: "all_three",
    });
    expect(bookingBody).not.toHaveProperty("appointmentTypeId");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string)).toEqual({
      appointmentId: 123,
      patientId: "patient-1",
      office: "+17275919997",
    });
  });

  it("requires read-back confirmation before rescheduling", async () => {
    const state = createState();
    prepareRescheduleState(state, { context: "change_appointment" });
    const ctx = createToolContext(state);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await reschedule_appt.execute(
      {
        newAppointmentSlotRef: "A",
        appointmentReason: "move my appointment",
        referringDoctor: "none",
      },
      {
        ctx: ctx as never,
        toolCallId: "tool-1",
      } as never,
    );

    expect(result).toBe(
      "Read back June 1 at 9:00 AM with Doctor Smith and ask the caller to confirm it as the new appointment. Call reschedule_appt again only after the caller confirms the new appointment details are correct.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ctx.speechHandle.allowInterruptions).toBe(true);
  });

  it("does not require a live booking token before reschedule read-back confirmation", async () => {
    const state = createState();
    prepareRescheduleState(state, {
      context: "change_appointment",
      token: "",
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await reschedule_appt.execute(
      {
        newAppointmentSlotRef: "A",
        appointmentReason: "move my appointment",
        referringDoctor: "none",
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    );

    expect(result).toBe(
      "Read back June 1 at 9:00 AM with Doctor Smith and ask the caller to confirm it as the new appointment. Call reschedule_appt again only after the caller confirms the new appointment details are correct.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reschedules by caller date and time when the supplied appointment ID is wrong", async () => {
    const state = createState();
    prepareRescheduleState(state, { context: "change_appointment" });
    const fetchMock = stubRescheduleFetch({
      status: "booked",
      appointmentId: 456,
      providerName: "Doctor Smith",
      locationName: "Spring Hill",
      appointmentTypeName: "Medical",
    });

    const result = await reschedule_appt.execute(
      {
        newAppointmentSlotRef: "A",
        appointmentReason: "move my appointment",
        referringDoctor: "none",
        readBack: true,
        appointmentId: 1,
        oldAppointmentDate: "June 1",
        oldAppointmentTime: "9:00 AM",
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    );

    expect(result).toMatchObject({
      status: "rescheduled",
      appointmentId: 456,
      cancelledAppointmentId: 123,
    });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string)).toEqual({
      appointmentId: 123,
      patientId: "patient-1",
      office: "+17275919997",
    });
  });

  it("reschedules the single loaded appointment when the supplied appointment ID is wrong", async () => {
    const state = createState();
    prepareRescheduleState(state, { context: "change_appointment" });
    const fetchMock = stubRescheduleFetch({
      status: "booked",
      appointmentId: 456,
      providerName: "Doctor Smith",
      locationName: "Spring Hill",
      appointmentTypeName: "Medical",
    });

    const result = await reschedule_appt.execute(
      {
        slotId: "A",
        appointmentReason: "move my appointment",
        referringDoctor: "none",
        readBack: true,
        appointmentId: 999,
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    );

    expect(result).toMatchObject({
      status: "rescheduled",
      appointmentId: 456,
      cancelledAppointmentId: 123,
    });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string)).toEqual({
      appointmentId: 123,
      patientId: "patient-1",
      office: "+17275919997",
    });
  });

  it("does not reschedule again when the selected slot matches the completed reschedule", async () => {
    const state = createState();
    prepareRescheduleState(state, { context: "change_appointment" });
    const fetchMock = stubRescheduleFetch({
      status: "booked",
      appointmentId: 456,
      providerName: "Doctor Smith",
      locationName: "Spring Hill",
      appointmentTypeName: "Medical",
    });

    await reschedule_appt.execute(
      {
        slotId: "A",
        appointmentReason: "move my appointment",
        referringDoctor: "none",
        readBack: true,
        appointmentId: 123,
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    );

    const duplicateSlot: TestCallState["availability"]["slots"][number] =
      availabilitySlot({
        slotId: "B",
      });
    state.availability.slots.push(duplicateSlot);
    storeAvailabilityBookingToken(state, "B", "private-token-b");

    const result = await reschedule_appt.execute(
      {
        slotId: "B",
        appointmentReason: "move my appointment",
        referringDoctor: "none",
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-2",
      } as never,
    );

    expect(result).toBe(
      "The appointment is already rescheduled to June 1 at 9:00 AM with Doctor Smith. Tell the caller the confirmed appointment details instead of rescheduling again.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(state.availability.slots).toEqual([duplicateSlot]);
    expect(state.availability.bookingTokensBySlotId).toEqual({
      B: "private-token-b",
    });
  });

  it("allows a caller correction to a different slot after a successful reschedule", async () => {
    const state = createState();
    prepareRescheduleState(state, { context: "change_appointment" });
    let bookingCallCount = 0;
    const fetchMock = vi.fn(async (url: string | URL) => {
      const path = String(url);
      if (path.includes("/api/appointment/book")) {
        bookingCallCount += 1;
        return {
          ok: true,
          json: async () => ({
            status: "booked",
            appointmentId: bookingCallCount === 1 ? 456 : 789,
            providerName: "Doctor Smith",
            locationName: "Spring Hill",
            appointmentTypeName: "Medical",
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          status: "cancelled",
          message: "Appointment cancelled successfully",
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    await reschedule_appt.execute(
      {
        slotId: "A",
        appointmentReason: "move my appointment",
        referringDoctor: "none",
        readBack: true,
        appointmentId: 123,
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    );

    state.availability.slots.push(
      availabilitySlot({
        slotId: "B",
        spoken: "2026-06-01 2:00 PM with Doctor Smith",
        time: "2:00 PM",
        datetime: "2026-06-01T14:00:00",
      }),
    );
    storeAvailabilityBookingToken(state, "B", "private-token-b");

    const result = await reschedule_appt.execute(
      {
        slotId: "B",
        appointmentReason: "move my appointment",
        referringDoctor: "none",
        readBack: true,
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-2",
      } as never,
    );

    expect(result).toMatchObject({
      status: "rescheduled",
      bookingStatus: "booked",
      appointmentId: 789,
      appointmentDate: "2026-06-01",
      appointmentTime: "2:00 PM",
      cancelledAppointmentId: 456,
      cancellationStatus: "cancelled",
      message:
        "Rescheduled the appointment to June 1 at 2:00 PM with Doctor Smith. Cancelled the old appointment on 2026-06-01 at 9:00 AM.",
    });
    expect(fetchCallKinds(fetchMock)).toEqual([
      "book",
      "cancel",
      "book",
      "cancel",
    ]);
    expect(JSON.parse(fetchMock.mock.calls[3][1].body as string)).toEqual({
      appointmentId: 456,
      patientId: "patient-1",
      office: "+17275919997",
    });
    expect(state.identity.patient.appointments).toEqual([
      {
        id: 789,
        date: "2026-06-01",
        time: "2:00 PM",
        provider: "Doctor Smith",
        type: "Medical",
        facility: "Spring Hill",
        confirmed: true,
      },
    ]);
    expect(state.identity.completedReschedulesByPatientId["patient-1"]).toEqual(
      {
        status: "rescheduled",
        appointmentDescription: "June 1 at 2:00 PM with Doctor Smith",
      },
    );
  });

  it("cancels the old appointment through its original office after routine reschedule routing", async () => {
    const state = createState();
    state.office.activeKey = "spring-hill";
    state.office.phoneOverrides = {
      "crystal-river": "+13523202007",
      "spring-hill": "+17275919997",
    };
    markSchedulingTriaged(state, "routine_od");
    setLoadedAppointments(
      state,
      appointment({
        type: "Crystal River New Patient",
        appointmentTypeId: 6167,
        facility: "Crystal River",
      }),
    );
    state.availability.slots = [
      availabilitySlot({
        spoken: "2026-06-03 10:00 AM with Doctor Smith",
        date: "2026-06-03",
        time: "10:00 AM",
        datetime: "2026-06-03T10:00:00",
        routing: "optical_only",
      }),
    ];
    storeAvailabilityBookingToken(state, "A", "private-token");
    const fetchMock = stubRescheduleFetch({
      status: "booked",
      appointmentId: 456,
      providerName: "Doctor Smith",
      locationName: "Spring Hill",
      appointmentTypeName: "Routine Vision",
    });

    const result = await reschedule_appt.execute(
      {
        slotId: "A",
        appointmentReason: "move my appointment",
        referringDoctor: "none",
        readBack: true,
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

  it("lets Sweetwater optical reschedules resolve appointment type from routing", async () => {
    const state = createState();
    state.office.activeKey = "sweetwater";
    state.office.phoneOverrides = {
      sweetwater: "+17864657475",
    };
    markAppointmentChangeContext(state);
    state.workflow.routing.routing = "optical_only";
    setLoadedAppointments(
      state,
      appointment({
        id: 20396260,
        date: "Friday, June 12, 2026",
        time: "9:00 AM",
        provider: "Dr. Maria Casas",
        type: "Established Pediatric Medical (Follow Up)",
        appointmentTypeId: 1005,
        facility: "Abita Eye Group Sweetwater",
      }),
    );
    state.availability.slots = [
      availabilitySlot({
        spoken: "2026-07-23 9:00 AM with Dr. Maria Casas",
        provider: "Dr. Maria Casas",
        date: "2026-07-23",
        time: "9:00 AM",
        datetime: "2026-07-23T09:00:00",
        routing: "optical_only",
      }),
    ];
    storeAvailabilityBookingToken(state, "A", "sweetwater-optical-token");
    const fetchMock = stubRescheduleFetch({
      status: "booked",
      appointmentId: 20396300,
      providerName: "Dr. Maria Casas",
      locationName: "Abita Eye Group Sweetwater",
      appointmentTypeName: "Routine Vision",
    });

    await reschedule_appt.execute(
      {
        slotId: "A",
        appointmentReason: "move my appointment",
        referringDoctor: "none",
        readBack: true,
        appointmentId: 20396260,
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    );

    const bookingBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(bookingBody).toMatchObject({
      bookingToken: "sweetwater-optical-token",
      patientId: "patient-1",
      patientStatus: "established",
      routing: "optical_only",
      visitCategory: "routine_vision",
      visitKind: "routine_vision",
    });
    expect(bookingBody).not.toHaveProperty("appointmentTypeId");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string)).toEqual({
      appointmentId: 20396260,
      patientId: "patient-1",
      office: "+17864657475",
    });
  });

  it("does not cancel the old appointment when reschedule booking fails", async () => {
    const state = createState();
    prepareRescheduleState(state);
    const fetchMock = stubFetchJson({
      status: "error",
      outcome: "slot_unavailable",
      message: "This time slot is no longer available.",
    });

    const result = await reschedule_appt.execute(
      {
        slotId: "A",
        appointmentReason: "move my appointment",
        referringDoctor: "none",
        readBack: true,
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
    setLoadedAppointments(
      state,
      appointment({
        id: 111,
        date: "Tuesday, June 2, 2026",
        time: "9:00 AM",
        provider: "Dr. Bach",
      }),
      appointment({
        id: 222,
        date: "Tuesday, June 2, 2026",
        time: "2:00 PM",
        type: "Routine Vision",
      }),
    );
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
    prepareRescheduleState(state);
    const fetchMock = stubRescheduleFetch(
      {
        status: "booked",
        appointmentId: 456,
        providerName: "Doctor Smith",
        locationName: "Spring Hill",
        appointmentTypeName: "Medical",
      },
      {
        status: "error",
        message: "Unable to verify appointment before cancellation.",
      },
    );

    const result = await reschedule_appt.execute(
      {
        slotId: "A",
        appointmentReason: "move my appointment",
        referringDoctor: "none",
        readBack: true,
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

    const heldSlot: TestCallState["availability"]["slots"][number] =
      availabilitySlot({
        slotId: "B",
        spoken: "2026-06-03 2:00 PM with Doctor Smith",
        date: "2026-06-03",
        time: "2:00 PM",
        datetime: "2026-06-03T14:00:00",
      });
    state.availability.slots.push(heldSlot);
    storeAvailabilityBookingToken(state, "B", "private-token-b");

    const replayResult = await reschedule_appt.execute(
      {
        slotId: "B",
        appointmentReason: "move my appointment",
        referringDoctor: "none",
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-2",
      } as never,
    );

    expect(replayResult).toBe(
      "The new appointment was already booked, but the old appointment still needs office staff to finish cancellation. Transfer the caller instead of rescheduling again.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(state.availability.slots).toEqual([heldSlot]);
    expect(state.availability.bookingTokensBySlotId).toEqual({
      B: "private-token-b",
    });
    expect(
      state.identity.patient.appointments.map((appointment) => appointment.id),
    ).toEqual([123, 456]);
  });

  it("keeps both appointments when reschedule cancellation request throws after booking", async () => {
    const state = createState();
    prepareRescheduleState(state);
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
        readBack: true,
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
    expect(state.insurance.lastEligibilityCheck).toEqual({
      plan: "Humana PPO",
      canonicalPlan: "Humana PPO",
      coverageType: "medical",
      currentCarrier: "Humana PPO",
      accepted: true,
    });
    expect(state.workflow.routing.routing).toBe("all_three");
    expect(state.availability.slots).toEqual([]);
  });

  it("waits for existing speech before transferring the caller", async () => {
    const state = createState();
    const ctx = createToolContext(state);

    const result = await transfer_call.execute({}, {
      ctx: ctx as never,
      toolCallId: "tool-1",
    } as never);

    expect(ctx.speechHandle.allowInterruptions).toBe(false);
    expect(ctx.waitForPlayout).toHaveBeenCalledTimes(1);
    expect(ctx.session.generateReply).not.toHaveBeenCalled();
    expect(ctx.spokenHandle.waitForPlayout).not.toHaveBeenCalled();
    expect(ctx.waitForPlayout.mock.invocationCallOrder[0]).toBeLessThan(
      transferCallerToOfficeMock.mock.invocationCallOrder[0] ?? 0,
    );
    expect(transferCallerToOfficeMock).toHaveBeenCalledWith(state);
    expect(result).toBe("Transfer started to the spring-hill office.");
    expect(state.runtime.transferred).toBe(true);
  });
});
