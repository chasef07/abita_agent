import { describe, expect, it, vi } from "vitest";
import type { AvailabilityResult } from "../scheduling/middleware.js";
import { createSchedulingTools } from "../scheduling/tools.js";
import { InMemorySchedulingMiddleware } from "../scheduling/testing.js";
import type {
  SchedulingAppointmentLane,
  StoredAvailabilitySlot,
} from "../state/call-state.js";
import { createTestCallState } from "./support/call-state.js";

function createState() {
  const state = createTestCallState({
    patientId: "patient-1",
    patientName: "Jane Doe",
    dob: "01/01/1980",
    insuranceCarrier: "self pay",
    checkedInsurancePlan: "self pay",
    checkedInsuranceCoverageType: "medical",
    routing: "all_three",
    lastAvailabilityRouting: "all_three",
  });
  state.identity.patient.identityConfirmed = true;
  return state;
}

function createToolContext(state: ReturnType<typeof createState>) {
  const speechHandle = { allowInterruptions: true };
  return {
    session: { userData: state },
    speechHandle,
    disallowInterruptions: vi.fn(() => {
      speechHandle.allowInterruptions = false;
    }),
  };
}

function fixedClock(instant: string) {
  return { now: () => new Date(instant) };
}

function noAvailability(date: string): AvailabilityResult {
  return {
    status: "none",
    requestedDate: date,
    searchedFrom: date,
    searchedThrough: date,
    dateShifted: false,
    shouldRetrySameSearch: false,
    slots: [],
  };
}

function foundAvailability(
  date: string,
  slots: Array<{ time: string; bookingToken?: string }>,
): AvailabilityResult {
  return {
    status: "found",
    requestedDate: date,
    actualDate: date,
    searchedFrom: date,
    searchedThrough: date,
    dateShifted: false,
    shouldRetrySameSearch: false,
    slots: slots.map((slot, index) => ({
      provider: `Dr. Provider ${index + 1}`,
      date,
      time: slot.time,
      datetime: `${date}T${toTwentyFourHourTime(slot.time)}:00`,
      bookingToken: slot.bookingToken ?? `token-${index + 1}`,
    })),
  };
}

async function checkAvailability(input: {
  when: string;
  now?: string;
  appointmentLane?: SchedulingAppointmentLane;
  result?: AvailabilityResult;
}) {
  const state = createState();
  const middleware = new InMemorySchedulingMiddleware({
    availability: [input.result ?? noAvailability("2026-06-10")],
  });
  const { get_availability } = createSchedulingTools(
    middleware,
    fixedClock(input.now ?? "2026-06-09T14:42:00.000Z"),
  );
  const response = await get_availability.execute(
    {
      when: input.when,
      appointmentLane: input.appointmentLane ?? "medical_md",
    },
    {
      ctx: createToolContext(state) as never,
      toolCallId: "availability-1",
    } as never,
  );
  return { middleware, response, state };
}

