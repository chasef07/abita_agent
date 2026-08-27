import { describe, expect, it } from "vitest";
import { createSchedulingTools } from "../scheduling/tools.js";
import { createConfirmedPatientState } from "./support/call-state.js";
import { InMemorySchedulingMiddleware } from "./support/scheduling-middleware.js";
import { createToolContext } from "./support/tool-context.js";
import { setRoutingContext } from "../scheduling/state.js";

function found(date: string, times: string[]) {
  return {
    status: "found" as const,
    slots: times.map((time, index) => ({
      provider: "Dr. Bach",
      date,
      time,
      datetime: `${date}T${time.startsWith("9") ? "09" : "10"}:00`,
      bookingToken: `${date}-token-${index}`,
    })),
    requestedDate: date,
    actualDate: date,
    searchedFrom: date,
    searchedThrough: date,
    bookingTokenExpiresAt: "2026-06-30T00:00:00Z",
    matchStatus: "exact" as const,
    dateShifted: false,
    shouldRetrySameSearch: false,
  };
}

describe("Scheduling Workflow availability contract", () => {
  it.each([
    ["2026-06-01T03:30:00.000Z", "tomorrow", "2026-06-01", "-04:00"],
    ["2026-12-31T15:00:00.000Z", "tomorrow", "2027-01-01", "-05:00"],
    ["2026-06-08T14:00:00.000Z", "mañana", "2026-06-09", "-04:00"],
  ])(
    "resolves %s at the Eastern calendar boundary",
    async (instant, datePhrase, expectedDate, expectedOffset) => {
      const state = createConfirmedPatientState();
      const middleware = new InMemorySchedulingMiddleware({
        availability: [
          {
            status: "none",
            slots: [],
            dateShifted: false,
            shouldRetrySameSearch: false,
          },
        ],
      });
      const { get_availability } = createSchedulingTools(middleware, {
        now: () => new Date(instant),
      });

      await get_availability.execute(
        {
          branches: [{ datePhrase, time: { operator: "any" } }],
          visitType: "medical",
          oldAppointmentRef: null,
        },
        {
          ctx: createToolContext(state) as never,
          toolCallId: `availability-boundary-${expectedDate}`,
        } as never,
      );

      expect(middleware.operations[0]).toMatchObject({
        kind: "availability",
        request: {
          windows: [
            {
              start: `${expectedDate}T00:00:00${expectedOffset}`,
            },
          ],
        },
      });
    },
  );

  it("expands next week into its full caller-requested range", async () => {
    const state = createConfirmedPatientState();
    const middleware = new InMemorySchedulingMiddleware({
      availability: [
        {
          status: "none",
          slots: [],
          dateShifted: false,
          shouldRetrySameSearch: false,
        },
      ],
    });
    const { get_availability } = createSchedulingTools(middleware, {
      now: () => new Date("2026-06-08T14:00:00.000Z"),
    });

    await get_availability.execute(
      {
        branches: [{ datePhrase: "next week", time: { operator: "any" } }],
        visitType: "medical",
        oldAppointmentRef: null,
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "availability-next-week",
      } as never,
    );

    const windows = middleware.operations[0]?.request.windows ?? [];
    expect(windows).toHaveLength(7);
    expect(windows[0]).toMatchObject({
      start: "2026-06-15T00:00:00-04:00",
      end: "2026-06-16T00:00:00-04:00",
    });
    expect(windows.at(-1)).toMatchObject({
      start: "2026-06-21T00:00:00-04:00",
      end: "2026-06-22T00:00:00-04:00",
    });
  });

  it.each(["next month", "in July"])(
    "expands %s across the bounded month range",
    async (datePhrase) => {
      const state = createConfirmedPatientState();
      const middleware = new InMemorySchedulingMiddleware({
        availability: [
          {
            status: "none",
            slots: [],
            dateShifted: false,
            shouldRetrySameSearch: false,
          },
        ],
      });
      const { get_availability } = createSchedulingTools(middleware, {
        now: () => new Date("2026-06-08T14:00:00.000Z"),
      });

      await get_availability.execute(
        {
          branches: [{ datePhrase, time: { operator: "any" } }],
          visitType: "medical",
          oldAppointmentRef: null,
        },
        {
          ctx: createToolContext(state) as never,
          toolCallId: `availability-${datePhrase}`,
        } as never,
      );

      const windows = middleware.operations[0]?.request.windows ?? [];
      expect(windows).toHaveLength(15);
      expect(windows[0]?.start).toBe("2026-07-01T00:00:00-04:00");
      expect(windows.at(-1)?.start).toBe("2026-07-15T00:00:00-04:00");
    },
  );

  it("keeps the 15-date horizon for multiple broad time branches", async () => {
    const state = createConfirmedPatientState();
    const middleware = new InMemorySchedulingMiddleware({
      availability: [
        {
          status: "none",
          slots: [],
          dateShifted: false,
          shouldRetrySameSearch: false,
        },
      ],
    });
    const { get_availability } = createSchedulingTools(middleware, {
      now: () => new Date("2026-06-08T14:00:00.000Z"),
    });

    await get_availability.execute(
      {
        branches: [
          { datePhrase: "next available", time: { operator: "morning" } },
          { datePhrase: "next available", time: { operator: "afternoon" } },
        ],
        visitType: "medical",
        oldAppointmentRef: null,
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "availability-full-horizon",
      } as never,
    );

    const windows = middleware.operations[0]?.request.windows ?? [];
    const dates = [
      ...new Set(windows.map((window) => window.start.slice(0, 10))),
    ];
    expect(windows).toHaveLength(30);
    expect(dates).toHaveLength(15);
    expect(dates[0]).toBe("2026-06-09");
    expect(dates.at(-1)).toBe("2026-06-23");
  });

  it("asks one focused clarification for an ambiguous bare clock", async () => {
    const state = createConfirmedPatientState();
    const middleware = new InMemorySchedulingMiddleware();
    const { get_availability } = createSchedulingTools(middleware, {
      now: () => new Date("2026-06-08T14:00:00.000Z"),
    });

    const result = await get_availability.execute(
      {
        branches: [
          {
            datePhrase: "June 9",
            time: { operator: "exact", clockPhrase: "3" },
          },
        ],
        visitType: "medical",
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "availability-ambiguous-clock",
      } as never,
    );

    expect(result).toBe(
      "Ask whether the caller means 3 AM or 3 PM, then call get_availability with the clarified clock phrase.",
    );
    expect(middleware.operations).toEqual([]);
  });

  it("honors an explicit Spanish afternoon clock phrase", async () => {
    const state = createConfirmedPatientState();
    const middleware = new InMemorySchedulingMiddleware({
      availability: [
        {
          status: "none",
          slots: [],
          dateShifted: false,
          shouldRetrySameSearch: false,
        },
      ],
    });
    const { get_availability } = createSchedulingTools(middleware, {
      now: () => new Date("2026-06-08T14:00:00.000Z"),
    });

    await get_availability.execute(
      {
        branches: [
          {
            datePhrase: "June 9",
            time: { operator: "exact", clockPhrase: "3 de la tarde" },
          },
        ],
        visitType: "medical",
        oldAppointmentRef: null,
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "availability-spanish-afternoon",
      } as never,
    );

    expect(middleware.operations[0]).toMatchObject({
      kind: "availability",
      request: {
        windows: [
          {
            start: "2026-06-09T15:00:00-04:00",
            end: "2026-06-09T15:01:00-04:00",
          },
        ],
      },
    });
  });

  it.each([
    [
      "exact",
      { operator: "exact", clockPhrase: "3 PM" } as const,
      "2026-06-09T15:00:00-04:00",
      "2026-06-09T15:01:00-04:00",
    ],
    [
      "around",
      { operator: "around", clockPhrase: "3 PM" } as const,
      "2026-06-09T14:00:00-04:00",
      "2026-06-09T16:01:00-04:00",
    ],
    [
      "before",
      { operator: "before", clockPhrase: "3 PM" } as const,
      "2026-06-09T00:00:00-04:00",
      "2026-06-09T15:00:00-04:00",
    ],
    [
      "after",
      { operator: "after", clockPhrase: "3 PM" } as const,
      "2026-06-09T15:00:00-04:00",
      "2026-06-10T00:00:00-04:00",
    ],
  ])(
    "normalizes %s as a distinct deterministic window",
    async (_name, time, start, end) => {
      const state = createConfirmedPatientState();
      const middleware = new InMemorySchedulingMiddleware({
        availability: [
          {
            status: "none",
            slots: [],
            dateShifted: false,
            shouldRetrySameSearch: false,
          },
        ],
      });
      const { get_availability } = createSchedulingTools(middleware, {
        now: () => new Date("2026-06-08T14:00:00.000Z"),
      });

      await get_availability.execute(
        {
          branches: [{ datePhrase: "June 9", time }],
          visitType: "medical",
        },
        {
          ctx: createToolContext(state) as never,
          toolCallId: `availability-${_name}`,
        } as never,
      );

      expect(middleware.operations[0]).toMatchObject({
        kind: "availability",
        request: { windows: [{ start, end }] },
      });
    },
  );

  it("reuses an equivalent normalized search without another middleware read", async () => {
    const state = createConfirmedPatientState();
    const middleware = new InMemorySchedulingMiddleware({
      availability: [found("2026-06-09", ["9:00 AM"])],
    });
    const { get_availability } = createSchedulingTools(middleware, {
      now: () => new Date("2026-06-08T14:00:00.000Z"),
    });
    const ctx = createToolContext(state);
    const args = {
      branches: [
        { datePhrase: "June 9", time: { operator: "morning" as const } },
      ],
      visitType: "medical" as const,
    };

    await get_availability.execute(args, {
      ctx: ctx as never,
      toolCallId: "availability-equivalent-1",
    } as never);
    const replay = await get_availability.execute(args, {
      ctx: ctx as never,
      toolCallId: "availability-equivalent-2",
    } as never);

    expect(
      middleware.operations.filter(
        (operation) => operation.kind === "availability",
      ),
    ).toHaveLength(1);
    expect(state.availability.slots.map((slot) => slot.slotId)).toEqual(["S1"]);
    expect(replay).toBe(
      "I got the same availability result. What date or time would you like to change?",
    );
  });

  it("inherits an unchanged time constraint for a date-only follow-up", async () => {
    const state = createConfirmedPatientState();
    const noAvailability = {
      status: "none" as const,
      slots: [],
      dateShifted: false,
      shouldRetrySameSearch: false,
    };
    const middleware = new InMemorySchedulingMiddleware({
      availability: [noAvailability, noAvailability, noAvailability],
    });
    const { get_availability } = createSchedulingTools(middleware, {
      now: () => new Date("2026-06-08T14:00:00.000Z"),
    });
    const ctx = createToolContext(state);

    await get_availability.execute(
      {
        branches: [{ datePhrase: "Tuesday", time: { operator: "afternoon" } }],
        visitType: "medical",
        oldAppointmentRef: null,
      },
      { ctx: ctx as never, toolCallId: "availability-tuesday" } as never,
    );
    await get_availability.execute(
      {
        branches: [{ datePhrase: "Thursday", time: null }],
        visitType: "medical",
        oldAppointmentRef: null,
      } as never,
      { ctx: ctx as never, toolCallId: "availability-thursday" } as never,
    );

    expect(middleware.operations[1]).toMatchObject({
      kind: "availability",
      request: {
        windows: [
          {
            start: "2026-06-11T12:00:00-04:00",
            end: "2026-06-12T00:00:00-04:00",
          },
        ],
      },
    });

    await get_availability.execute(
      {
        branches: [{ datePhrase: "Thursday", time: { operator: "morning" } }],
        visitType: "medical",
        oldAppointmentRef: null,
      },
      {
        ctx: ctx as never,
        toolCallId: "availability-thursday-morning",
      } as never,
    );
    expect(middleware.operations[2]).toMatchObject({
      kind: "availability",
      request: {
        windows: [
          {
            start: "2026-06-11T00:00:00-04:00",
            end: "2026-06-11T12:00:00-04:00",
          },
        ],
      },
    });
  });

  it("keeps an inherited relative date stable after clinic midnight", async () => {
    let now = new Date("2026-06-08T14:00:00.000Z");
    const state = createConfirmedPatientState();
    const noAvailability = {
      status: "none" as const,
      slots: [],
      dateShifted: false,
      shouldRetrySameSearch: false,
    };
    const middleware = new InMemorySchedulingMiddleware({
      availability: [noAvailability, noAvailability],
    });
    const { get_availability } = createSchedulingTools(middleware, {
      now: () => now,
    });
    const ctx = createToolContext(state);

    await get_availability.execute(
      {
        branches: [{ datePhrase: "tomorrow", time: { operator: "afternoon" } }],
        visitType: "medical",
        oldAppointmentRef: null,
      },
      { ctx: ctx as never, toolCallId: "availability-relative-date" } as never,
    );
    now = new Date("2026-06-09T14:00:00.000Z");
    await get_availability.execute(
      {
        branches: [{ datePhrase: null, time: { operator: "morning" } }],
        visitType: "medical",
        oldAppointmentRef: null,
      },
      { ctx: ctx as never, toolCallId: "availability-inherited-date" } as never,
    );

    expect(middleware.operations[1]).toMatchObject({
      kind: "availability",
      request: {
        windows: [
          {
            start: "2026-06-09T00:00:00-04:00",
            end: "2026-06-09T12:00:00-04:00",
          },
        ],
      },
    });
  });

  it("preserves compound caller branches as distinct concrete windows", async () => {
    const state = createConfirmedPatientState();
    const middleware = new InMemorySchedulingMiddleware({
      availability: [
        {
          status: "none",
          slots: [],
          dateShifted: false,
          shouldRetrySameSearch: false,
        },
      ],
    });
    const { get_availability } = createSchedulingTools(middleware, {
      now: () => new Date("2026-06-08T14:00:00.000Z"),
    });

    await get_availability.execute(
      {
        branches: [
          {
            datePhrase: "Tuesday",
            time: { operator: "before", clockPhrase: "3 PM" },
          },
          {
            datePhrase: "Thursday",
            time: { operator: "after", clockPhrase: "4 PM" },
          },
        ],
        visitType: "medical",
      } as never,
      {
        ctx: createToolContext(state) as never,
        toolCallId: "availability-contract-1",
      } as never,
    );

    expect(middleware.operations).toMatchObject([
      {
        kind: "availability",
        request: {
          timeZone: "America/New_York",
          windows: [
            {
              start: "2026-06-09T00:00:00-04:00",
              end: "2026-06-09T15:00:00-04:00",
            },
            {
              start: "2026-06-11T16:00:00-04:00",
              end: "2026-06-12T00:00:00-04:00",
            },
          ],
        },
      },
    ]);
  });

  it("keeps only the current and previous two-offer sets", async () => {
    const state = createConfirmedPatientState();
    const middleware = new InMemorySchedulingMiddleware({
      availability: [
        found("2026-06-09", ["9:00 AM", "10:00 AM"]),
        found("2026-06-10", ["9:00 AM", "10:00 AM"]),
        found("2026-06-11", ["9:00 AM", "10:00 AM"]),
      ],
    });
    const { get_availability } = createSchedulingTools(middleware, {
      now: () => new Date("2026-06-08T14:00:00.000Z"),
    });
    const ctx = createToolContext(state);

    for (const [index, datePhrase] of [
      "June 9",
      "June 10",
      "June 11",
    ].entries()) {
      await get_availability.execute(
        {
          branches: [{ datePhrase, time: { operator: "any" } }],
          visitType: "medical",
        },
        {
          ctx: ctx as never,
          toolCallId: `availability-set-${index}`,
        } as never,
      );
    }

    expect(state.availability.slots.map((slot) => slot.slotId)).toEqual([
      "S3",
      "S4",
      "S5",
      "S6",
    ]);
    expect(Object.keys(state.availability.bookingTokensBySlotId)).toEqual([
      "S3",
      "S4",
      "S5",
      "S6",
    ]);
    expect(state.availability.offerSetSlotIds).toEqual([
      ["S3", "S4"],
      ["S5", "S6"],
    ]);
  });

  it("does not count an empty search as an offer set", async () => {
    const state = createConfirmedPatientState();
    const middleware = new InMemorySchedulingMiddleware({
      availability: [
        found("2026-06-09", ["9:00 AM"]),
        {
          status: "none",
          slots: [],
          dateShifted: false,
          shouldRetrySameSearch: false,
        },
        found("2026-06-11", ["9:00 AM"]),
      ],
    });
    const { get_availability } = createSchedulingTools(middleware, {
      now: () => new Date("2026-06-08T14:00:00.000Z"),
    });
    const ctx = createToolContext(state);

    for (const [index, datePhrase] of [
      "June 9",
      "June 10",
      "June 11",
    ].entries()) {
      await get_availability.execute(
        {
          branches: [{ datePhrase, time: { operator: "any" } }],
          visitType: "medical",
        },
        {
          ctx: ctx as never,
          toolCallId: `availability-empty-set-${index}`,
        } as never,
      );
    }

    expect(state.availability.offerSetSlotIds).toEqual([["S1"], ["S2"]]);
    expect(state.availability.slots.map((slot) => slot.slotId)).toEqual([
      "S1",
      "S2",
    ]);
  });

  it("clears preferences and offers when the caller explicitly starts over", async () => {
    const state = createConfirmedPatientState();
    const middleware = new InMemorySchedulingMiddleware({
      availability: [found("2026-06-09", ["9:00 AM"])],
    });
    const { get_availability } = createSchedulingTools(middleware, {
      now: () => new Date("2026-06-08T14:00:00.000Z"),
    });
    const ctx = createToolContext(state);

    await get_availability.execute(
      {
        branches: [{ datePhrase: "June 9", time: { operator: "morning" } }],
        visitType: "medical",
      },
      { ctx: ctx as never, toolCallId: "availability-before-reset" } as never,
    );
    const result = await get_availability.execute(
      { branches: [], visitType: "medical" },
      { ctx: ctx as never, toolCallId: "availability-reset" } as never,
    );

    expect(result).toContain("cleared those choices");
    expect(middleware.operations).toHaveLength(1);
    expect(state.availability.preferenceBranches).toEqual([]);
    expect(state.availability.offerSetSlotIds).toEqual([]);
    expect(state.availability.slots).toEqual([]);
  });

  it("preserves still-active offer references when a newer search fails", async () => {
    const state = createConfirmedPatientState();
    const middleware = new InMemorySchedulingMiddleware({
      availability: [
        found("2026-06-09", ["9:00 AM"]),
        { status: "error", reason: "network_error" },
      ],
    });
    const { get_availability } = createSchedulingTools(middleware, {
      now: () => new Date("2026-06-08T14:00:00.000Z"),
    });
    const ctx = createToolContext(state);
    await get_availability.execute(
      {
        branches: [{ datePhrase: "June 9", time: { operator: "any" } }],
        visitType: "medical",
      },
      { ctx: ctx as never, toolCallId: "availability-before-failure" } as never,
    );

    await expect(
      get_availability.execute(
        {
          branches: [{ datePhrase: "June 10", time: { operator: "any" } }],
          visitType: "medical",
        },
        { ctx: ctx as never, toolCallId: "availability-failure" } as never,
      ),
    ).rejects.toThrow();

    expect(state.availability.slots.map((slot) => slot.slotId)).toEqual(["S1"]);
    expect(state.availability.bookingTokensBySlotId).toEqual({
      S1: "2026-06-09-token-0",
    });
  });

  it("books the exact confirmed slot from the previous offer set", async () => {
    const state = createConfirmedPatientState();
    const middleware = new InMemorySchedulingMiddleware({
      availability: [
        found("2026-06-09", ["9:00 AM", "10:00 AM"]),
        found("2026-06-10", ["9:00 AM", "10:00 AM"]),
      ],
      bookings: [
        {
          status: "booked",
          appointmentId: 1234,
          providerName: "Dr. Bach",
          locationName: "Spring Hill",
          appointmentTypeName: "Established Patient",
          message: "Appointment booked successfully",
        },
      ],
    });
    const { book_appointment, get_availability } = createSchedulingTools(
      middleware,
      { now: () => new Date("2026-06-08T14:00:00.000Z") },
    );
    const ctx = createToolContext(state);

    for (const [index, datePhrase] of ["June 9", "June 10"].entries()) {
      await get_availability.execute(
        {
          branches: [{ datePhrase, time: { operator: "any" } }],
          visitType: "medical",
        },
        {
          ctx: ctx as never,
          toolCallId: `availability-old-ref-${index}`,
        } as never,
      );
    }
    const result = await book_appointment.execute(
      {
        appointmentSlotRef: "S1",
        appointmentReason: "annual medical eye evaluation",
        referringDoctor: "none",
        readBack: true,
      },
      {
        ctx: ctx as never,
        toolCallId: "book-old-ref",
      } as never,
    );

    expect(result).toContain("Booked Tuesday, June 9 at 9:00 AM");
    expect(middleware.operations.at(-1)).toMatchObject({
      kind: "book",
      request: { bookingToken: "2026-06-09-token-0" },
    });
  });

  it("labels alternatives with the constraints they do not meet", async () => {
    const state = createConfirmedPatientState();
    const middleware = new InMemorySchedulingMiddleware({
      availability: [
        {
          ...found("2026-06-09", ["9:00 AM", "10:00 AM"]),
          matchStatus: "alternatives",
          slots: [
            {
              ...found("2026-06-09", ["9:00 AM"]).slots[0]!,
              unmetConstraints: ["time"],
            },
            {
              ...found("2026-06-10", ["10:00 AM"]).slots[0]!,
              unmetConstraints: ["date"],
            },
          ],
        },
      ],
    });
    const { get_availability } = createSchedulingTools(middleware, {
      now: () => new Date("2026-06-08T14:00:00.000Z"),
    });

    const result = await get_availability.execute(
      {
        branches: [
          {
            datePhrase: "June 9",
            time: { operator: "after", clockPhrase: "3 PM" },
          },
        ],
        visitType: "medical",
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "availability-alternatives",
      } as never,
    );

    expect(result).toContain("I couldn't find an exact match");
    expect(result).toContain("not the requested time");
    expect(result).toContain("not the requested date");
  });

  it("rechecks and books an identical slot after definitive token rejection", async () => {
    const state = createConfirmedPatientState();
    const refreshed = found("2026-06-09", ["9:00 AM"]);
    refreshed.slots[0]!.bookingToken = "refreshed-token";
    const middleware = new InMemorySchedulingMiddleware({
      availability: [found("2026-06-09", ["9:00 AM"]), refreshed],
      bookings: [
        { status: "rejected", reason: "invalid_booking_token" },
        {
          status: "booked",
          appointmentId: 2345,
          providerName: "Dr. Bach",
          locationName: "Spring Hill",
          appointmentTypeName: "Established Patient",
          message: "Appointment booked successfully",
        },
      ],
    });
    const { book_appointment, get_availability } = createSchedulingTools(
      middleware,
      { now: () => new Date("2026-06-08T14:00:00.000Z") },
    );
    const ctx = createToolContext(state);
    await get_availability.execute(
      {
        branches: [{ datePhrase: "June 9", time: { operator: "any" } }],
        visitType: "medical",
      },
      { ctx: ctx as never, toolCallId: "availability-stale" } as never,
    );

    const result = await book_appointment.execute(
      {
        appointmentSlotRef: "S1",
        appointmentReason: "annual medical eye evaluation",
        referringDoctor: "none",
        readBack: true,
      },
      { ctx: ctx as never, toolCallId: "book-stale" } as never,
    );

    expect(result).toContain("Booked Tuesday, June 9 at 9:00 AM");
    expect(
      middleware.operations.filter((operation) => operation.kind === "book"),
    ).toHaveLength(2);
    expect(
      middleware.operations.filter(
        (operation) => operation.kind === "availability",
      )[1],
    ).toMatchObject({
      kind: "availability",
      request: { provider: "Dr. Bach" },
    });
    expect(middleware.operations.at(-1)).toMatchObject({
      kind: "book",
      request: { bookingToken: "refreshed-token" },
    });
  });

  it("rechecks an expired confirmed slot at most once", async () => {
    let now = new Date("2026-06-08T14:00:00.000Z");
    const initial = found("2026-06-09", ["9:00 AM"]);
    initial.bookingTokenExpiresAt = "2026-06-09T00:00:00.000Z";
    const refreshed = found("2026-06-09", ["9:00 AM"]);
    refreshed.slots[0]!.bookingToken = "refreshed-token";
    const state = createConfirmedPatientState();
    const middleware = new InMemorySchedulingMiddleware({
      availability: [initial, refreshed, refreshed],
      bookings: [{ status: "rejected", reason: "invalid_booking_token" }],
    });
    const { book_appointment, get_availability } = createSchedulingTools(
      middleware,
      { now: () => now },
    );
    const ctx = createToolContext(state);
    await get_availability.execute(
      {
        branches: [{ datePhrase: "June 9", time: { operator: "any" } }],
        visitType: "medical",
        oldAppointmentRef: null,
      },
      { ctx: ctx as never, toolCallId: "availability-local-expiry" } as never,
    );
    now = new Date("2026-06-09T01:00:00.000Z");

    const result = await book_appointment.execute(
      {
        appointmentSlotRef: "S1",
        appointmentReason: "annual medical eye evaluation",
        referringDoctor: "none",
        readBack: true,
      },
      { ctx: ctx as never, toolCallId: "book-local-expiry" } as never,
    );

    expect(result).toContain("couldn't book that confirmed time");
    expect(
      middleware.operations.filter(
        (operation) => operation.kind === "availability",
      ),
    ).toHaveLength(2);
    expect(
      middleware.operations.filter((operation) => operation.kind === "book"),
    ).toHaveLength(1);
  });

  it("offers changed inventory and requires confirmation when the stale slot is gone", async () => {
    const state = createConfirmedPatientState();
    const alternative = found("2026-06-09", ["10:00 AM"]);
    alternative.matchStatus = "alternatives";
    alternative.slots[0]!.unmetConstraints = ["time"];
    const middleware = new InMemorySchedulingMiddleware({
      availability: [found("2026-06-09", ["9:00 AM"]), alternative],
      bookings: [{ status: "unavailable", reason: "slot_unavailable" }],
    });
    const { book_appointment, get_availability } = createSchedulingTools(
      middleware,
      { now: () => new Date("2026-06-08T14:00:00.000Z") },
    );
    const ctx = createToolContext(state);
    await get_availability.execute(
      {
        branches: [{ datePhrase: "June 9", time: { operator: "any" } }],
        visitType: "medical",
      },
      { ctx: ctx as never, toolCallId: "availability-gone" } as never,
    );

    const result = await book_appointment.execute(
      {
        appointmentSlotRef: "S1",
        appointmentReason: "annual medical eye evaluation",
        referringDoctor: "none",
        readBack: true,
      },
      { ctx: ctx as never, toolCallId: "book-gone" } as never,
    );

    expect(result).toContain("confirmed time is no longer available");
    expect(result).toContain("confirm one of the new times");
    expect(result).not.toContain("appointmentSlotRef");
    expect(
      middleware.operations.filter((operation) => operation.kind === "book"),
    ).toHaveLength(1);
    expect(
      state.availability.slots.some((slot) => slot.time === "10:00 AM"),
    ).toBe(true);
  });

  it("preserves the confirmed slot when its recheck is incomplete", async () => {
    const state = createConfirmedPatientState();
    const middleware = new InMemorySchedulingMiddleware({
      availability: [
        found("2026-06-09", ["9:00 AM"]),
        {
          status: "incomplete",
          slots: [],
          requestedDate: "2026-06-09",
          searchedFrom: "2026-06-09",
          searchedThrough: "2026-06-09",
          dateShifted: false,
          shouldRetrySameSearch: true,
        },
      ],
      bookings: [{ status: "rejected", reason: "invalid_booking_token" }],
    });
    const { book_appointment, get_availability } = createSchedulingTools(
      middleware,
      { now: () => new Date("2026-06-08T14:00:00.000Z") },
    );
    const ctx = createToolContext(state);
    await get_availability.execute(
      {
        branches: [{ datePhrase: "June 9", time: { operator: "any" } }],
        visitType: "medical",
        oldAppointmentRef: null,
      },
      {
        ctx: ctx as never,
        toolCallId: "availability-incomplete-recheck",
      } as never,
    );

    const result = await book_appointment.execute(
      {
        appointmentSlotRef: "S1",
        appointmentReason: "annual medical eye evaluation",
        referringDoctor: "none",
        readBack: true,
      },
      { ctx: ctx as never, toolCallId: "book-incomplete-recheck" } as never,
    );

    expect(result).toContain("couldn't finish rechecking");
    expect(result).not.toContain("no longer available");
    expect(state.availability.slots.map((slot) => slot.slotId)).toEqual(["S1"]);
    expect(state.availability.bookingTokensBySlotId).toEqual({});
    expect(
      middleware.operations.filter((operation) => operation.kind === "book"),
    ).toHaveLength(1);
  });

  it("does not retry or recheck after an ambiguous booking failure", async () => {
    const state = createConfirmedPatientState();
    const middleware = new InMemorySchedulingMiddleware({
      availability: [found("2026-06-09", ["9:00 AM"])],
      bookings: [{ status: "error", reason: "request_rejected" }],
    });
    const { book_appointment, get_availability } = createSchedulingTools(
      middleware,
      { now: () => new Date("2026-06-08T14:00:00.000Z") },
    );
    const ctx = createToolContext(state);
    await get_availability.execute(
      {
        branches: [{ datePhrase: "June 9", time: { operator: "any" } }],
        visitType: "medical",
      },
      { ctx: ctx as never, toolCallId: "availability-ambiguous" } as never,
    );

    await expect(
      book_appointment.execute(
        {
          appointmentSlotRef: "S1",
          appointmentReason: "annual medical eye evaluation",
          referringDoctor: "none",
          readBack: true,
        },
        { ctx: ctx as never, toolCallId: "book-ambiguous" } as never,
      ),
    ).rejects.toThrow();
    expect(
      middleware.operations.filter((operation) => operation.kind === "book"),
    ).toHaveLength(1);
    expect(
      middleware.operations.filter(
        (operation) => operation.kind === "availability",
      ),
    ).toHaveLength(1);
  });

  it("does not apply a stale-slot recheck after patient context changes", async () => {
    const state = createConfirmedPatientState();
    const refreshed = found("2026-06-09", ["9:00 AM"]);
    let resolveRecheck!: (value: typeof refreshed) => void;
    const recheck = new Promise<typeof refreshed>((resolve) => {
      resolveRecheck = resolve;
    });
    const middleware = new InMemorySchedulingMiddleware({
      availability: [found("2026-06-09", ["9:00 AM"]), recheck],
      bookings: [{ status: "rejected", reason: "invalid_booking_token" }],
    });
    const { book_appointment, get_availability } = createSchedulingTools(
      middleware,
      { now: () => new Date("2026-06-08T14:00:00.000Z") },
    );
    const ctx = createToolContext(state);
    await get_availability.execute(
      {
        branches: [{ datePhrase: "June 9", time: { operator: "any" } }],
        visitType: "medical",
      },
      { ctx: ctx as never, toolCallId: "availability-context-change" } as never,
    );

    const pending = book_appointment.execute(
      {
        appointmentSlotRef: "S1",
        appointmentReason: "annual medical eye evaluation",
        referringDoctor: "none",
        readBack: true,
      },
      { ctx: ctx as never, toolCallId: "book-context-change" } as never,
    );
    await expect.poll(() => middleware.operations.length).toBe(3);
    state.identity.transitionVersion += 1;
    resolveRecheck(refreshed);

    await expect(pending).resolves.toContain(
      "context changed while the confirmed time was being rechecked",
    );
    expect(
      middleware.operations.filter((operation) => operation.kind === "book"),
    ).toHaveLength(1);
  });

  it("does not apply a stale-slot recheck after routing changes", async () => {
    const state = createConfirmedPatientState();
    const refreshed = found("2026-06-09", ["9:00 AM"]);
    let resolveRecheck!: (value: typeof refreshed) => void;
    const recheck = new Promise<typeof refreshed>((resolve) => {
      resolveRecheck = resolve;
    });
    const middleware = new InMemorySchedulingMiddleware({
      availability: [found("2026-06-09", ["9:00 AM"]), recheck],
      bookings: [
        { status: "rejected", reason: "invalid_booking_token" },
        {
          status: "booked",
          appointmentId: 3456,
          providerName: "Dr. Bach",
          locationName: "Spring Hill",
          appointmentTypeName: "Established Patient",
          message: "Appointment booked successfully",
        },
      ],
    });
    const { book_appointment, get_availability } = createSchedulingTools(
      middleware,
      { now: () => new Date("2026-06-08T14:00:00.000Z") },
    );
    const ctx = createToolContext(state);
    await get_availability.execute(
      {
        branches: [{ datePhrase: "June 9", time: { operator: "any" } }],
        visitType: "medical",
        oldAppointmentRef: null,
      },
      { ctx: ctx as never, toolCallId: "availability-routing-change" } as never,
    );

    const pending = book_appointment.execute(
      {
        appointmentSlotRef: "S1",
        appointmentReason: "annual medical eye evaluation",
        referringDoctor: "none",
        readBack: true,
      },
      { ctx: ctx as never, toolCallId: "book-routing-change" } as never,
    );
    await expect.poll(() => middleware.operations.length).toBe(3);
    setRoutingContext(state, {
      routing: "bach_only",
      allowedProviders: ["Dr. Bach"],
      routingAmbiguous: false,
      preauthRequired: true,
    });
    resolveRecheck(refreshed);

    await expect(pending).resolves.toContain(
      "context changed while the confirmed time was being rechecked",
    );
    expect(
      middleware.operations.filter((operation) => operation.kind === "book"),
    ).toHaveLength(1);
    expect(state.availability.bookingTokensBySlotId).toEqual({});
  });
});
