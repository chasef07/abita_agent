import { objectSchema } from "./support/tool-schema.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSchedulingTools } from "../scheduling/tools.js";
import {
  addCalendarDays,
  clinicIsoDate,
  clinicTimestampMessage,
} from "../scheduling/clock.js";
import type { AvailabilityResult } from "../clients/owned-middleware.js";
import { createConfirmedPatientState } from "./support/call-state.js";
import { createToolContext } from "./support/tool-context.js";
import { InMemorySchedulingMiddleware } from "./support/scheduling-middleware.js";
import { deferredResult } from "./support/deferred-result.js";
import { clearAvailabilitySelection } from "../scheduling/availability.js";

function inventory(count = 4, startDate = "2026-09-06"): AvailabilityResult {
  const date = addCalendarDays(startDate, 4);
  return {
    status: "found",
    dateShifted: false,
    shouldRetrySameSearch: false,
    searchedFrom: startDate,
    searchedThrough: addCalendarDays(startDate, 13),
    bookingTokenExpiresAt: "2026-09-05T16:15:00Z",
    slots: Array.from({ length: count }, (_, i) => ({
      key: `${date}-provider-12-slot-${i}`,
      provider: "Dr. Smith",
      date,
      time: `${i + 1}:15 PM`,
      datetime: `${date}T${i + 13}:15:00`,
      bookingToken: `private-token-${i}`,
    })),
  };
}
function context() {
  const state = createConfirmedPatientState();
  return {
    state,
    options: { ctx: createToolContext(state), toolCallId: "test" } as never,
  };
}

