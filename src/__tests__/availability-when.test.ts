import { describe, expect, it } from "vitest";
import type { AvailabilityResult } from "../scheduling/middleware.js";
import { createSchedulingTools } from "../scheduling/tools.js";
import { createConfirmedPatientState } from "./support/call-state.js";
import { InMemorySchedulingMiddleware } from "./support/scheduling-middleware.js";
import { createToolContext } from "./support/tool-context.js";

function createState() {
  return createConfirmedPatientState();
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
  visitType?: "medical" | "routine_vision";
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
      visitType: input.visitType ?? "medical",
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
          requestedDate: "2026-06-01",
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
          requestedDate: "2026-06-16",
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

    expect(middleware.operations[0]).toHaveProperty(
      "request.requestedDate",
      date,
    );
    expect(middleware.operations[0]).not.toHaveProperty(
      "request.preferredTime",
    );
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
          requestedDate: "2026-06-16",
          preferredTime: { minuteOfDay: 900 },
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
      { when: "next Tuesday at 3", visitType: "medical" },
      { ctx: ctx as never, toolCallId: "availability-1" } as never,
    );
    const response = await get_availability.execute(
      {
        when: "how about 10 for that day",
        visitType: "medical",
      },
      { ctx: ctx as never, toolCallId: "availability-2" } as never,
    );

    expect(middleware.operations[1]).toMatchObject({
      kind: "availability",
      request: {
        requestedDate: "2026-06-16",
        preferredTime: { minuteOfDay: 600 },
      },
    });
    expect(response).toContain("June 16 at 10:00 AM");
  });

  it("keeps the searched date after no availability when the caller says that day", async () => {
    const state = createState();
    const middleware = new InMemorySchedulingMiddleware({
      availability: [
        noAvailability("2026-06-16"),
        foundAvailability("2026-06-16", [{ time: "10:00 AM" }]),
      ],
    });
    const { get_availability } = createSchedulingTools(
      middleware,
      fixedClock("2026-06-09T14:42:00.000Z"),
    );
    const ctx = createToolContext(state);

    await get_availability.execute(
      { when: "next Tuesday", visitType: "medical" },
      { ctx: ctx as never, toolCallId: "availability-1" } as never,
    );
    await get_availability.execute(
      { when: "how about 10 for that day", visitType: "medical" },
      { ctx: ctx as never, toolCallId: "availability-2" } as never,
    );

    expect(middleware.operations[1]).toMatchObject({
      kind: "availability",
      request: {
        requestedDate: "2026-06-16",
        preferredTime: { minuteOfDay: 600 },
      },
    });
  });

  it("uses the offered date when availability shifts beyond the search start", async () => {
    const state = createState();
    const middleware = new InMemorySchedulingMiddleware({
      availability: [
        {
          ...foundAvailability("2026-06-15", [{ time: "3:00 PM" }]),
          requestedDate: "2026-06-10",
          searchedFrom: "2026-06-10",
          dateShifted: true,
        },
        foundAvailability("2026-06-15", [{ time: "10:00 AM" }]),
      ],
    });
    const { get_availability } = createSchedulingTools(
      middleware,
      fixedClock("2026-06-09T14:42:00.000Z"),
    );
    const ctx = createToolContext(state);

    await get_availability.execute(
      { when: "whenever you can get me in", visitType: "medical" },
      { ctx: ctx as never, toolCallId: "availability-1" } as never,
    );
    await get_availability.execute(
      { when: "how about 10 for that day", visitType: "medical" },
      { ctx: ctx as never, toolCallId: "availability-2" } as never,
    );

    expect(middleware.operations[1]).toMatchObject({
      kind: "availability",
      request: {
        requestedDate: "2026-06-15",
        preferredTime: { minuteOfDay: 600 },
      },
    });
  });

  it("does not reuse a stale offered date after a newer failed search", async () => {
    const state = createState();
    const middleware = new InMemorySchedulingMiddleware({
      availability: [
        foundAvailability("2026-06-16", [{ time: "3:00 PM" }]),
        { status: "error", reason: "network_error" },
        foundAvailability("2026-06-18", [{ time: "10:00 AM" }]),
      ],
    });
    const { get_availability } = createSchedulingTools(
      middleware,
      fixedClock("2026-06-09T14:42:00.000Z"),
    );
    const ctx = createToolContext(state);

    await get_availability.execute(
      { when: "next Tuesday", visitType: "medical" },
      { ctx: ctx as never, toolCallId: "availability-1" } as never,
    );
    await get_availability.execute({ when: "June 18", visitType: "medical" }, {
      ctx: ctx as never,
      toolCallId: "availability-2",
    } as never);
    await get_availability.execute(
      { when: "how about 10 for that day", visitType: "medical" },
      { ctx: ctx as never, toolCallId: "availability-3" } as never,
    );

    expect(middleware.operations[2]).toMatchObject({
      kind: "availability",
      request: {
        requestedDate: "2026-06-18",
        preferredTime: { minuteOfDay: 600 },
      },
    });
  });

  it("uses the first option as that day after an or phrase", async () => {
    const state = createState();
    const middleware = new InMemorySchedulingMiddleware({
      availability: [
        noAvailability("2026-06-15"),
        noAvailability("2026-06-15"),
      ],
    });
    const { get_availability } = createSchedulingTools(
      middleware,
      fixedClock("2026-06-09T14:42:00.000Z"),
    );
    const ctx = createToolContext(state);

    await get_availability.execute(
      { when: "Monday or Thursday", visitType: "medical" },
      { ctx: ctx as never, toolCallId: "availability-1" } as never,
    );
    await get_availability.execute(
      { when: "how about 10 for that day", visitType: "medical" },
      { ctx: ctx as never, toolCallId: "availability-2" } as never,
    );

    expect(middleware.operations[1]).toMatchObject({
      kind: "availability",
      request: {
        requestedDate: "2026-06-15",
        preferredTime: { minuteOfDay: 600 },
      },
    });
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
      { when: "next Tuesday at 3", visitType: "medical" },
      { ctx: ctx as never, toolCallId: "availability-1" } as never,
    );
    await get_availability.execute(
      { when: "next available in the morning", visitType: "medical" },
      { ctx: ctx as never, toolCallId: "availability-2" } as never,
    );

    expect(middleware.operations[1]).toMatchObject({
      kind: "availability",
      request: {
        preferredTime: { kind: "morning" },
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
          dob: "01/01/1980",
          routing: "all_three",
        },
      },
    ]);
    expect(middleware.operations[0]).not.toHaveProperty(
      "request.requestedDate",
    );
    expect(middleware.operations[0]).not.toHaveProperty(
      "request.preferredTime",
    );
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
          preferredTime: { kind: "afternoon" },
        },
      },
    ]);
  });

  it("uses the first parsed option in an or phrase", async () => {
    const { middleware } = await checkAvailability({
      when: "Monday or Thursday afternoon",
      result: noAvailability("2026-06-15"),
    });

    expect(middleware.operations).toMatchObject([
      {
        kind: "availability",
        request: {
          requestedDate: "2026-06-15",
        },
      },
    ]);
  });

  it("keeps the date and time from the first parsed option", async () => {
    const { middleware } = await checkAvailability({
      when: "Monday at 3 PM or Thursday morning",
      result: noAvailability("2026-06-15"),
    });

    expect(middleware.operations).toMatchObject([
      {
        kind: "availability",
        request: {
          requestedDate: "2026-06-15",
          preferredTime: { minuteOfDay: 900 },
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
          requestedDate: "2026-06-16",
          preferredTime: { minuteOfDay: 900 },
        },
      },
    ]);
  });

  it("uses only the first parsed clock option", async () => {
    const { middleware } = await checkAvailability({
      when: "Monday before 3 PM or Thursday after 4 PM",
      result: noAvailability("2026-06-15"),
    });

    expect(middleware.operations[0]).toMatchObject({
      request: {
        requestedDate: "2026-06-15",
        preferredTime: { minuteOfDay: 900 },
      },
    });
  });

  it("uses the first daypart in an or phrase", async () => {
    const { middleware } = await checkAvailability({
      when: "Tuesday morning or afternoon",
      result: noAvailability("2026-06-16"),
    });

    expect(middleware.operations[0]).toMatchObject({
      request: {
        requestedDate: "2026-06-16",
        preferredTime: { kind: "morning" },
      },
    });
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

      expect(middleware.operations[0]).toMatchObject({
        request: {
          requestedDate: date,
          preferredTime: { minuteOfDay: 900 },
        },
      });
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
          requestedDate: "2026-06-10",
          preferredTime: { minuteOfDay: 900 },
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
      { when: "tomorrow at 3 PM", visitType: "medical" },
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
          requestedDate: "2026-06-10",
          preferredTime: { minuteOfDay: 900 },
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
