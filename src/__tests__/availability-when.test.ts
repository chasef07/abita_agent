import { describe, expect, it, vi } from "vitest";
import type { AvailabilityResult } from "../scheduling/middleware.js";
import { createSchedulingTools } from "../scheduling/tools.js";
import { InMemorySchedulingMiddleware } from "../scheduling/testing.js";
import type { SchedulingAppointmentLane } from "../state/call-state.js";
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
    bookingTokenExpiresAt: "2027-01-01T00:00:00Z",
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

describe("Scheduling Workflow caller-language availability", () => {
  it("uses tomorrow in the clinic timezone when UTC is already tomorrow", async () => {
    const { middleware } = await checkAvailability({
      when: "tomorrow",
      now: "2026-06-01T03:30:00.000Z",
      result: noAvailability("2026-06-01"),
    });

    expect(middleware.operations).toMatchObject([
      {
        kind: "availability",
        request: {
          date: "2026-06-01",
          preferences: [{ date: "2026-06-01" }],
        },
      },
    ]);
  });

  it("prefers the future occurrence of an unqualified weekday", async () => {
    const { middleware } = await checkAvailability({
      when: "Tuesday",
      result: noAvailability("2026-06-16"),
    });

    expect(middleware.operations).toMatchObject([
      {
        kind: "availability",
        request: {
          date: "2026-06-16",
          preferences: [{ date: "2026-06-16" }],
        },
      },
    ]);
  });

  it.each([
    ["try June 16", "2026-06-16"],
    ["how about July 2", "2026-07-02"],
  ])("does not invent a clock from a date in %s", async (when, date) => {
    const { middleware } = await checkAvailability({
      when,
      result: noAvailability(date),
    });

    expect(middleware.operations[0]).toHaveProperty("request.preferences", [
      { date },
    ]);
  });

  it("uses real clinic inventory to resolve an omitted meridiem", async () => {
    const { middleware, response } = await checkAvailability({
      when: "next Tuesday at 3",
      result: foundAvailability("2026-06-16", [{ time: "3:00 PM" }]),
    });

    expect(middleware.operations).toMatchObject([
      {
        kind: "availability",
        request: {
          date: "2026-06-16",
          preferences: [
            {
              date: "2026-06-16",
              time: {
                minuteOfDay: 900,
              },
            },
          ],
        },
      },
    ]);
    expect(response).toContain("June 16 at 3:00 PM");
    expect(response).not.toContain("AM or PM");
  });

  it("keeps the prior date when the caller says how about 10 for that day", async () => {
    const state = createState();
    const middleware = new InMemorySchedulingMiddleware({
      availability: [
        foundAvailability("2026-06-16", [{ time: "3:00 PM" }]),
        foundAvailability("2026-06-16", [{ time: "10:00 AM" }]),
      ],
    });
    const { get_availability } = createSchedulingTools(
      middleware,
      fixedClock("2026-06-09T14:42:00.000Z"),
    );
    const ctx = createToolContext(state);

    await get_availability.execute(
      { when: "next Tuesday at 3", appointmentLane: "medical_md" },
      { ctx: ctx as never, toolCallId: "availability-1" } as never,
    );
    const response = await get_availability.execute(
      {
        when: "how about 10 for that day",
        appointmentLane: "medical_md",
      },
      { ctx: ctx as never, toolCallId: "availability-2" } as never,
    );

    expect(middleware.operations[1]).toMatchObject({
      kind: "availability",
      request: {
        date: "2026-06-16",
        preferences: [
          {
            date: "2026-06-16",
            time: { minuteOfDay: 600 },
          },
        ],
      },
    });
    expect(response).toContain("June 16 at 10:00 AM");
  });

  it("does not reuse a prior date without a same-day reference", async () => {
    const state = createState();
    const middleware = new InMemorySchedulingMiddleware({
      availability: [
        foundAvailability("2026-06-16", [{ time: "3:00 PM" }]),
        foundAvailability("2026-06-10", [{ time: "9:00 AM" }]),
      ],
    });
    const { get_availability } = createSchedulingTools(
      middleware,
      fixedClock("2026-06-09T14:42:00.000Z"),
    );
    const ctx = createToolContext(state);

    await get_availability.execute(
      { when: "next Tuesday at 3", appointmentLane: "medical_md" },
      { ctx: ctx as never, toolCallId: "availability-1" } as never,
    );
    await get_availability.execute(
      { when: "next available in the morning", appointmentLane: "medical_md" },
      { ctx: ctx as never, toolCallId: "availability-2" } as never,
    );

    expect(middleware.operations[1]).toMatchObject({
      kind: "availability",
      request: {
        date: "2026-06-10",
        preferences: [{ time: { kind: "morning" } }],
      },
    });
  });

  it("searches broadly from tomorrow when the phrase is vague", async () => {
    const { middleware, response } = await checkAvailability({
      when: "whenever you can get me in",
      result: foundAvailability("2026-06-10", [{ time: "9:00 AM" }]),
    });

    expect(middleware.operations).toMatchObject([
      {
        kind: "availability",
        request: {
          date: "2026-06-10",
          dob: "01/01/1980",
          routing: "all_three",
        },
      },
    ]);
    expect(middleware.operations[0]).not.toHaveProperty("request.preferences");
    expect(response).toContain("June 10 at 9:00 AM");
  });

  it("forwards a time-only daypart as a soft preference", async () => {
    const { middleware } = await checkAvailability({
      when: "in the afternoon",
    });

    expect(middleware.operations).toMatchObject([
      {
        kind: "availability",
        request: {
          date: "2026-06-10",
          preferences: [{ time: { kind: "afternoon" } }],
        },
      },
    ]);
  });

  it("represents multiple date alternatives without asking a follow-up", async () => {
    const { middleware } = await checkAvailability({
      when: "Monday or Thursday afternoon",
      result: noAvailability("2026-06-11"),
    });

    expect(middleware.operations).toMatchObject([
      {
        kind: "availability",
        request: {
          date: "2026-06-11",
          preferences: [
            { date: "2026-06-15" },
            {
              date: "2026-06-11",
              time: { kind: "afternoon" },
            },
          ],
        },
      },
    ]);
    expect(middleware.operations[0]).toHaveProperty("request.preferences", [
      { date: "2026-06-15" },
      {
        date: "2026-06-11",
        time: { kind: "afternoon" },
      },
    ]);
  });

  it("preserves the date and time pairing of each alternative", async () => {
    const { middleware } = await checkAvailability({
      when: "Monday at 3 PM or Thursday morning",
      result: noAvailability("2026-06-11"),
    });

    expect(middleware.operations).toMatchObject([
      {
        kind: "availability",
        request: {
          date: "2026-06-11",
          preferences: [
            {
              date: "2026-06-15",
              time: { minuteOfDay: 900 },
            },
            {
              date: "2026-06-11",
              time: { kind: "morning" },
            },
          ],
        },
      },
    ]);
  });

  it.each([
    "next Tuesday around 3 PM",
    "next Tuesday before 3 PM",
    "next Tuesday after 3 PM",
  ])("uses Chrono's parsed clock in %s", async (when) => {
    const { middleware } = await checkAvailability({
      when,
      result: noAvailability("2026-06-16"),
    });

    expect(middleware.operations).toMatchObject([
      {
        kind: "availability",
        request: {
          date: "2026-06-16",
          preferences: [
            {
              date: "2026-06-16",
              time: { minuteOfDay: 900 },
            },
          ],
        },
      },
    ]);
  });

  it("preserves the parsed clock of each alternative", async () => {
    const { middleware } = await checkAvailability({
      when: "Monday before 3 PM or Thursday after 4 PM",
      result: noAvailability("2026-06-11"),
    });

    expect(middleware.operations[0]).toHaveProperty("request.preferences", [
      {
        date: "2026-06-15",
        time: { minuteOfDay: 900 },
      },
      {
        date: "2026-06-11",
        time: { minuteOfDay: 960 },
      },
    ]);
  });

  it("keeps a preceding date on a later daypart alternative", async () => {
    const { middleware } = await checkAvailability({
      when: "Tuesday morning or afternoon",
      result: noAvailability("2026-06-16"),
    });

    expect(middleware.operations[0]).toHaveProperty("request.preferences", [
      {
        date: "2026-06-16",
        time: { kind: "morning" },
      },
      {
        date: "2026-06-16",
        time: { kind: "afternoon" },
      },
    ]);
  });

  it.each([
    ["next Tuesday around 3", "2026-06-16"],
    ["next Tuesday before 3", "2026-06-16"],
    ["tomorrow after 3", "2026-06-10"],
  ] as const)(
    "sends an unparsed trailing clock back through Chrono in %s",
    async (when, date) => {
      const { middleware } = await checkAvailability({
        when,
        result: noAvailability(date),
      });

      expect(middleware.operations[0]).toHaveProperty("request.preferences", [
        {
          date,
          time: { minuteOfDay: 900 },
        },
      ]);
    },
  );

  it("parses Spanish caller language through the same boundary", async () => {
    const { middleware } = await checkAvailability({
      when: "mañana a las 3",
    });

    expect(middleware.operations).toMatchObject([
      {
        kind: "availability",
        request: {
          date: "2026-06-10",
          preferences: [
            {
              date: "2026-06-10",
              time: {
                minuteOfDay: 900,
              },
            },
          ],
        },
      },
    ]);
  });

  it("offers the middleware-ranked real slots in returned order", async () => {
    const { response, state } = await checkAvailability({
      when: "tomorrow around 3 PM",
      result: foundAvailability("2026-06-10", [
        { time: "3:00 PM" },
        { time: "2:30 PM" },
        { time: "9:00 AM" },
      ]),
    });

    expect(response.indexOf("3:00 PM")).toBeLessThan(
      response.indexOf("2:30 PM"),
    );
    expect(response).not.toContain("9:00 AM");
    expect(state.availability.slots.map((slot) => slot.time)).toEqual([
      "3:00 PM",
      "2:30 PM",
    ]);
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

    expect(booking).toContain("Booked Wednesday, June 10 at 3:00 PM");
    expect(middleware.operations).toMatchObject([
      {
        kind: "availability",
        request: {
          date: "2026-06-10",
          preferences: [
            {
              date: "2026-06-10",
              time: { minuteOfDay: 900 },
            },
          ],
        },
      },
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

function toTwentyFourHourTime(time: string): string {
  const [clock, meridiem] = time.split(" ");
  const [hourText, minute = "00"] = (clock ?? "").split(":");
  let hour = Number(hourText);
  if (meridiem === "PM" && hour !== 12) hour += 12;
  if (meridiem === "AM" && hour === 12) hour = 0;
  return `${String(hour).padStart(2, "0")}:${minute}`;
}