describe("conversational appointment inventory", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-05T16:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("accepts a start date and rejects the removed range options", () => {
    const schema = objectSchema(
      createSchedulingTools(new InMemorySchedulingMiddleware())
        .list_available_appointments.parameters,
    );
    expect(
      schema.safeParse({ visitType: "medical", startDate: "2026-11-02" })
        .success,
    ).toBe(true);
    expect(
      schema.safeParse({ visitType: "medical", startDate: "2026-02-30" })
        .success,
    ).toBe(false);
    for (const range of ["default", "+2week", "+1month", "+3month"]) {
      expect(schema.safeParse({ visitType: "medical", range }).success).toBe(
        false,
      );
    }
  });

  it.each([undefined, null, "2026-11-02"])(
    "loads one 14-day window starting at %s",
    async (startDate) => {
      const middleware = new InMemorySchedulingMiddleware({
        availability: [inventory(4, startDate ?? undefined)],
      });
      const tool =
        createSchedulingTools(middleware).list_available_appointments;
      const { options } = context();
      await tool.execute({ startDate, visitType: "medical" } as never, options);
      expect(middleware.operations).toHaveLength(1);
      expect(middleware.operations[0]).toMatchObject({
        kind: "availability",
        request: { rangeDays: 14, startDate: startDate ?? "2026-09-06" },
      });
    },
  );

  it("loads all choices once and books an earlier choice by its private reference", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      availability: [inventory()],
      bookings: [
        {
          status: "booked",
          appointmentId: 1234,
          providerName: "Dr. Smith",
          locationName: "Spring Hill",
          appointmentTypeName: "Medical",
          message: null,
        },
      ],
    });
    const tools = createSchedulingTools(middleware);
    const { state, options } = context();
    const result = await tools.list_available_appointments.execute(
      { visitType: "medical" } as never,
      options,
    );
    // These are the actual tool-result choices retained in conversation history.
    for (let i = 1; i <= 4; i++)
      expect(result).toContain(`S${i} — Thursday, September 10 at ${i}:15 PM`);
    expect(result).not.toMatch(/private-token|provider-12-slot/);
    expect(state.availability.slots).toHaveLength(4);
    // Even if the model redundantly calls the listing tool, no second provider read.
    const repeated = await tools.list_available_appointments.execute(
      { visitType: "medical" } as never,
      options,
    );
    expect(repeated).toBe(result);
    await tools.book_appointment.execute(
      {
        appointmentSlotRef: "S3",
        appointmentReason: "left eye pain since yesterday",
        referringDoctor: "none",
        hospitalName: null,
        hospitalDate: null,
        readBack: true,
      },
      options,
    );
    expect(middleware.operations.map((op) => op.kind)).toEqual([
      "availability",
      "book",
    ]);
    expect(middleware.operations[1]).toMatchObject({
      request: { bookingToken: "private-token-2" },
    });
  });

  it("moves between explicit windows and reuses the loaded window for repeated preferences", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      availability: [inventory(2), inventory(4, "2026-09-20")],
    });
    const tool = createSchedulingTools(middleware).list_available_appointments;
    const { state, options } = context();
    await tool.execute({ visitType: "medical" } as never, options);
    await tool.execute(
      { visitType: "medical", startDate: "2026-09-20" } as never,
      options,
    );
    await tool.execute(
      { visitType: "medical", startDate: "2026-09-20" } as never,
      options,
    );
    expect(middleware.operations).toHaveLength(2);
    expect(middleware.operations[1]).toMatchObject({
      request: { rangeDays: 14, startDate: "2026-09-20" },
    });
    expect(state.availability.requestedStartDate).toBe("2026-09-20");
    // Omission returns to the initial window; it never inherits a broader range.
    await tool.execute({ visitType: "medical" } as never, options);
    expect(middleware.operations).toHaveLength(2);
    expect(state.availability.requestedStartDate).toBe("2026-09-06");
    expect(state.availability.slots).toHaveLength(2);
  });

  it("treats explicit tomorrow and omitted startDate as the same cached window", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      availability: [inventory()],
    });
    const tool = createSchedulingTools(middleware).list_available_appointments;
    const { options } = context();
    await tool.execute({ visitType: "medical" } as never, options);
    await tool.execute(
      { visitType: "medical", startDate: "2026-09-06" } as never,
      options,
    );
    expect(middleware.operations).toHaveLength(1);
  });

  it("does not let a late response for a previous window replace the newly requested window", async () => {
    const pending = deferredResult<AvailabilityResult>();
    const middleware = new InMemorySchedulingMiddleware({
      availability: [pending.promise, inventory(4, "2026-09-20")],
    });
    const tool = createSchedulingTools(middleware).list_available_appointments;
    const { state, options } = context();
    const first = tool.execute({ visitType: "medical" } as never, options);
    await Promise.resolve();
    await tool.execute(
      { visitType: "medical", startDate: "2026-09-20" } as never,
      options,
    );
    pending.resolve(inventory(2));
    await first;
    expect(state.availability.slots).toHaveLength(4);
    expect(state.availability.requestedStartDate).toBe("2026-09-20");
  });

  it("refreshes a complete empty inventory instead of caching it forever", async () => {
    const empty: AvailabilityResult = {
      status: "none",
      slots: [],
      dateShifted: false,
      shouldRetrySameSearch: false,
    };
    const middleware = new InMemorySchedulingMiddleware({
      availability: [empty, inventory()],
    });
    const tool = createSchedulingTools(middleware).list_available_appointments;
    const { state, options } = context();
    await tool.execute({ visitType: "medical" } as never, options);
    vi.advanceTimersByTime(60_001);
    await tool.execute({ visitType: "medical" } as never, options);
    expect(middleware.operations).toHaveLength(2);
    expect(state.availability.slots).toHaveLength(4);
  });

  it.each(["found", "none"] as const)(
    "does not extend %s freshness when replaying cached results",
    async (status) => {
      const first =
        status === "found"
          ? inventory()
          : ({
              status: "none",
              slots: [],
              dateShifted: false,
              shouldRetrySameSearch: false,
            } as AvailabilityResult);
      const middleware = new InMemorySchedulingMiddleware({
        availability: [first, inventory()],
      });
      const tool =
        createSchedulingTools(middleware).list_available_appointments;
      const { options } = context();
      await tool.execute({ visitType: "medical" } as never, options);
      for (let i = 0; i < 2; i++) {
        vi.advanceTimersByTime(20_000);
        await tool.execute({ visitType: "medical" } as never, options);
        expect(middleware.operations).toHaveLength(1);
      }
      vi.advanceTimersByTime(20_001);
      await tool.execute({ visitType: "medical" } as never, options);
      expect(middleware.operations).toHaveLength(2);
    },
  );

  it.each(["found", "none"] as const)(
    "keeps an incomplete new window unknown after a fresh %s inventory",
    async (status) => {
      const first: AvailabilityResult =
        status === "found"
          ? inventory()
          : {
              status: "none",
              slots: [],
              dateShifted: false,
              shouldRetrySameSearch: false,
            };
      const incomplete: AvailabilityResult = {
        status: "incomplete",
        slots: [],
        dateShifted: false,
        shouldRetrySameSearch: true,
        searchedFrom: "2026-09-20",
        searchedThrough: "2026-10-03",
      };
      const middleware = new InMemorySchedulingMiddleware({
        availability: [first, incomplete, inventory(4, "2026-09-20")],
      });
      const tool =
        createSchedulingTools(middleware).list_available_appointments;
      const { state, options } = context();
      await tool.execute(
        {
          startDate: null,
          visitType: "medical",
        },
        options,
      );
      vi.advanceTimersByTime(10_000);
      const result = await tool.execute(
        { startDate: "2026-09-20", visitType: "medical" },
        options,
      );
      expect(result).toContain("couldn't finish checking availability");
      expect(state.availability.slots).toEqual([]);
      expect(result).not.toContain("no openings");
      await tool.execute(
        { startDate: "2026-09-20", visitType: "medical" },
        options,
      );
      expect(middleware.operations).toHaveLength(3);
      expect(state.availability.slots).toHaveLength(4);
    },
  );

  it("refreshes stale inventory, preserving IDs for identical slots", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      availability: [inventory(), inventory()],
    });
    const tool = createSchedulingTools(middleware).list_available_appointments;
    const { state, options } = context();
    await tool.execute({ visitType: "medical" } as never, options);
    const ids = state.availability.slots.map((slot) => slot.slotId);
    vi.advanceTimersByTime(60_001);
    await tool.execute({ visitType: "medical" } as never, options);
    expect(middleware.operations).toHaveLength(2);
    expect(state.availability.slots.map((slot) => slot.slotId)).toEqual(ids);
  });

  it("does not reuse a future window after scheduling context resets", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      availability: [inventory(), inventory()],
    });
    const tool = createSchedulingTools(middleware).list_available_appointments;
    const { state, options } = context();
    await tool.execute(
      { visitType: "medical", startDate: "2026-11-02" } as never,
      options,
    );
    clearAvailabilitySelection(state, {
      invalidateReads: true,
    });
    await tool.execute({ visitType: "medical" } as never, options);
    expect(middleware.operations[1]).toMatchObject({
      request: { rangeDays: 14, startDate: "2026-09-06" },
    });
    expect(state.availability.slots[0]?.slotId).not.toBe("S1");
  });

  it("keeps distinct backend slots distinct even with identical public provider/time labels", async () => {
    const response = inventory(2);
    if (response.status !== "found") throw Error("fixture");
    response.slots[1] = {
      ...response.slots[0]!,
      key: "different-resource",
      bookingToken: "second-resource-token",
    };
    const middleware = new InMemorySchedulingMiddleware({
      availability: [response],
    });
    const { state, options } = context();
    await createSchedulingTools(middleware).list_available_appointments.execute(
      { visitType: "medical" } as never,
      options,
    );
    expect(state.availability.slots.map((slot) => slot.slotId)).toEqual([
      "S1",
      "S2",
    ]);
    expect(state.availability.bookingTokensBySlotId).toEqual({
      S1: "private-token-0",
      S2: "second-resource-token",
    });
  });

  it("keeps the clock in Eastern across midnight and daylight saving", () => {
    expect(clinicIsoDate(new Date("2026-09-06T03:59:00Z"))).toBe("2026-09-05");
    expect(clinicIsoDate(new Date("2026-09-06T04:00:00Z"))).toBe("2026-09-06");
    expect(clinicTimestampMessage(new Date("2026-11-01T06:30:00Z"))).toContain(
      "1:30 AM Eastern",
    );
  });
});