describe("Scheduling Workflow temporal resolution", () => {
  it("uses the Eastern calendar date when UTC is already tomorrow", async () => {
    const { middleware } = await checkAvailability({
      when: "tomorrow",
      now: "2026-06-01T03:30:00.000Z",
      result: noAvailability("2026-06-01"),
    });

    expect(middleware.operations).toMatchObject([
      {
        kind: "availability",
        request: { date: "2026-06-01" },
      },
    ]);
  });

  it.each([
    ["tomorrow", "2026-06-10"],
    ["the day after tomorrow", "2026-06-11"],
    ["Wednesday", "2026-06-10"],
    ["Wed.", "2026-06-10"],
    ["this Wednesday", "2026-06-10"],
    ["next Tuesday", "2026-06-16"],
    ["next Wednesday", "2026-06-17"],
    ["the coming Friday", "2026-06-12"],
    ["Friday next week", "2026-06-19"],
    ["in two days", "2026-06-11"],
    ["in 2 weeks", "2026-06-23"],
    ["next week", "2026-06-14"],
    ["sometime next week", "2026-06-14"],
    ["la próxima semana", "2026-06-14"],
    ["this week", "2026-06-10"],
    ["esta semana", "2026-06-10"],
    ["today", "2026-06-09"],
    ["Tuesday", "2026-06-09"],
    ["this Tuesday", "2026-06-09"],
    ["hoy", "2026-06-09"],
    ["as soon as possible", "2026-06-09"],
    ["next available", "2026-06-09"],
    ["first available", "2026-06-09"],
    ["any day", "2026-06-09"],
    ["anytime", "2026-06-09"],
    ["sometime soon", "2026-06-09"],
    ["lo antes posible", "2026-06-09"],
    ["cualquier día", "2026-06-09"],
    ["día disponible", "2026-06-09"],
  ])("resolves %s to %s", async (when, expectedDate) => {
    const { middleware, state } = await checkAvailability({
      when,
      result: noAvailability(expectedDate),
    });

    expect(middleware.operations).toMatchObject([
      {
        kind: "availability",
        request: {
          date: expectedDate,
          dob: "01/01/1980",
          routing: "all_three",
        },
      },
    ]);
    expect(state.workflow.current).toEqual({
      intent: "schedule",
      appointmentLane: "medical_md",
    });
  });

  it.each([
    ["June 16", "2026-06-16"],
    ["June the 16th", "2026-06-16"],
    ["the 16th of June", "2026-06-16"],
    ["Wednesday, June 10", "2026-06-10"],
    ["June 1st", "2027-06-01"],
    ["June 16, 2027", "2027-06-16"],
    ["2026-06-16", "2026-06-16"],
  ])(
    "resolves named or canonical date %s to %s",
    async (when, expectedDate) => {
      const { middleware } = await checkAvailability({
        when,
        result: noAvailability(expectedDate),
      });

      expect(middleware.operations).toMatchObject([
        {
          kind: "availability",
          request: { date: expectedDate },
        },
      ]);
    },
  );

  it.each([
    {
      name: "year rollover",
      when: "January 2",
      now: "2026-12-31T15:00:00.000Z",
      expectedDate: "2027-01-02",
    },
    {
      name: "next valid leap day",
      when: "February 29",
      now: "2026-03-01T15:00:00.000Z",
      expectedDate: "2028-02-29",
    },
    {
      name: "spring daylight-saving boundary",
      when: "tomorrow",
      now: "2026-03-07T17:00:00.000Z",
      expectedDate: "2026-03-08",
    },
    {
      name: "fall daylight-saving boundary",
      when: "tomorrow",
      now: "2026-10-31T16:00:00.000Z",
      expectedDate: "2026-11-01",
    },
  ])("keeps calendar arithmetic stable across $name", async (input) => {
    const { middleware } = await checkAvailability({
      when: input.when,
      now: input.now,
      result: noAvailability(input.expectedDate),
    });

    expect(middleware.operations).toMatchObject([
      {
        kind: "availability",
        request: { date: input.expectedDate },
      },
    ]);
  });

  it.each(["this week", "esta semana"])(
    "does not let %s cross into next week on Saturday",
    async (when) => {
      const { middleware, response } = await checkAvailability({
        when,
        now: "2026-06-13T15:00:00.000Z",
      });

      expect(response).toContain("no future days left this week");
      expect(middleware.operations).toEqual([]);
    },
  );

  it("starts this-week availability on Monday when today is Sunday", async () => {
    const { middleware } = await checkAvailability({
      when: "this week",
      now: "2026-06-14T15:00:00.000Z",
      result: noAvailability("2026-06-15"),
    });

    expect(middleware.operations).toMatchObject([
      {
        kind: "availability",
        request: { date: "2026-06-15" },
      },
    ]);
  });

  it.each([
    ["this Monday", "has already passed"],
    ["2026-06-08", "has already passed"],
    ["02/03/2027", "numeric date is ambiguous"],
    ["February 30", "calendar date is not valid"],
    ["February 29 2027", "calendar date is not valid"],
    ["Thursday, June 10", "weekday does not match"],
    ["the following Friday", "weekday phrase is ambiguous"],
    ["el próximo martes", "weekday phrase is ambiguous"],
    ["tomorrow at 3", "AM or PM"],
    ["tomorrow after 3", "AM or PM"],
    ["mañana a las 3", "AM or PM"],
    ["tomorrow early morning", "specific clock time"],
    ["the week of June 15", "specific day of the week"],
    ["today or tomorrow", "one specific day"],
    ["hoy o mañana", "one specific day"],
    ["Friday or Monday", "one specific day"],
    ["jueves, 10 de junio", "weekday does not match"],
  ])("fails closed for %s", async (when, expectedMessage) => {
    const state = createState();
    state.availability.slots = [storedSlot()];
    state.availability.bookingTokensBySlotId = { S1: "stale-token" };
    const middleware = new InMemorySchedulingMiddleware();
    const { get_availability } = createSchedulingTools(
      middleware,
      fixedClock("2026-06-09T14:42:00.000Z"),
    );

    const response = await get_availability.execute(
      { when, appointmentLane: "medical_md" },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "availability-1",
      } as never,
    );

    expect(response).toContain(expectedMessage);
    expect(middleware.operations).toEqual([]);
    expect(state.availability.slots).toEqual([]);
    expect(state.availability.bookingTokensBySlotId).toEqual({});
  });

  it.each([
    {
      when: "tomorrow morning",
      expected: ["9:00 AM", "11:30 AM"],
      omitted: "2:00 PM",
    },
    {
      when: "morning",
      expected: ["9:00 AM", "11:30 AM"],
      omitted: "2:00 PM",
    },
    {
      when: "tomorrow afternoon",
      expected: ["12:00 PM", "2:00 PM"],
      omitted: "11:30 AM",
    },
    {
      when: "tomorrow at 3 PM",
      expected: ["3:00 PM"],
      omitted: "3:30 PM",
    },
    {
      when: "at 3 PM",
      expected: ["3:00 PM"],
      omitted: "3:30 PM",
    },
    {
      when: "tomorrow at 3 in the afternoon",
      expected: ["3:00 PM"],
      omitted: "3:30 PM",
    },
    {
      when: "tomorrow at 9 in the morning",
      expected: ["9:00 AM"],
      omitted: "11:30 AM",
    },
    {
      when: "tomorrow around 3 PM",
      expected: ["3:00 PM", "3:30 PM"],
      omitted: "2:00 PM",
    },
    {
      when: "tomorrow about 3 PM",
      expected: ["3:00 PM", "3:30 PM"],
      omitted: "2:00 PM",
    },
    {
      when: "tomorrow before 3 PM",
      expected: ["9:00 AM", "11:30 AM"],
      omitted: "3:00 PM",
    },
    {
      when: "tomorrow after 3 PM",
      expected: ["3:30 PM", "4:30 PM"],
      omitted: "3:00 PM",
    },
    {
      when: "tomorrow at noon",
      expected: ["12:00 PM"],
      omitted: "11:30 AM",
    },
    {
      when: "tomorrow any time",
      expected: ["9:00 AM", "12:00 PM"],
      omitted: "5:00 PM",
    },
    {
      when: "next available in the afternoon",
      expected: ["12:00 PM", "2:00 PM"],
      omitted: "11:30 AM",
    },
  ])("applies the provider-slot constraint in $when", async (input) => {
    const date = "2026-06-10";
    const { response, state } = await checkAvailability({
      when: input.when,
      result: foundAvailability(date, [
        { time: "9:00 AM" },
        { time: "11:30 AM" },
        { time: "12:00 PM" },
        { time: "2:00 PM" },
        { time: "3:00 PM" },
        { time: "3:30 PM" },
        { time: "4:30 PM" },
      ]),
    });

    expect(state.availability.slots.map((slot) => slot.time)).toEqual(
      input.expected,
    );
    expect(response).not.toContain(input.omitted);
  });

  it.each([
    ["mañana", "2026-06-10"],
    ["miércoles", "2026-06-10"],
    ["este miércoles", "2026-06-10"],
    ["el 16 de junio", "2026-06-16"],
    ["el primero de julio", "2026-07-01"],
    ["16 de junio de 2027", "2027-06-16"],
    ["16 de junio del 2027", "2027-06-16"],
    ["miércoles, 10 de junio", "2026-06-10"],
  ])(
    "resolves observed Spanish phrase %s to %s",
    async (when, expectedDate) => {
      const { middleware } = await checkAvailability({
        when,
        result: noAvailability(expectedDate),
      });

      expect(middleware.operations).toMatchObject([
        {
          kind: "availability",
          request: { date: expectedDate },
        },
      ]);
    },
  );

  it.each([
    {
      when: "mañana por la mañana",
      expected: ["9:00 AM", "11:30 AM"],
      omitted: "2:00 PM",
    },
    {
      when: "por la mañana",
      expected: ["9:00 AM", "11:30 AM"],
      omitted: "2:00 PM",
    },
    {
      when: "mañana por la tarde",
      expected: ["2:00 PM", "3:00 PM"],
      omitted: "11:30 AM",
    },
    {
      when: "mañana a las 3 de la tarde",
      expected: ["3:00 PM"],
      omitted: "3:30 PM",
    },
  ])("applies the observed Spanish time constraint in $when", async (input) => {
    const { response, state } = await checkAvailability({
      when: input.when,
      result: foundAvailability("2026-06-10", [
        { time: "9:00 AM" },
        { time: "11:30 AM" },
        { time: "2:00 PM" },
        { time: "3:00 PM" },
        { time: "3:30 PM" },
      ]),
    });

    expect(state.availability.slots.map((slot) => slot.time)).toEqual(
      input.expected,
    );
    expect(response).not.toContain(input.omitted);
  });

  it("reports when no returned slot matches instead of inventing one", async () => {
    const { response, state } = await checkAvailability({
      when: "tomorrow at 5 PM",
      result: foundAvailability("2026-06-10", [
        { time: "9:00 AM" },
        { time: "3:00 PM" },
      ]),
    });

    expect(response).toBe(
      "No returned openings matched the requested time of 5:00 PM. Ask whether the caller wants a different time or day.",
    );
    expect(state.availability.slots).toEqual([]);
    expect(state.availability.bookingTokensBySlotId).toEqual({});
  });

  it("offers the provider's first future slot for a vague request", async () => {
    const { middleware, response, state } = await checkAvailability({
      when: "next available",
      result: {
        ...foundAvailability("2026-06-18", [{ time: "3:00 PM" }]),
        requestedDate: "2026-06-09",
        searchedFrom: "2026-06-09",
        searchedThrough: "2026-06-18",
        dateShifted: true,
      },
    });

    expect(middleware.operations).toMatchObject([
      {
        kind: "availability",
        request: { date: "2026-06-09" },
      },
    ]);
    expect(state.availability.slots).toMatchObject([
      { date: "2026-06-18", time: "3:00 PM" },
    ]);
    expect(response).toContain("Offer this slot: June 18 at 3:00 PM");
    expect(response).not.toContain("No opening was found on");
  });

  it("explains a provider shift from a specific requested date", async () => {
    const { middleware, response, state } = await checkAvailability({
      when: "June 16",
      result: {
        ...foundAvailability("2026-06-18", [{ time: "3:00 PM" }]),
        requestedDate: "2026-06-16",
        searchedFrom: "2026-06-16",
        searchedThrough: "2026-06-18",
        dateShifted: true,
      },
    });

    expect(middleware.operations).toMatchObject([
      {
        kind: "availability",
        request: { date: "2026-06-16" },
      },
    ]);
    expect(state.availability.slots).toMatchObject([
      { date: "2026-06-18", time: "3:00 PM" },
    ]);
    expect(response).toContain(
      "No opening was found on June 16. Offer this slot: June 18 at 3:00 PM",
    );
  });

  it("offers the provider's Monday slot for a same-day Friday request", async () => {
    const { middleware, response, state } = await checkAvailability({
      when: "today",
      now: "2026-07-24T15:00:00.000Z",
      result: {
        ...foundAvailability("2026-07-27", [{ time: "3:00 PM" }]),
        requestedDate: "2026-07-24",
        searchedFrom: "2026-07-24",
        searchedThrough: "2026-07-27",
        dateShifted: true,
      },
    });

    expect(middleware.operations).toMatchObject([
      {
        kind: "availability",
        request: { date: "2026-07-24" },
      },
    ]);
    expect(state.availability.slots).toMatchObject([
      { date: "2026-07-27", time: "3:00 PM" },
    ]);
    expect(response).toContain("Offer this slot: July 27 at 3:00 PM");
    expect(response).not.toMatch(/tomorrow|Saturday|July 24|July 25/i);
  });

  it("starts a Friday next-available search without proposing Saturday", async () => {
    const { middleware, response, state } = await checkAvailability({
      when: "next available",
      now: "2026-07-24T15:00:00.000Z",
      result: {
        ...foundAvailability("2026-07-27", [{ time: "3:00 PM" }]),
        requestedDate: "2026-07-24",
        searchedFrom: "2026-07-24",
        searchedThrough: "2026-07-27",
        dateShifted: true,
      },
    });

    expect(middleware.operations).toMatchObject([
      {
        kind: "availability",
        request: { date: "2026-07-24" },
      },
    ]);
    expect(state.availability.slots).toMatchObject([
      { date: "2026-07-27", time: "3:00 PM" },
    ]);
    expect(response).toContain("Offer this slot: July 27 at 3:00 PM");
    expect(response).not.toMatch(/tomorrow|Saturday|July 24|July 25/i);
  });

  it("caches equivalent phrases by canonical date and constraint", async () => {
    const state = createState();
    const middleware = new InMemorySchedulingMiddleware({
      availability: [
        noAvailability("2026-06-10"),
        noAvailability("2026-06-09"),
      ],
    });
    const { get_availability } = createSchedulingTools(
      middleware,
      fixedClock("2026-06-09T14:42:00.000Z"),
    );
    const ctx = createToolContext(state);

    const first = await get_availability.execute(
      { when: "tomorrow", appointmentLane: "medical_md" },
      { ctx: ctx as never, toolCallId: "availability-1" } as never,
    );
    const second = await get_availability.execute(
      { when: "in one day", appointmentLane: "medical_md" },
      { ctx: ctx as never, toolCallId: "availability-2" } as never,
    );
    const third = await get_availability.execute(
      { when: "next available", appointmentLane: "medical_md" },
      { ctx: ctx as never, toolCallId: "availability-3" } as never,
    );
    const fourth = await get_availability.execute(
      { when: "as soon as possible", appointmentLane: "medical_md" },
      { ctx: ctx as never, toolCallId: "availability-4" } as never,
    );

    expect(second).toBe(first);
    expect(fourth).toBe(third);
    expect(middleware.operations).toHaveLength(2);
  });

  it("reranks different time constraints from one backend result", async () => {
    const state = createState();
    const middleware = new InMemorySchedulingMiddleware({
      availability: [
        foundAvailability("2026-06-10", [
          { time: "9:00 AM" },
          { time: "2:00 PM" },
        ]),
      ],
    });
    const { get_availability } = createSchedulingTools(
      middleware,
      fixedClock("2026-06-09T14:42:00.000Z"),
    );
    const ctx = createToolContext(state);

    const morning = await get_availability.execute(
      { when: "tomorrow morning", appointmentLane: "medical_md" },
      { ctx: ctx as never, toolCallId: "availability-1" } as never,
    );
    const afternoon = await get_availability.execute(
      { when: "tomorrow afternoon", appointmentLane: "medical_md" },
      { ctx: ctx as never, toolCallId: "availability-2" } as never,
    );

    expect(morning).toContain("June 10 at 9:00 AM");
    expect(afternoon).toContain("June 10 at 2:00 PM");
    expect(middleware.operations).toHaveLength(1);
  });

  it("books through the opaque reference returned after phrase resolution", async () => {
    const state = createState();
    const middleware = new InMemorySchedulingMiddleware({
      availability: [
        foundAvailability("2026-06-10", [
          { time: "3:00 PM", bookingToken: "private-token" },
        ]),
      ],
      bookings: [
        {
          status: "booked",
          appointmentId: 456,
          providerName: "Dr. Provider 1",
          locationName: "Spring Hill",
          appointmentTypeName: "Medical",
        },
      ],
    });
    const { book_appointment, get_availability } = createSchedulingTools(
      middleware,
      fixedClock("2026-06-09T14:42:00.000Z"),
    );
    const ctx = createToolContext(state);

    await get_availability.execute(
      { when: "tomorrow at 3 PM", appointmentLane: "medical_md" },
      { ctx: ctx as never, toolCallId: "availability-1" } as never,
    );
    const booking = await book_appointment.execute(
      {
        appointmentSlotRef: "S1",
        appointmentReason: "routine follow-up",
        referringDoctor: "none",
        readBack: true,
      },
      { ctx: ctx as never, toolCallId: "booking-1" } as never,
    );

    expect(booking).toContain("Booked June 10 at 3:00 PM");
    expect(middleware.operations).toMatchObject([
      { kind: "availability", request: { date: "2026-06-10" } },
      {
        kind: "book",
        request: {
          bookingToken: "private-token",
          patientId: "patient-1",
        },
      },
    ]);
  });
});

function storedSlot(): StoredAvailabilitySlot {
  return {
    slotId: "S1",
    spoken: "June 10 at 9:00 AM",
    provider: "Dr. Provider",
    date: "2026-06-10",
    time: "9:00 AM",
    datetime: "2026-06-10T09:00:00",
    routing: "all_three",
  };
}

function toTwentyFourHourTime(time: string): string {
  const match = time.match(/^(\d{1,2}):(\d{2})\s+(AM|PM)$/);
  if (!match) throw new Error(`Unexpected test time: ${time}`);
  let hour = Number(match[1]);
  if (match[3] === "PM" && hour !== 12) hour += 12;
  if (match[3] === "AM" && hour === 12) hour = 0;
  return `${String(hour).padStart(2, "0")}:${match[2]}`;
}
