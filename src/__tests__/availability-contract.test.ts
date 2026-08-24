import { describe, expect, it } from "vitest";
import { createSchedulingTools } from "../scheduling/tools.js";
import { createConfirmedPatientState } from "./support/call-state.js";
import { InMemorySchedulingMiddleware } from "./support/scheduling-middleware.js";
import { createToolContext } from "./support/tool-context.js";

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
    expect(replay).toContain("same normalized availability request");
    expect(replay).toContain(
      "what date or time constraint they want to change",
    );
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
    expect(middleware.operations.at(-1)).toMatchObject({
      kind: "book",
      request: { bookingToken: "refreshed-token" },
    });
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
    expect(result).toContain("requires new caller confirmation");
    expect(
      middleware.operations.filter((operation) => operation.kind === "book"),
    ).toHaveLength(1);
    expect(
      state.availability.slots.some((slot) => slot.time === "10:00 AM"),
    ).toBe(true);
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
});
