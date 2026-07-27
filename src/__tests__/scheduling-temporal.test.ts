import { describe, expect, it, vi } from "vitest";
import type { AvailabilityResult } from "../scheduling/middleware.js";
import type { AvailabilityPreferenceInput } from "../scheduling/temporal.js";
import { createSchedulingTools } from "../scheduling/tools.js";
import { InMemorySchedulingMiddleware } from "../scheduling/testing.js";
import { availabilityReadEvents } from "../state/observability.js";
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

function noAvailability(
  date: string,
  overrides: Partial<Exclude<AvailabilityResult, { status: "error" }>> = {},
): AvailabilityResult {
  return {
    status: "none",
    requestedDate: date,
    searchedFrom: date,
    searchedThrough: date,
    dateShifted: false,
    shouldRetrySameSearch: false,
    slots: [],
    ...overrides,
  };
}

function foundAvailability(
  slots: Array<{
    date?: string;
    time: string;
    bookingToken?: string;
    preferenceMatch?: "exact" | "fallback";
    preferenceDifferences?: Array<"date" | "weekday" | "time">;
  }>,
  overrides: Partial<Exclude<AvailabilityResult, { status: "error" }>> = {},
): AvailabilityResult {
  const firstDate = slots[0]?.date ?? "2026-06-10";
  return {
    status: "found",
    requestedDate: firstDate,
    actualDate: firstDate,
    searchedFrom: firstDate,
    searchedThrough: slots.at(-1)?.date ?? firstDate,
    bookingTokenExpiresAt: "2027-01-01T00:00:00Z",
    dateShifted: false,
    shouldRetrySameSearch: false,
    slots: slots.map((slot, index) => {
      const date = slot.date ?? firstDate;
      return {
        provider: `Dr. Provider ${index + 1}`,
        date,
        time: slot.time,
        datetime: `${date}T${toTwentyFourHourTime(slot.time)}:00`,
        bookingToken: slot.bookingToken ?? `token-${index + 1}`,
        ...(slot.preferenceMatch
          ? { preferenceMatch: slot.preferenceMatch }
          : {}),
        ...(slot.preferenceDifferences
          ? { preferenceDifferences: slot.preferenceDifferences }
          : {}),
      };
    }),
    ...overrides,
  };
}

async function checkAvailability(input: {
  when?: AvailabilityPreferenceInput[];
  now?: string;
  appointmentLane?: SchedulingAppointmentLane;
  result?: AvailabilityResult;
}) {
  const state = createState();
  const middleware = new InMemorySchedulingMiddleware({
    availability: [input.result ?? noAvailability("2026-06-09")],
  });
  const { get_availability } = createSchedulingTools(
    middleware,
    fixedClock(input.now ?? "2026-06-09T14:42:00.000Z"),
  );
  const response = await get_availability.execute(
    {
      ...(input.when ? { when: input.when } : {}),
      appointmentLane: input.appointmentLane ?? "medical_md",
    },
    {
      ctx: createToolContext(state) as never,
      toolCallId: "availability-1",
    } as never,
  );
  return { middleware, response, state };
}

