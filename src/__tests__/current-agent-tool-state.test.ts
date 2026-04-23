import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CallState,
  type CallerAppointment,
  type SelectedSlot,
  book_appt,
  cancel_appt,
  confirm_appt,
  createInitialCallState,
  get_availability,
  lookupByPhone,
  lookup_knowledge,
  route_to_spring_hill,
} from "../tools.js";
import {
  CRYSTAL_RIVER_OFFICE_PHONE,
  SPRING_HILL_OFFICE_PHONE,
} from "../offices.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function fetchMock(): ReturnType<typeof vi.fn> {
  return vi.mocked(fetch) as unknown as ReturnType<typeof vi.fn>;
}

function requestBodies(): Record<string, unknown>[] {
  return fetchMock().mock.calls.map((call) =>
    JSON.parse((call[1] as RequestInit).body as string),
  ) as Record<string, unknown>[];
}

function isoDateDaysFromNow(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function todayIsoInEastern(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) throw new Error("Missing date part");
  return `${year}-${month}-${day}`;
}

function futureIsoDate(): string {
  return isoDateDaysFromNow(30);
}

function pastIsoDate(): string {
  return isoDateDaysFromNow(-30);
}

function toolOptions(state: CallState) {
  return {
    ctx: {
      session: { userData: state },
      waitForPlayout: vi.fn(async () => {}),
      speechHandle: { allowInterruptions: true },
    },
    toolCallId: "test-tool-call",
  } as any;
}

function verifiedState(
  overrides: Partial<CallState> = {},
  trunkPhone = SPRING_HILL_OFFICE_PHONE,
): CallState {
  return {
    ...createInitialCallState({
      officeKey:
        trunkPhone === CRYSTAL_RIVER_OFFICE_PHONE
          ? "crystal-river"
          : "spring-hill",
      officePhone: trunkPhone,
      amdOfficePhone: trunkPhone,
      sipRoomName: "test-room",
      sipParticipantIdentity: "sip-test",
      callerPhone: "+15551234567",
      phoneLookup: {
        status: "verified",
        patientId: "123",
        name: "Patient, Test",
        dob: "01/01/1980",
        phone: "+15551234567",
        insuranceCarrier: "Florida Blue",
        insPlanId: "plan-1",
        respPartyId: "resp-1",
        routing: "accepted",
        allowedProviders: [],
        routingAmbiguous: false,
        appointments: [],
      },
    }),
    ...overrides,
  };
}

function slot(overrides: Partial<SelectedSlot> = {}): SelectedSlot {
  const date = futureIsoDate();
  return {
    startDatetime: `${date}T09:00`,
    columnId: 10,
    profileId: 20,
    duration: 30,
    appointmentTypeId: 1007,
    ...overrides,
  };
}

function appointment(
  overrides: Partial<CallerAppointment> = {},
): CallerAppointment {
  return {
    id: 456,
    date: futureIsoDate(),
    time: "9:00 AM",
    provider: "Dr. Noel",
    type: "Existing Adult",
    facility: "Spring Hill",
    confirmed: true,
    ...overrides,
  };
}