describe("Scheduling Workflow structured availability preferences", () => {
  it("searches compound weekday and time alternatives in one middleware request", async () => {
    const { middleware, response, state } = await checkAvailability({
      when: [
        {
          weekday: "monday",
          time: {
            kind: "after",
            hour: 1,
            minute: 30,
            meridiem: "pm",
          },
        },
        { weekday: "thursday", time: { kind: "any" } },
      ],
      result: foundAvailability([
        { date: "2026-06-11", time: "9:00 AM" },
        { date: "2026-06-15", time: "2:00 PM" },
      ]),
    });

    expect(middleware.operations).toMatchObject([
      {
        kind: "availability",
        request: {
          date: "2026-06-09",
          preferences: [
            {
              weekday: "monday",
              time: { kind: "after", minuteOfDay: 810 },
            },
            { weekday: "thursday" },
          ],
        },
      },
    ]);
    expect(state.availability.slots).toHaveLength(2);
    expect(response).toContain("Offer these options");
    expect(response).not.toMatch(/clarif|restate|ask for another day or time/i);
  });

  it.each([
    { name: "omitted", when: undefined },
    { name: "empty", when: [] },
    { name: "explicit any time", when: [{ time: { kind: "any" as const } }] },
  ])("treats $name preferences as earliest availability", async ({ when }) => {
    const { middleware } = await checkAvailability({ when });

    expect(middleware.operations).toMatchObject([
      {
        kind: "availability",
        request: {
          date: "2026-06-09",
          dob: "01/01/1980",
          routing: "all_three",
        },
      },
    ]);
    expect(middleware.operations[0]).not.toHaveProperty("request.preferences");
  });

  it("uses the clinic-local calendar for relative dates", async () => {
    const { middleware } = await checkAvailability({
      when: [{ date: { kind: "tomorrow" } }],
      now: "2026-06-01T03:30:00.000Z",
      result: noAvailability("2026-06-01"),
    });

    expect(middleware.operations).toMatchObject([
      {
        request: {
          date: "2026-06-01",
          preferences: [{ date: "2026-06-01" }],
        },
      },
    ]);
  });

  it.each([
    {
      name: "tomorrow",
      date: { kind: "tomorrow" as const },
      expected: "2026-06-10",
    },
    {
      name: "relative day",
      date: {
        kind: "relative" as const,
        value: 1,
        unit: "day" as const,
      },
      expected: "2026-06-10",
    },
    {
      name: "relative weeks",
      date: {
        kind: "relative" as const,
        value: 2,
        unit: "week" as const,
      },
      expected: "2026-06-23",
    },
    {
      name: "next week",
      date: { kind: "next_week" as const },
      expected: "2026-06-14",
    },
    {
      name: "calendar date",
      date: {
        kind: "calendar" as const,
        month: 6,
        day: 16,
      },
      expected: "2026-06-16",
    },
    {
      name: "next annual occurrence",
      date: {
        kind: "calendar" as const,
        month: 6,
        day: 1,
      },
      expected: "2027-06-01",
    },
  ])("canonicalizes a $name anchor", async ({ date, expected }) => {
    const { middleware } = await checkAvailability({
      when: [{ date }],
      result: noAvailability(expected),
    });

    expect(middleware.operations).toMatchObject([
      {
        request: {
          date: expected,
          preferences: [{ date: expected }],
        },
      },
    ]);
  });

  it("combines a next-week anchor and weekday in one canonical branch", async () => {
    const { middleware } = await checkAvailability({
      when: [{ date: { kind: "next_week" }, weekday: "thursday" }],
      result: noAvailability("2026-06-18"),
    });

    expect(middleware.operations).toMatchObject([
      {
        request: {
          date: "2026-06-18",
          preferences: [{ date: "2026-06-18", weekday: "thursday" }],
        },
      },
    ]);
  });

  it.each([
    {
      input: { kind: "morning" as const },
      expected: { kind: "morning" },
    },
    {
      input: { kind: "afternoon" as const },
      expected: { kind: "afternoon" },
    },
    ...(["exact", "around", "before", "after"] as const).map((kind) => ({
      input: {
        kind,
        hour: 1,
        minute: 30,
        meridiem: "pm" as const,
      },
      expected: { kind, minuteOfDay: 810 },
    })),
  ])("canonicalizes the $input.kind time preference", async (testCase) => {
    const { middleware } = await checkAvailability({
      when: [{ time: testCase.input }],
    });

    expect(middleware.operations).toMatchObject([
      {
        request: {
          date: "2026-06-09",
          preferences: [{ time: testCase.expected }],
        },
      },
    ]);
  });

  it("canonicalizes branch order and duplicate branches for request reuse", async () => {
    const state = createState();
    const middleware = new InMemorySchedulingMiddleware({
      availability: [noAvailability("2026-06-09")],
    });
    const { get_availability } = createSchedulingTools(
      middleware,
      fixedClock("2026-06-09T14:42:00.000Z"),
    );
    const ctx = createToolContext(state);

    const first = await get_availability.execute(
      {
        when: [
          { weekday: "thursday" },
          { weekday: "monday" },
          { weekday: "monday" },
        ],
        appointmentLane: "medical_md",
      },
      { ctx: ctx as never, toolCallId: "availability-1" } as never,
    );
    const second = await get_availability.execute(
      {
        when: [{ weekday: "monday" }, { weekday: "thursday" }],
        appointmentLane: "medical_md",
      },
      { ctx: ctx as never, toolCallId: "availability-2" } as never,
    );

    expect(second).toBe(first);
    expect(middleware.operations).toHaveLength(1);
  });

  it("does not reuse availability across materially different preferences", async () => {
    const state = createState();
    const middleware = new InMemorySchedulingMiddleware({
      availability: [
        foundAvailability([{ time: "9:00 AM", bookingToken: "morning-token" }]),
        foundAvailability([
          { time: "2:00 PM", bookingToken: "afternoon-token" },
        ]),
      ],
    });
    const { get_availability } = createSchedulingTools(
      middleware,
      fixedClock("2026-06-09T14:42:00.000Z"),
    );
    const ctx = createToolContext(state);

    await get_availability.execute(
      {
        when: [{ time: { kind: "morning" } }],
        appointmentLane: "medical_md",
      },
      { ctx: ctx as never, toolCallId: "availability-1" } as never,
    );
    await get_availability.execute(
      {
        when: [{ time: { kind: "afternoon" } }],
        appointmentLane: "medical_md",
      },
      { ctx: ctx as never, toolCallId: "availability-2" } as never,
    );

    expect(middleware.operations).toHaveLength(2);
    expect(state.availability.slots).toMatchObject([
      { slotId: "S2", time: "2:00 PM" },
    ]);
    expect(state.availability.bookingTokensBySlotId).toEqual({
      S2: "afternoon-token",
    });
  });

  it("preserves middleware ranking and stores at most two real slots", async () => {
    const { state } = await checkAvailability({
      result: foundAvailability([
        { time: "3:00 PM" },
        { time: "9:00 AM" },
        { time: "11:00 AM" },
      ]),
    });

    expect(state.availability.slots.map((slot) => slot.time)).toEqual([
      "3:00 PM",
      "9:00 AM",
    ]);
  });

  it("states middleware-owned fallback differences without another search turn", async () => {
    const { response } = await checkAvailability({
      when: [{ time: { kind: "afternoon" } }],
      result: foundAvailability([
        {
          time: "9:00 AM",
          preferenceMatch: "fallback",
          preferenceDifferences: ["time"],
        },
      ]),
    });

    expect(response).toContain("differs from the requested time");
    expect(response).not.toMatch(/ask whether|another search|different day/i);
  });

  it("offers exact matches without fallback language", async () => {
    const { response } = await checkAvailability({
      when: [{ weekday: "wednesday" }],
      result: foundAvailability([
        { time: "9:00 AM", preferenceMatch: "exact" },
        { time: "2:00 PM", preferenceMatch: "exact" },
      ]),
    });

    expect(response).toContain("Offer these options");
    expect(response).not.toContain("differs from");
  });

  it("reports complete zero inventory without inventing another preference", async () => {
    const { response, state } = await checkAvailability({
      result: noAvailability("2026-06-09", {
        searchedFrom: "2026-06-09",
        searchedThrough: "2026-06-23",
      }),
    });

    expect(response).toBe(
      "No openings were found for the complete search window June 9 through June 23.",
    );
    expect(state.availability.slots).toEqual([]);
  });

  it("keeps an incomplete search distinct from authoritative none", async () => {
    const { response } = await checkAvailability({
      result: {
        status: "incomplete",
        requestedDate: "2026-06-09",
        searchedFrom: "2026-06-09",
        searchedThrough: "2026-06-12",
        dateShifted: false,
        shouldRetrySameSearch: true,
        slots: [],
      },
    });

    expect(response).toContain("Availability was not fully checked");
    expect(response).toContain("same structured preferences");
    expect(response).not.toContain("No openings were found");
  });

  it("does not record preference payloads in availability telemetry", async () => {
    const { state } = await checkAvailability({
      when: [
        {
          weekday: "monday",
          time: {
            kind: "after",
            hour: 1,
            minute: 30,
            meridiem: "pm",
          },
        },
      ],
    });

    expect(JSON.stringify(availabilityReadEvents(state))).not.toMatch(
      /monday|preferences|minuteOfDay|810/i,
    );
  });

  it("books through an opaque slot reference returned by structured search", async () => {
    const state = createState();
    const middleware = new InMemorySchedulingMiddleware({
      availability: [
        foundAvailability([{ time: "3:00 PM", bookingToken: "private-token" }]),
      ],
      bookings: [
        {
          status: "booked",
          appointmentId: 456,
          providerName: "Dr. Provider 1",
          locationName: "Spring Hill",
          appointmentTypeName: "Medical",
          message: null,
        },
      ],
    });
    const { book_appointment, get_availability } = createSchedulingTools(
      middleware,
      fixedClock("2026-06-09T14:42:00.000Z"),
    );
    const ctx = createToolContext(state);

    await get_availability.execute(
      {
        when: [
          {
            date: { kind: "tomorrow" },
            time: {
              kind: "exact",
              hour: 3,
              minute: 0,
              meridiem: "pm",
            },
          },
        ],
        appointmentLane: "medical_md",
      },
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
      {
        kind: "availability",
        request: {
          date: "2026-06-10",
          preferences: [
            {
              date: "2026-06-10",
              time: { kind: "exact", minuteOfDay: 900 },
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
  const match = time.match(/^(\d{1,2}):(\d{2})\s+(AM|PM)$/);
  if (!match) throw new Error(`Unexpected test time: ${time}`);
  let hour = Number(match[1]);
  if (match[3] === "PM" && hour !== 12) hour += 12;
  if (match[3] === "AM" && hour === 12) hour = 0;
  return `${String(hour).padStart(2, "0")}:${match[2]}`;
}