describe("current agent tool state guards", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps phone lookup outages distinct from no-match lookups", async () => {
    fetchMock().mockRejectedValueOnce(new Error("network down"));

    const result = await lookupByPhone(
      "+15551234567",
      SPRING_HILL_OFFICE_PHONE,
    );

    expect(result).toEqual({
      status: "lookup_error",
      message:
        "Phone lookup is temporarily unavailable. Verify the caller normally; do not treat this as a confirmed no-match.",
    });
  });

  it("blocks duplicate availability checks for the same patient, reason, office, and date", async () => {
    const state = verifiedState();
    const date = futureIsoDate();
    fetchMock().mockImplementation(() =>
      Promise.resolve(jsonResponse({ slots: [slot()] })),
    );

    const first = await get_availability.execute(
      { date, reasonForVisit: "follow-up" },
      toolOptions(state),
    );
    const second = await get_availability.execute(
      { date, reasonForVisit: "follow-up" },
      toolOptions(state),
    );

    expect(first).toMatchObject({ status: "found", slotCount: 1 });
    expect(second).toContain("already checked");
    expect(fetchMock()).toHaveBeenCalledTimes(1);
  });

  it("rejects same-day availability before calling the scheduler", async () => {
    const state = verifiedState();

    const result = await get_availability.execute(
      { date: todayIsoInEastern(), reasonForVisit: "follow-up" },
      toolOptions(state),
    );

    expect(result).toContain("Same-day or past appointments");
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it("allows the same availability date after routing a Crystal River call to Spring Hill", async () => {
    const state = verifiedState({}, CRYSTAL_RIVER_OFFICE_PHONE);
    const date = futureIsoDate();
    fetchMock().mockImplementation(() =>
      Promise.resolve(jsonResponse({ slots: [slot()] })),
    );

    await get_availability.execute(
      { date, reasonForVisit: "cataract evaluation" },
      toolOptions(state),
    );
    await route_to_spring_hill.execute({}, toolOptions(state));
    await get_availability.execute(
      { date, reasonForVisit: "cataract evaluation" },
      toolOptions(state),
    );

    expect(fetchMock()).toHaveBeenCalledTimes(2);
    expect(requestBodies().map((body) => body.office)).toEqual([
      CRYSTAL_RIVER_OFFICE_PHONE,
      SPRING_HILL_OFFICE_PHONE,
    ]);
    expect(state.effectiveOfficeKey).toBe("spring-hill");
  });

  it("rejects booking a slot that was not in the latest availability result", async () => {
    const state = verifiedState({
      lastAvailabilityRaw: { slots: [slot({ columnId: 10 })] },
    });

    const result = await book_appt.execute(
      slot({ columnId: 999 }),
      toolOptions(state),
    );

    expect(result).toContain("not in the latest availability results");
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it("blocks duplicate booking of the same slot during one call", async () => {
    const selectedSlot = slot();
    const state = verifiedState({
      lastAvailabilityRaw: { slots: [selectedSlot] },
    });
    fetchMock().mockImplementation(() =>
      Promise.resolve(jsonResponse({ status: "booked" })),
    );

    const first = await book_appt.execute(selectedSlot, toolOptions(state));
    const second = await book_appt.execute(selectedSlot, toolOptions(state));

    expect(first).toEqual({ status: "booked" });
    expect(second).toContain("already booked");
    expect(fetchMock()).toHaveBeenCalledTimes(1);
  });

  it("persists confirmed appointments and rejects unknown cancellation ids", async () => {
    const state = verifiedState();
    fetchMock().mockImplementation(() =>
      Promise.resolve(jsonResponse([appointment()])),
    );

    await confirm_appt.execute({}, toolOptions(state));
    const result = await cancel_appt.execute(
      { appointmentId: 999 },
      toolOptions(state),
    );

    expect(state.appointments).toHaveLength(1);
    expect(result).toContain("not loaded");
    expect(fetchMock()).toHaveBeenCalledTimes(1);
  });

  it("rejects cancellation of past appointments loaded from caller context", async () => {
    const state = verifiedState({
      appointments: [appointment({ date: pastIsoDate() })],
      appointmentsSource: "phone_lookup",
    });

    const result = await cancel_appt.execute(
      { appointmentId: 456 },
      toolOptions(state),
    );

    expect(result).toContain("in the past");
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it("removes appointments from state only after cancellation succeeds", async () => {
    const state = verifiedState({
      appointments: [appointment()],
      appointmentsSource: "confirm_appt",
    });
    fetchMock().mockImplementation(() =>
      Promise.resolve(jsonResponse({ status: "cancelled" })),
    );

    const result = await cancel_appt.execute(
      { appointmentId: 456 },
      toolOptions(state),
    );

    expect(result).toEqual({ status: "cancelled" });
    expect(state.appointments).toEqual([]);
  });

  it("uses Spring Hill knowledge after a Crystal River call is routed", async () => {
    const state = verifiedState({}, CRYSTAL_RIVER_OFFICE_PHONE);

    await route_to_spring_hill.execute({}, toolOptions(state));
    const result = await lookup_knowledge.execute(
      { question: "what are your hours?" },
      toolOptions(state),
    );

    expect(result).toContain("Knowledge Base: Abita Eye Group, Spring Hill");
    expect(result).not.toContain(
      "Knowledge Base: Eye Radiance powered by Abeeta Eye Group",
    );
  });
});
