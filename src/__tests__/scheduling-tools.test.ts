import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  HOLLYWOOD_OFFICE_PHONE,
  SPRING_HILL_OFFICE_PHONE,
  SWEETWATER_OFFICE_PHONE,
} from "../customers/abita/profile.js";
import {
  HttpOwnedMiddleware,
  setOwnedMiddleware,
} from "../clients/owned-middleware.js";
import type { AvailabilityResult } from "../scheduling/middleware.js";
import { productionSchedulingMiddleware } from "../scheduling/middleware.js";
import { createSchedulingTools } from "../scheduling/tools.js";
import {
  appointmentActions,
  availabilityReadEvents,
  ownedMiddlewareFailures,
} from "../state/observability.js";
import { storeAvailabilityBookingToken } from "../scheduling/state.js";
import { applyPatientResult } from "../identity/promotion.js";
import type {
  CallerAppointment,
  StoredAvailabilitySlot,
} from "../state/call-state.js";
import { createConfirmedPatientState } from "./support/call-state.js";
import { deferredResult } from "./support/deferred-result.js";
import { InMemorySchedulingMiddleware } from "./support/scheduling-middleware.js";
import { createToolContext } from "./support/tool-context.js";

function createState() {
  return createConfirmedPatientState();
}

function createHollywoodSweetwaterState(office: "hollywood" | "sweetwater") {
  const state = createState();
  const officePhone =
    office === "hollywood" ? HOLLYWOOD_OFFICE_PHONE : SWEETWATER_OFFICE_PHONE;
  state.office.activeKey = office;
  state.office.phoneOverrides[office] = officePhone;
  state.runtime.trunkPhone = officePhone;
  return state;
}

function availabilitySlot(
  overrides: Partial<StoredAvailabilitySlot> = {},
): StoredAvailabilitySlot {
  return {
    slotId: "S1",
    spoken: "2026-06-01 9:00 AM with Dr. Bach",
    provider: "Dr. Bach",
    date: "2026-06-01",
    time: "9:00 AM",
    datetime: "2026-06-01T09:00:00",
    routing: "all_three",
    ...overrides,
  };
}

function loadedAppointment(
  overrides: Partial<CallerAppointment> = {},
): CallerAppointment {
  return {
    id: 123,
    date: "Monday, June 1, 2026",
    time: "9:00 AM",
    provider: "Dr. Licht",
    type: "Follow-up",
    appointmentTypeId: 1005,
    facility: "Spring Hill",
    confirmed: true,
    ...overrides,
  };
}

function prepareBooking(
  state: ReturnType<typeof createState>,
  slot: StoredAvailabilitySlot = availabilitySlot(),
  token = "private-token",
) {
  state.workflow.current = {
    intent: "schedule",
    appointmentLane: "medical_md",
  };
  state.availability.slots = [slot];
  storeAvailabilityBookingToken(state, slot.slotId, token);
}

function prepareReschedule(
  state: ReturnType<typeof createState>,
  options: {
    appointment?: CallerAppointment;
    slot?: StoredAvailabilitySlot;
    token?: string;
  } = {},
) {
  state.workflow.current = {
    intent: "change_appointment",
    appointmentLane: "not_applicable",
  };
  state.identity.patient.appointments = [
    options.appointment ?? loadedAppointment(),
  ];
  const slot = options.slot ?? availabilitySlot();
  state.availability.slots = [slot];
  storeAvailabilityBookingToken(
    state,
    slot.slotId,
    options.token ?? "private-token",
  );
}

function bookingReceipt(overrides: Record<string, unknown> = {}) {
  return {
    status: "booked",
    appointmentId: 456,
    providerName: "Dr. Bach",
    locationName: "Spring Hill",
    appointmentTypeName: "Medical",
    message: null,
    ...overrides,
  };
}

function availabilityFound(
  slots: Record<string, unknown>[],
  overrides: Record<string, unknown> = {},
) {
  return {
    status: "found",
    requestedDate: "2026-06-01",
    actualDate: "2026-06-01",
    searchedFrom: "2026-06-01",
    searchedThrough: "2026-06-01",
    bookingTokenExpiresAt: "2026-05-30T16:15:00Z",
    dateShifted: false,
    shouldRetrySameSearch: false,
    slots,
    ...overrides,
  };
}

function returnedSlot(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    provider: "Dr. Austin Bach",
    date: "2026-06-01",
    time: "9:00 AM",
    datetime: "2026-06-01T09:00:00",
    bookingToken: "private-token",
    ...overrides,
  };
}

function switchActivePatient(
  state: ReturnType<typeof createState>,
  appointments: CallerAppointment[] = [],
) {
  applyPatientResult(state, {
    status: "verified",
    patientId: "patient-2",
    name: "John Doe",
    dob: "02/02/1982",
    phone: "+17275550102",
    appointments,
    appointmentsStatus: appointments.length > 0 ? "found" : "none",
    insuranceCarrier: "self pay",
    insPlanId: null,
    respPartyId: null,
    routing: "all_three",
    allowedProviders: [],
    routingAmbiguous: false,
    preauthRequired: false,
  });
}

function restoreFirstPatient(
  state: ReturnType<typeof createState>,
  appointments: CallerAppointment[] = [],
) {
  applyPatientResult(state, {
    status: "verified",
    patientId: "patient-1",
    name: "Jane Doe",
    dob: "01/01/1980",
    phone: "+17275550101",
    appointments,
    appointmentsStatus: appointments.length > 0 ? "found" : "none",
    insuranceCarrier: "self pay",
    insPlanId: null,
    respPartyId: null,
    routing: "all_three",
    allowedProviders: [],
    routingAmbiguous: false,
    preauthRequired: false,
  });
}

function loadedAppointmentRef(
  state: ReturnType<typeof createState>,
  index = 0,
): string {
  const appointmentRef =
    state.identity.patient.appointments[index]?.appointmentRef;
  if (!appointmentRef) throw new Error("Expected a loaded appointmentRef.");
  return appointmentRef;
}

describe("scheduling tools", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-30T16:00:00.000Z"));
  });

  afterEach(() => {
    setOwnedMiddleware(undefined);
    vi.useRealTimers();
  });

  it("rejects concurrent duplicate scheduling writes", () => {
    const tools = createSchedulingTools(new InMemorySchedulingMiddleware());

    expect(tools.book_appointment.onDuplicate).toBe("reject");
    expect(tools.cancel_appointment.onDuplicate).toBe("reject");
    expect(tools.reschedule_appointment.onDuplicate).toBe("reject");
  });

  it.each([
    ["medical", "medical_md"],
    ["routine_vision", "routine_od"],
  ] as const)(
    "maps the model-facing %s visit type to the internal scheduling lane",
    async (visitType, appointmentLane) => {
      const middleware = new InMemorySchedulingMiddleware({
        availability: [availabilityFound([returnedSlot()])],
      });
      const { get_availability } = createSchedulingTools(middleware);
      const state = createState();

      await get_availability.execute({ when: "2026-06-01", visitType }, {
        ctx: createToolContext(state) as never,
        toolCallId: "availability-1",
      } as never);

      expect(state.workflow.current).toEqual({
        intent: "schedule",
        appointmentLane,
      });
      expect(middleware.operations).toHaveLength(1);
    },
  );

  it("blocks availability and booking for a partially registered patient", async () => {
    const middleware = new InMemorySchedulingMiddleware();
    const { book_appointment, get_availability } =
      createSchedulingTools(middleware);
    const state = createState();
    state.identity.patient.status = "created";
    state.insurance.onFile = null;
    prepareBooking(state);
    const message =
      "The patient chart exists, but insurance is not attached. Connect the caller to office staff to finish registration before scheduling.";

    const availabilityResult = await get_availability.execute(
      { when: "2026-06-01", visitType: "medical" },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "availability-1",
      } as never,
    );
    const bookingResult = await book_appointment.execute(
      {
        appointmentSlotRef: "S1",
        appointmentReason: "left eye pain since yesterday",
        referringDoctor: "none",
        readBack: true,
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "booking-1",
      } as never,
    );

    expect(availabilityResult).toBe(message);
    expect(bookingResult).toBe(message);
    expect(middleware.operations).toEqual([]);
  });

  it.each(["hollywood", "sweetwater"] as const)(
    "asks %s callers which office they want before searching availability",
    async (office) => {
      const middleware = new InMemorySchedulingMiddleware();
      const { get_availability } = createSchedulingTools(middleware);
      const state = createHollywoodSweetwaterState(office);

      const result = await get_availability.execute(
        {
          when: "2026-06-01",
          visitType: "medical",
        },
        {
          ctx: createToolContext(state) as never,
          toolCallId: "tool-1",
        } as never,
      );

      expect(result).toBe(
        "Ask whether the caller wants the Hollywood or Sweetwater office, then check availability again with that office.",
      );
      expect(middleware.operations).toEqual([]);
    },
  );

  it("searches the Hollywood schedule when a Sweetwater caller chooses Hollywood", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      availability: [availabilityFound([returnedSlot({ time: "10:00 AM" })])],
    });
    const { get_availability } = createSchedulingTools(middleware);
    const state = createHollywoodSweetwaterState("sweetwater");

    await get_availability.execute(
      {
        when: "2026-06-01",
        visitType: "medical",
        office: "hollywood",
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    );

    expect(state.office.activeKey).toBe("hollywood");
    expect(middleware.operations).toEqual([
      expect.objectContaining({
        kind: "availability",
        office: HOLLYWOOD_OFFICE_PHONE,
      }),
    ]);
    expect(state.availability.slots).toEqual([
      expect.objectContaining({
        slotId: "S1",
        time: "10:00 AM",
      }),
    ]);
  });

  it("offers only returned availability while keeping booking tokens private", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      availability: [
        {
          status: "found",
          requestedDate: "2026-06-01",
          actualDate: "2026-06-01",
          searchedFrom: "2026-06-01",
          searchedThrough: "2026-06-01",
          dateShifted: false,
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
        },
      ],
    });
    const { get_availability } = createSchedulingTools(middleware);
    const state = createState();

    const result = await get_availability.execute(
      {
        when: "2026-06-01",
        visitType: "medical",
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "availability-1",
      } as never,
    );

    expect(result).toBe(
      "Offer this slot: Monday, June 1 at 9:00 AM with Dr. Bach (appointmentSlotRef S1). If the caller accepts it, use appointmentSlotRef S1; if they want a different day or time, ask for another preference and call get_availability with the caller's new when phrase.",
    );
    expect(result).not.toContain("private-token");
    expect(state.availability.bookingTokensBySlotId).toEqual({
      S1: "private-token",
    });
    expect(middleware.operations).toEqual([
      {
        kind: "availability",
        office: "+17275919997",
        request: {
          dob: "01/01/1980",
          requestedDate: "2026-06-01",
          routing: "all_three",
        },
      },
    ]);
  });

  it("collapses duplicate choices and retains one valid private booking token", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      availability: [
        availabilityFound([
          returnedSlot({ bookingToken: "retained-token" }),
          returnedSlot({ bookingToken: "duplicate-token" }),
        ]),
      ],
      bookings: [bookingReceipt()],
    });
    const { book_appointment, get_availability } =
      createSchedulingTools(middleware);
    const state = createState();
    const ctx = createToolContext(state);

    const availability = await get_availability.execute(
      { when: "2026-06-01", visitType: "medical" },
      {
        ctx: ctx as never,
        toolCallId: "availability-1",
      } as never,
    );
    expect(state.availability.slots).toHaveLength(1);
    await book_appointment.execute(
      {
        appointmentSlotRef: "S1",
        appointmentReason: "left eye pain since yesterday",
        referringDoctor: "none",
        readBack: true,
      },
      {
        ctx: ctx as never,
        toolCallId: "booking-1",
      } as never,
    );

    expect(availability).toBe(
      "Offer this slot: Monday, June 1 at 9:00 AM with Dr. Bach (appointmentSlotRef S1). If the caller accepts it, use appointmentSlotRef S1; if they want a different day or time, ask for another preference and call get_availability with the caller's new when phrase.",
    );
    expect(middleware.operations[1]).toMatchObject({
      kind: "book",
      request: { bookingToken: "retained-token" },
    });
  });

  it("joins an identical in-flight availability search", async () => {
    const deferred = deferredResult<ReturnType<typeof availabilityFound>>();
    const middleware = new InMemorySchedulingMiddleware({
      availability: [deferred.promise, deferred.promise],
    });
    const { get_availability } = createSchedulingTools(middleware);
    const state = createState();
    const args = {
      when: "2026-06-01",
      visitType: "medical" as const,
    };
    const ctx = createToolContext(state);

    const first = get_availability.execute(args, {
      ctx: ctx as never,
      toolCallId: "availability-1",
    } as never);
    const second = get_availability.execute(args, {
      ctx: ctx as never,
      toolCallId: "availability-2",
    } as never);
    vi.advanceTimersByTime(25);
    deferred.resolve(availabilityFound([returnedSlot()]));

    await expect(Promise.all([first, second])).resolves.toEqual([
      "Offer this slot: Monday, June 1 at 9:00 AM with Dr. Bach (appointmentSlotRef S1). If the caller accepts it, use appointmentSlotRef S1; if they want a different day or time, ask for another preference and call get_availability with the caller's new when phrase.",
      "Offer this slot: Monday, June 1 at 9:00 AM with Dr. Bach (appointmentSlotRef S1). If the caller accepts it, use appointmentSlotRef S1; if they want a different day or time, ask for another preference and call get_availability with the caller's new when phrase.",
    ]);
    expect(middleware.operations).toHaveLength(1);
    expect(availabilityReadEvents(state)).toMatchObject([
      { operation: "middleware_call", durationMs: 25 },
      { operation: "in_flight_join", durationMs: 25 },
    ]);
  });

  it("keeps a settled availability read shared until its result is committed", async () => {
    const result = availabilityFound([returnedSlot()]);
    const middleware = new InMemorySchedulingMiddleware({
      availability: [result, availabilityFound([returnedSlot()])],
    });
    const { get_availability } = createSchedulingTools(middleware);
    const state = createState();
    const ctx = createToolContext(state);
    const args = {
      when: "2026-06-01",
      visitType: "medical" as const,
    };
    let lateOverlap: Promise<string> | undefined;
    Object.defineProperty(result, "status", {
      configurable: true,
      get: () => {
        lateOverlap ??= get_availability.execute(args, {
          ctx: ctx as never,
          toolCallId: "availability-overlap",
        } as never) as Promise<string>;
        return "found";
      },
    });

    const first = await get_availability.execute(args, {
      ctx: ctx as never,
      toolCallId: "availability-owner",
    } as never);
    if (!lateOverlap)
      throw new Error("Expected a late overlapping invocation.");
    const overlap = await lateOverlap;

    expect(overlap).toBe(first);
    expect(middleware.operations).toHaveLength(1);
  });

  it("caches an identical no-availability search", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      availability: [
        {
          status: "none",
          requestedDate: "2026-06-01",
          searchedFrom: "2026-06-01",
          searchedThrough: "2026-06-15",
          dateShifted: false,
          shouldRetrySameSearch: false,
          slots: [],
        },
      ],
    });
    const { get_availability } = createSchedulingTools(middleware);
    const state = createState();
    const args = {
      when: "2026-06-01",
      visitType: "medical" as const,
    };
    const ctx = createToolContext(state);

    const first = await get_availability.execute(args, {
      ctx: ctx as never,
      toolCallId: "availability-1",
    } as never);
    const second = await get_availability.execute(args, {
      ctx: ctx as never,
      toolCallId: "availability-2",
    } as never);

    expect(first).toBe(
      "No openings were found from Monday, June 1 through Monday, June 15. Ask whether the caller has another day or time preference.",
    );
    expect(second).toBe(first);
    expect(middleware.operations).toHaveLength(1);
  });

  it("refreshes an implicit search after clinic midnight and retains the derived date", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      availability: [
        {
          status: "none",
          requestedDate: "2026-05-31",
          searchedFrom: "2026-05-31",
          searchedThrough: "2026-06-14",
          dateShifted: false,
          shouldRetrySameSearch: false,
          slots: [],
        },
        {
          status: "none",
          requestedDate: "2026-06-01",
          searchedFrom: "2026-06-01",
          searchedThrough: "2026-06-15",
          dateShifted: false,
          shouldRetrySameSearch: false,
          slots: [],
        },
        {
          status: "none",
          requestedDate: "2026-06-01",
          searchedFrom: "2026-06-01",
          searchedThrough: "2026-06-15",
          dateShifted: false,
          shouldRetrySameSearch: false,
          slots: [],
        },
      ],
    });
    let beforeMidnight = true;
    const { get_availability } = createSchedulingTools(middleware, {
      now: () => {
        if (beforeMidnight) {
          beforeMidnight = false;
          return new Date("2026-05-31T03:59:00.000Z");
        }
        return new Date("2026-05-31T04:01:00.000Z");
      },
    });
    const state = createState();
    const ctx = createToolContext(state);
    const request = {
      when: "soonest",
      visitType: "medical" as const,
    };

    await get_availability.execute(request, {
      ctx: ctx as never,
      toolCallId: "availability-before-midnight",
    } as never);
    expect(state.availability.currentDate).toBe("2026-05-31");

    await get_availability.execute(request, {
      ctx: ctx as never,
      toolCallId: "availability-after-midnight",
    } as never);
    expect(middleware.operations).toHaveLength(2);
    expect(state.availability.currentDate).toBe("2026-06-01");

    await get_availability.execute({ ...request, when: "10 for that day" }, {
      ctx: ctx as never,
      toolCallId: "availability-that-day",
    } as never);
    expect(middleware.operations[2]).toMatchObject({
      kind: "availability",
      request: {
        requestedDate: "2026-06-01",
        preferredTime: { minuteOfDay: 600 },
      },
    });
  });

  it("asks middleware to rank a changed availability preference", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      availability: [
        availabilityFound([
          returnedSlot({ bookingToken: "morning-token" }),
          returnedSlot({
            provider: "Dr. D. Noel",
            time: "2:00 PM",
            datetime: "2026-06-01T14:00:00",
            bookingToken: "afternoon-token",
          }),
        ]),
        availabilityFound([
          returnedSlot({
            provider: "Dr. D. Noel",
            time: "2:00 PM",
            datetime: "2026-06-01T14:00:00",
            bookingToken: "afternoon-token",
          }),
        ]),
      ],
    });
    const { get_availability } = createSchedulingTools(middleware);
    const state = createState();
    const ctx = createToolContext(state);
    const request = {
      when: "2026-06-01",
      visitType: "medical" as const,
    };

    const first = await get_availability.execute(request, {
      ctx: ctx as never,
      toolCallId: "availability-1",
    } as never);
    const afternoon = await get_availability.execute(
      { ...request, when: "2026-06-01 afternoon" },
      {
        ctx: ctx as never,
        toolCallId: "availability-2",
      } as never,
    );

    expect(first).toContain("appointmentSlotRef S1");
    expect(first).toContain("appointmentSlotRef S2");
    expect(afternoon).toBe(
      "Offer this slot: Monday, June 1 at 2:00 PM with Dr. Noel (appointmentSlotRef S2). If the caller accepts it, use appointmentSlotRef S2; if they want a different day or time, ask for another preference and call get_availability with the caller's new when phrase.",
    );
    expect(middleware.operations).toHaveLength(2);
    expect(middleware.operations[1]).toMatchObject({
      kind: "availability",
      request: {
        requestedDate: "2026-06-01",
        preferredTime: { kind: "afternoon" },
      },
    });
    expect(state.availability.bookingTokensBySlotId).toEqual({
      S2: "afternoon-token",
    });
    expect(availabilityReadEvents(state)).toMatchObject([
      { operation: "middleware_call", durationMs: 0 },
      { operation: "middleware_call", durationMs: 0 },
    ]);
    expect(JSON.stringify(availabilityReadEvents(state))).not.toMatch(
      /patient-1|01\/01\/1980|2026-06-01|morning-token|afternoon-token|all_three/,
    );
  });

  it("books an exact slot from a fresh preference search", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      availability: [
        availabilityFound(
          [
            returnedSlot({
              time: "8:00 AM",
              datetime: "2026-06-01T08:00:00",
              bookingToken: "early-token",
            }),
            returnedSlot({
              provider: "Dr. D. Noel",
              time: "1:00 PM",
              datetime: "2026-06-01T13:00:00",
              bookingToken: "afternoon-token",
            }),
          ],
          {
            bookingTokenExpiresAt: "2026-05-30T16:15:00Z",
          },
        ),
        availabilityFound([returnedSlot({ bookingToken: "exact-token" })], {
          bookingTokenExpiresAt: "2026-05-30T16:15:00Z",
        }),
      ],
      bookings: [bookingReceipt()],
    });
    const { book_appointment, get_availability } =
      createSchedulingTools(middleware);
    const state = createState();
    const ctx = createToolContext(state);
    const initialArgs = {
      when: "2026-06-01",
      visitType: "medical" as const,
    };

    const initial = await get_availability.execute(initialArgs, {
      ctx: ctx as never,
      toolCallId: "availability-1",
    } as never);
    const exact = await get_availability.execute(
      { ...initialArgs, when: "2026-06-01 at 9:00 AM" },
      {
        ctx: ctx as never,
        toolCallId: "availability-2",
      } as never,
    );
    await book_appointment.execute(
      {
        appointmentSlotRef: "S3",
        appointmentReason: "left eye pain since yesterday",
        referringDoctor: "none",
        readBack: true,
      },
      {
        ctx: ctx as never,
        toolCallId: "booking-1",
      } as never,
    );

    expect(initial).toContain("appointmentSlotRef S1");
    expect(initial).toContain("appointmentSlotRef S2");
    expect(initial).not.toContain("appointmentSlotRef S3");
    expect(exact).toContain("9:00 AM");
    expect(exact).toContain("appointmentSlotRef S3");
    expect(
      middleware.operations.filter(
        (operation) => operation.kind === "availability",
      ),
    ).toHaveLength(2);
    expect(middleware.operations.at(-1)).toMatchObject({
      kind: "book",
      request: { bookingToken: "exact-token" },
    });
    expect(`${initial} ${exact}`).not.toMatch(
      /early-token|exact-token|afternoon-token/,
    );
  });

  it("refreshes availability when the middleware booking-token validity expires", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      availability: [
        availabilityFound([returnedSlot()], {
          bookingTokenExpiresAt: "2026-05-30T16:15:00Z",
        }),
        availabilityFound(
          [
            returnedSlot({
              time: "10:00 AM",
              datetime: "2026-06-01T10:00:00",
              bookingToken: "refreshed-token",
            }),
          ],
          {
            bookingTokenExpiresAt: "2026-05-30T16:30:00Z",
          },
        ),
      ],
    });
    const { get_availability } = createSchedulingTools(middleware);
    const state = createState();
    const ctx = createToolContext(state);
    const args = {
      when: "2026-06-01",
      visitType: "medical" as const,
    };

    const initial = await get_availability.execute(args, {
      ctx: ctx as never,
      toolCallId: "availability-1",
    } as never);
    vi.setSystemTime(new Date("2026-05-30T16:15:00.000Z"));
    const refreshed = await get_availability.execute(args, {
      ctx: ctx as never,
      toolCallId: "availability-2",
    } as never);

    expect(initial).toContain("9:00 AM");
    expect(refreshed).toContain("10:00 AM");
    expect(
      middleware.operations.filter(
        (operation) => operation.kind === "availability",
      ),
    ).toHaveLength(2);
    expect(state.availability.bookingTokensBySlotId).toEqual({
      S2: "refreshed-token",
    });
  });

  it("refreshes a fresh result that arrives after its booking token expires", async () => {
    const expiredResult = deferredResult<AvailabilityResult>();
    const middleware = new InMemorySchedulingMiddleware({
      availability: [
        expiredResult.promise,
        availabilityFound(
          [
            returnedSlot({
              time: "10:00 AM",
              datetime: "2026-06-01T10:00:00",
              bookingToken: "refreshed-token",
            }),
          ],
          {
            bookingTokenExpiresAt: "2026-05-30T16:30:00Z",
          },
        ),
      ],
    });
    const { get_availability } = createSchedulingTools(middleware);
    const state = createState();
    const availability = get_availability.execute(
      { when: "2026-06-01", visitType: "medical" },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "availability-1",
      } as never,
    );

    await vi.waitFor(() => {
      expect(
        middleware.operations.filter(
          (operation) => operation.kind === "availability",
        ),
      ).toHaveLength(1);
    });
    vi.setSystemTime(new Date("2026-05-30T16:15:00.000Z"));
    expiredResult.resolve(
      availabilityFound([returnedSlot()], {
        bookingTokenExpiresAt: "2026-05-30T16:15:00Z",
      }) as AvailabilityResult,
    );
    const response = await availability;

    expect(response).toContain("10:00 AM");
    expect(response).not.toContain("9:00 AM");
    expect(
      middleware.operations.filter(
        (operation) => operation.kind === "availability",
      ),
    ).toHaveLength(2);
    expect(state.availability.bookingTokensBySlotId).toEqual({
      S1: "refreshed-token",
    });
  });

  it("single-flights concurrent refreshes of the same fresh expired result", async () => {
    const expiredResult = deferredResult<AvailabilityResult>();
    const middleware = new InMemorySchedulingMiddleware({
      availability: [
        expiredResult.promise,
        availabilityFound(
          [
            returnedSlot({
              time: "10:00 AM",
              datetime: "2026-06-01T10:00:00",
              bookingToken: "refreshed-token",
            }),
          ],
          {
            bookingTokenExpiresAt: "2026-05-30T16:30:00Z",
          },
        ),
      ],
    });
    const { get_availability } = createSchedulingTools(middleware);
    const state = createState();
    const ctx = createToolContext(state);
    const lookup = (toolCallId: string) =>
      get_availability.execute({ when: "2026-06-01", visitType: "medical" }, {
        ctx: ctx as never,
        toolCallId,
      } as never);

    const first = lookup("availability-1");
    const second = lookup("availability-2");
    await vi.waitFor(() => {
      expect(
        middleware.operations.filter(
          (operation) => operation.kind === "availability",
        ),
      ).toHaveLength(1);
    });
    vi.setSystemTime(new Date("2026-05-30T16:15:00.000Z"));
    expiredResult.resolve(
      availabilityFound([returnedSlot()], {
        bookingTokenExpiresAt: "2026-05-30T16:15:00Z",
      }) as AvailabilityResult,
    );
    const responses = await Promise.all([first, second]);

    expect(responses).toEqual([
      expect.stringContaining("10:00 AM"),
      expect.stringContaining("10:00 AM"),
    ]);
    expect(
      middleware.operations.filter(
        (operation) => operation.kind === "availability",
      ),
    ).toHaveLength(2);
  });

  it("stores and offers nothing when a fresh result expires twice", async () => {
    const expired = availabilityFound([returnedSlot()], {
      bookingTokenExpiresAt: "2026-05-30T16:15:00Z",
    });
    const middleware = new InMemorySchedulingMiddleware({
      availability: [expired, expired],
    });
    const { get_availability } = createSchedulingTools(middleware);
    const state = createState();

    vi.setSystemTime(new Date("2026-05-30T16:15:00.000Z"));
    const response = await get_availability.execute(
      { when: "2026-06-01", visitType: "medical" },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "availability-1",
      } as never,
    );

    expect(response).toBe(
      "Availability expired before it could be offered. Check availability again.",
    );
    expect(
      middleware.operations.filter(
        (operation) => operation.kind === "availability",
      ),
    ).toHaveLength(2);
    expect(state.availability.slots).toEqual([]);
    expect(state.availability.bookingTokensBySlotId).toEqual({});
    expect(availabilityReadEvents(state)).toMatchObject([
      { operation: "middleware_call" },
      { operation: "invalidation", reason: "booking_token_expired" },
      { operation: "middleware_call" },
      { operation: "invalidation", reason: "booking_token_expired" },
    ]);
  });

  it("refreshes other completed dates after one cached token validity expires", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      availability: [
        availabilityFound([returnedSlot()], {
          bookingTokenExpiresAt: "2026-05-30T16:15:00Z",
        }),
        availabilityFound(
          [
            returnedSlot({
              date: "2026-06-02",
              time: "10:00 AM",
              datetime: "2026-06-02T10:00:00",
              bookingToken: "later-date-token",
            }),
          ],
          {
            requestedDate: "2026-06-02",
            actualDate: "2026-06-02",
            searchedFrom: "2026-06-02",
            searchedThrough: "2026-06-02",
            bookingTokenExpiresAt: "2026-05-30T16:30:00Z",
          },
        ),
        availabilityFound(
          [
            returnedSlot({
              time: "11:00 AM",
              datetime: "2026-06-01T11:00:00",
              bookingToken: "refreshed-first-date-token",
            }),
          ],
          {
            bookingTokenExpiresAt: "2026-05-30T16:30:00Z",
          },
        ),
        availabilityFound(
          [
            returnedSlot({
              date: "2026-06-02",
              time: "12:00 PM",
              datetime: "2026-06-02T12:00:00",
              bookingToken: "refreshed-later-date-token",
            }),
          ],
          {
            requestedDate: "2026-06-02",
            actualDate: "2026-06-02",
            searchedFrom: "2026-06-02",
            searchedThrough: "2026-06-02",
            bookingTokenExpiresAt: "2026-05-30T16:30:00Z",
          },
        ),
      ],
    });
    const { get_availability } = createSchedulingTools(middleware);
    const state = createState();
    const ctx = createToolContext(state);
    const lookup = (when: string, toolCallId: string) =>
      get_availability.execute({ when, visitType: "medical" }, {
        ctx: ctx as never,
        toolCallId,
      } as never);

    await lookup("2026-06-01", "availability-1");
    await lookup("2026-06-02", "availability-2");
    vi.setSystemTime(new Date("2026-05-30T16:15:00.000Z"));
    const refreshedFirstDate = await lookup("2026-06-01", "availability-3");
    const refreshedLaterDate = await lookup("2026-06-02", "availability-4");

    expect(refreshedFirstDate).toContain("11:00 AM");
    expect(refreshedLaterDate).toContain("12:00 PM");
    expect(
      middleware.operations.filter(
        (operation) => operation.kind === "availability",
      ),
    ).toHaveLength(4);
  });

  it("rejects direct booking after the selected token validity expires", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      availability: [
        availabilityFound([returnedSlot()], {
          bookingTokenExpiresAt: "2026-05-30T16:15:00Z",
        }),
      ],
      bookings: [bookingReceipt()],
    });
    const { book_appointment, get_availability } =
      createSchedulingTools(middleware);
    const state = createState();
    const ctx = createToolContext(state);

    await get_availability.execute(
      { when: "2026-06-01", visitType: "medical" },
      {
        ctx: ctx as never,
        toolCallId: "availability-1",
      } as never,
    );
    vi.setSystemTime(new Date("2026-05-30T16:15:00.000Z"));

    await expect(
      book_appointment.execute(
        {
          appointmentSlotRef: "S1",
          appointmentReason: "left eye pain since yesterday",
          referringDoctor: "none",
          readBack: true,
        },
        {
          ctx: ctx as never,
          toolCallId: "booking-1",
        } as never,
      ),
    ).resolves.toBe(
      "Search availability again before booking because the selected slot expired.",
    );
    expect(middleware.operations).toEqual([
      expect.objectContaining({ kind: "availability" }),
    ]);
    expect(state.availability.slots).toEqual([]);
    expect(state.availability.bookingTokensBySlotId).toEqual({});
  });

  it.each([
    {
      name: "patient context generation",
      change: (state: ReturnType<typeof createState>) => {
        state.identity.transitionVersion += 1;
        return {};
      },
    },
    {
      name: "patient identity",
      change: (state: ReturnType<typeof createState>) => {
        state.identity.patient.patientId = "patient-2";
        return {};
      },
    },
    {
      name: "requested date",
      change: () => ({ when: "2026-06-02" }),
    },
    {
      name: "date of birth",
      change: (state: ReturnType<typeof createState>) => {
        state.identity.patient.dob = "02/02/1982";
        return {};
      },
    },
    {
      name: "provider office",
      change: (state: ReturnType<typeof createState>) => {
        state.office.phoneOverrides["spring-hill"] = "+17275550199";
        return {};
      },
    },
    {
      name: "routing",
      change: (state: ReturnType<typeof createState>) => {
        state.workflow.routing.routing = "bach_only";
        return {};
      },
    },
    {
      name: "preauthorization",
      change: (state: ReturnType<typeof createState>) => {
        state.workflow.routing.preauthRequired = true;
        return {};
      },
    },
    {
      name: "visit type",
      change: () => ({ visitType: "routine_vision" as const }),
    },
  ])(
    "performs a fresh availability read after a $name change",
    async ({ change }) => {
      const middleware = new InMemorySchedulingMiddleware({
        availability: [
          availabilityFound([returnedSlot()]),
          availabilityFound([returnedSlot()]),
        ],
      });
      const { get_availability } = createSchedulingTools(middleware);
      const state = createState();
      const ctx = createToolContext(state);
      const args = {
        when: "2026-06-01",
        visitType: "medical" as const,
      };

      await get_availability.execute(args, {
        ctx: ctx as never,
        toolCallId: "availability-1",
      } as never);
      await get_availability.execute({ ...args, ...change(state) }, {
        ctx: ctx as never,
        toolCallId: "availability-2",
      } as never);

      expect(middleware.operations).toHaveLength(2);
    },
  );

  it("performs a fresh availability read after the scheduling intent changes", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      availability: [
        availabilityFound([returnedSlot()]),
        availabilityFound([returnedSlot()]),
      ],
    });
    const { get_availability } = createSchedulingTools(middleware);
    const state = createState();
    state.identity.patient.appointments = [loadedAppointment()];
    const ctx = createToolContext(state);

    await get_availability.execute(
      { when: "2026-06-01", visitType: "medical" },
      {
        ctx: ctx as never,
        toolCallId: "availability-1",
      } as never,
    );
    await get_availability.execute({ when: "2026-06-01" }, {
      ctx: ctx as never,
      toolCallId: "availability-2",
    } as never);

    expect(middleware.operations).toHaveLength(2);
    expect(state.workflow.current?.intent).toBe("change_appointment");
  });

  it("defaults a loaded appointment without a type ID to routine vision", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      availability: [availabilityFound([returnedSlot()])],
    });
    const { get_availability } = createSchedulingTools(middleware);
    const state = createState();
    state.identity.patient.appointments = [
      loadedAppointment({
        appointmentTypeId: undefined,
        type: "Optometry",
      }),
    ];

    await get_availability.execute({ when: "2026-06-01" }, {
      ctx: createToolContext(state) as never,
      toolCallId: "availability-1",
    } as never);

    expect(middleware.operations).toEqual([
      expect.objectContaining({
        kind: "availability",
        request: expect.objectContaining({ routing: "optical_only" }),
      }),
    ]);
  });

  it("defaults an unrecognized loaded appointment type ID to routine vision", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      availability: [availabilityFound([returnedSlot()])],
    });
    const { get_availability } = createSchedulingTools(middleware);
    const state = createState();
    state.identity.patient.appointments = [
      loadedAppointment({
        appointmentTypeId: 9999,
        type: "Medical visit",
      }),
    ];

    await get_availability.execute({ when: "2026-06-01" }, {
      ctx: createToolContext(state) as never,
      toolCallId: "availability-1",
    } as never);

    expect(middleware.operations).toEqual([
      expect.objectContaining({
        kind: "availability",
        request: expect.objectContaining({ routing: "optical_only" }),
      }),
    ]);
  });

  it("keeps a known medical appointment type on medical routing", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      availability: [availabilityFound([returnedSlot()])],
    });
    const { get_availability } = createSchedulingTools(middleware);
    const state = createState();
    state.identity.patient.appointments = [
      loadedAppointment({
        appointmentTypeId: 1005,
        type: "Optometry",
      }),
    ];

    await get_availability.execute({ when: "2026-06-01" }, {
      ctx: createToolContext(state) as never,
      toolCallId: "availability-1",
    } as never);

    expect(middleware.operations).toEqual([
      expect.objectContaining({
        kind: "availability",
        request: expect.not.objectContaining({ routing: "optical_only" }),
      }),
    ]);
  });

  it("uses a structured routine appointment type when rescheduling", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      availability: [availabilityFound([returnedSlot()])],
    });
    const { get_availability } = createSchedulingTools(middleware);
    const state = createState();
    state.identity.patient.appointments = [
      loadedAppointment({
        appointmentTypeId: 1010,
        type: "Medical visit",
      }),
    ];

    await get_availability.execute({ when: "2026-06-01" }, {
      ctx: createToolContext(state) as never,
      toolCallId: "availability-1",
    } as never);

    expect(middleware.operations).toEqual([
      expect.objectContaining({
        kind: "availability",
        request: expect.objectContaining({ routing: "optical_only" }),
      }),
    ]);
  });

  it("performs a fresh availability read after the Office Profile changes", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      availability: [
        availabilityFound([returnedSlot()]),
        availabilityFound([returnedSlot()]),
      ],
    });
    const { get_availability } = createSchedulingTools(middleware);
    const state = createHollywoodSweetwaterState("sweetwater");
    const ctx = createToolContext(state);

    await get_availability.execute(
      {
        when: "2026-06-01",
        visitType: "medical",
        office: "hollywood",
      },
      {
        ctx: ctx as never,
        toolCallId: "availability-1",
      } as never,
    );
    await get_availability.execute(
      {
        when: "2026-06-01",
        visitType: "medical",
        office: "sweetwater",
      },
      {
        ctx: ctx as never,
        toolCallId: "availability-2",
      } as never,
    );

    expect(middleware.operations).toHaveLength(2);
    expect(middleware.operations).toMatchObject([
      { kind: "availability", office: HOLLYWOOD_OFFICE_PHONE },
      { kind: "availability", office: SWEETWATER_OFFICE_PHONE },
    ]);
  });

  it("reuses equivalent normalized availability inputs", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      availability: [availabilityFound([returnedSlot()])],
    });
    const { get_availability } = createSchedulingTools(middleware);
    const state = createState();
    state.identity.patient.patientId = " patient-1 ";
    state.identity.patient.dob = " 01/01/1980 ";
    const ctx = createToolContext(state);

    const first = await get_availability.execute(
      { when: "2026-06-01", visitType: "medical" },
      {
        ctx: ctx as never,
        toolCallId: "availability-1",
      } as never,
    );
    state.identity.patient.patientId = "patient-1";
    state.identity.patient.dob = "01/01/1980";
    const second = await get_availability.execute(
      { when: " 2026-06-01 ", visitType: "medical" },
      {
        ctx: ctx as never,
        toolCallId: "availability-2",
      } as never,
    );

    expect(second).toBe(first);
    expect(middleware.operations).toHaveLength(1);
  });

  it("keeps completed availability isolated to one call", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      availability: [
        availabilityFound([returnedSlot()]),
        availabilityFound([
          returnedSlot({
            time: "10:00 AM",
            datetime: "2026-06-01T10:00:00",
            bookingToken: "second-call-token",
          }),
        ]),
      ],
    });
    const { get_availability } = createSchedulingTools(middleware);
    const firstState = createState();
    const secondState = createState();
    const args = {
      when: "2026-06-01",
      visitType: "medical" as const,
    };

    const first = await get_availability.execute(args, {
      ctx: createToolContext(firstState) as never,
      toolCallId: "first-call-1",
    } as never);
    const firstReplay = await get_availability.execute(args, {
      ctx: createToolContext(firstState) as never,
      toolCallId: "first-call-2",
    } as never);
    const second = await get_availability.execute(args, {
      ctx: createToolContext(secondState) as never,
      toolCallId: "second-call-1",
    } as never);

    expect(firstReplay).toBe(first);
    expect(second).toContain("10:00 AM");
    expect(middleware.operations).toHaveLength(2);
    expect(secondState.availability.bookingTokensBySlotId).toEqual({
      S1: "second-call-token",
    });
  });

  it("preserves stable references across middleware-ranked results", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      availability: [
        availabilityFound([
          returnedSlot({ bookingToken: "morning-token" }),
          returnedSlot({
            provider: "Dr. D. Noel",
            time: "2:00 PM",
            datetime: "2026-06-01T14:00:00",
            bookingToken: "early-afternoon-token",
          }),
          returnedSlot({
            provider: "Dr. J. Licht",
            time: "3:00 PM",
            datetime: "2026-06-01T15:00:00",
            bookingToken: "late-afternoon-token",
          }),
        ]),
        availabilityFound([
          returnedSlot({
            provider: "Dr. D. Noel",
            time: "2:00 PM",
            datetime: "2026-06-01T14:00:00",
            bookingToken: "early-afternoon-token",
          }),
          returnedSlot({
            provider: "Dr. J. Licht",
            time: "3:00 PM",
            datetime: "2026-06-01T15:00:00",
            bookingToken: "late-afternoon-token",
          }),
        ]),
      ],
      bookings: [bookingReceipt()],
    });
    const { book_appointment, get_availability } =
      createSchedulingTools(middleware);
    const state = createState();
    const ctx = createToolContext(state);
    const args = {
      when: "2026-06-01",
      visitType: "medical" as const,
    };

    const initial = await get_availability.execute(args, {
      ctx: ctx as never,
      toolCallId: "availability-1",
    } as never);
    const reranked = await get_availability.execute(
      { ...args, when: "2026-06-01 afternoon" },
      {
        ctx: ctx as never,
        toolCallId: "availability-2",
      } as never,
    );
    await book_appointment.execute(
      {
        appointmentSlotRef: "S3",
        appointmentReason: "left eye pain since yesterday",
        referringDoctor: "none",
        readBack: true,
      },
      {
        ctx: ctx as never,
        toolCallId: "booking-1",
      } as never,
    );

    expect(initial).toContain("appointmentSlotRef S1");
    expect(initial).toContain("appointmentSlotRef S2");
    expect(reranked).toContain("appointmentSlotRef S2");
    expect(reranked).toContain("appointmentSlotRef S3");
    expect(middleware.operations).toHaveLength(3);
    expect(middleware.operations[2]).toMatchObject({
      kind: "book",
      request: { bookingToken: "late-afternoon-token" },
    });
    expect(`${initial} ${reranked}`).not.toMatch(
      /morning-token|early-afternoon-token|late-afternoon-token/,
    );
  });

  it.each([
    {
      name: "retryable found",
      result: availabilityFound([returnedSlot()], {
        shouldRetrySameSearch: true,
      }),
    },
    {
      name: "found without a private booking token",
      result: availabilityFound([returnedSlot({ bookingToken: undefined })]),
    },
    {
      name: "found without middleware booking-token validity",
      result: availabilityFound([returnedSlot()], {
        bookingTokenExpiresAt: undefined,
      }),
    },
    {
      name: "found without slots",
      result: availabilityFound([]),
    },
    {
      name: "none with slots",
      result: availabilityFound([returnedSlot()], { status: "none" }),
    },
  ])("does not cache a $name availability result", async ({ result }) => {
    const middleware = new InMemorySchedulingMiddleware({
      availability: [result, result],
    });
    const { get_availability } = createSchedulingTools(middleware);
    const state = createState();
    const ctx = createToolContext(state);
    const args = {
      when: "2026-06-01",
      visitType: "medical" as const,
    };

    await get_availability.execute(args, {
      ctx: ctx as never,
      toolCallId: "availability-1",
    } as never);
    await get_availability.execute(args, {
      ctx: ctx as never,
      toolCallId: "availability-2",
    } as never);

    expect(middleware.operations).toHaveLength(2);
  });

  it.each([
    {
      name: "rejected",
      error: new Error("controlled transport rejection"),
      message: "controlled transport rejection",
    },
    {
      name: "timed out",
      error: new DOMException("controlled timeout", "TimeoutError"),
      message: "controlled timeout",
    },
  ])(
    "cleans up a $name in-flight search before retrying",
    async ({ error, message }) => {
      const middleware = new InMemorySchedulingMiddleware({
        availability: [error, availabilityFound([returnedSlot()])],
      });
      const { get_availability } = createSchedulingTools(middleware);
      const state = createState();
      const ctx = createToolContext(state);
      const args = {
        when: "2026-06-01",
        visitType: "medical" as const,
      };

      await expect(
        get_availability.execute(args, {
          ctx: ctx as never,
          toolCallId: "availability-1",
        } as never),
      ).rejects.toThrow(message);
      await expect(
        get_availability.execute(args, {
          ctx: ctx as never,
          toolCallId: "availability-2",
        } as never),
      ).resolves.toContain("appointmentSlotRef S1");

      expect(middleware.operations).toHaveLength(2);
    },
  );

  it("discards shared in-flight work when session shutdown aborts the tool", async () => {
    const deferred = deferredResult<ReturnType<typeof availabilityFound>>();
    const middleware = new InMemorySchedulingMiddleware({
      availability: [
        deferred.promise,
        availabilityFound([
          returnedSlot({
            time: "10:00 AM",
            datetime: "2026-06-01T10:00:00",
            bookingToken: "replacement-token",
          }),
        ]),
      ],
    });
    const { get_availability } = createSchedulingTools(middleware);
    const state = createState();
    const ctx = createToolContext(state);
    const controller = new AbortController();
    const args = {
      when: "2026-06-01",
      visitType: "medical" as const,
    };

    const abandoned = get_availability.execute(args, {
      abortSignal: controller.signal,
      ctx: ctx as never,
      toolCallId: "availability-1",
    } as never);
    await Promise.resolve();
    controller.abort();
    const retry = get_availability.execute(args, {
      ctx: ctx as never,
      toolCallId: "availability-2",
    } as never);

    await expect(retry).resolves.toContain("10:00 AM");
    deferred.resolve(availabilityFound([returnedSlot()]));
    await expect(abandoned).resolves.toContain(
      "Availability search was superseded",
    );
    expect(middleware.operations).toHaveLength(2);
    expect(state.availability.slots).toEqual([
      expect.objectContaining({ time: "10:00 AM" }),
    ]);
  });

  it("does not let an aborted waiter cancel the shared availability read", async () => {
    const deferred = deferredResult<ReturnType<typeof availabilityFound>>();
    const middleware = new InMemorySchedulingMiddleware({
      availability: [deferred.promise],
    });
    const { get_availability } = createSchedulingTools(middleware);
    const state = createState();
    const ctx = createToolContext(state);
    const waiterController = new AbortController();
    const args = {
      when: "2026-06-01",
      visitType: "medical" as const,
    };

    const owner = get_availability.execute(args, {
      ctx: ctx as never,
      toolCallId: "availability-owner",
    } as never);
    const waiter = get_availability.execute(args, {
      abortSignal: waiterController.signal,
      ctx: ctx as never,
      toolCallId: "availability-waiter",
    } as never);
    waiterController.abort();
    deferred.resolve(availabilityFound([returnedSlot()]));

    await expect(owner).resolves.toContain("appointmentSlotRef S1");
    await expect(waiter).resolves.toContain(
      "Availability search was superseded",
    );
    expect(middleware.operations).toHaveLength(1);
    expect(state.availability.slots).toEqual([
      expect.objectContaining({ slotId: "S1" }),
    ]);
  });

  it("retries an incomplete availability search instead of caching it", async () => {
    const incomplete = {
      status: "incomplete",
      requestedDate: "2026-06-01",
      searchedFrom: "2026-06-01",
      searchedThrough: "2026-06-02",
      dateShifted: false,
      shouldRetrySameSearch: true,
      slots: [],
    };
    const middleware = new InMemorySchedulingMiddleware({
      availability: [incomplete, incomplete],
    });
    const { get_availability } = createSchedulingTools(middleware);
    const state = createState();
    const args = {
      when: "2026-06-01",
      visitType: "medical" as const,
    };
    const ctx = createToolContext(state);

    const first = await get_availability.execute(args, {
      ctx: ctx as never,
      toolCallId: "availability-1",
    } as never);
    const second = await get_availability.execute(args, {
      ctx: ctx as never,
      toolCallId: "availability-2",
    } as never);

    expect(first).toBe(
      "Availability was not fully checked from Monday, June 1 through Tuesday, June 2. Call get_availability again once with the same when phrase.",
    );
    expect(second).toBe(first);
    expect(middleware.operations).toHaveLength(2);
  });

  it("records a middleware failure without exposing backend details", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      availability: [
        {
          status: "error",
          reason: "middleware_error",
        },
      ],
    });
    const { get_availability } = createSchedulingTools(middleware);
    const state = createState();

    await expect(
      get_availability.execute({ when: "2026-06-01", visitType: "medical" }, {
        ctx: createToolContext(state) as never,
        toolCallId: "availability-1",
      } as never),
    ).rejects.toThrow(
      "I couldn't check availability. I can try once more or connect you with the office.",
    );
    expect(ownedMiddlewareFailures(state)).toMatchObject([
      { operation: "getAvailability", reason: "middleware_error" },
    ]);
  });

  it("forwards the caller's time preference and trusts middleware ranking", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      availability: [
        availabilityFound([
          returnedSlot(),
          returnedSlot({
            provider: "Dr. D. Noel",
            time: "2:00 PM",
            datetime: "2026-06-01T14:00:00",
            bookingToken: "afternoon-token",
          }),
        ]),
      ],
    });
    const { get_availability } = createSchedulingTools(middleware);
    const state = createState();

    const result = await get_availability.execute(
      {
        when: "2026-06-01 afternoon",
        visitType: "medical",
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "availability-1",
      } as never,
    );

    expect(result).toBe(
      "Offer these options: Monday, June 1 at 9:00 AM with Dr. Bach (appointmentSlotRef S1), or Monday, June 1 at 2:00 PM with Dr. Noel (appointmentSlotRef S2). Ask which one works better. If the caller accepts a listed slot, use its appointmentSlotRef; if neither works, ask for another day or time and call get_availability with the caller's new when phrase.",
    );
    expect(state.availability.bookingTokensBySlotId).toEqual({
      S1: "private-token",
      S2: "afternoon-token",
    });
    expect(middleware.operations).toMatchObject([
      {
        kind: "availability",
        request: {
          requestedDate: "2026-06-01",
          preferredTime: { kind: "afternoon" },
        },
      },
    ]);
  });

  it("discards availability returned after the active patient changes", async () => {
    let resolveAvailability: (value: unknown) => void = () => undefined;
    const deferred = new Promise((resolve) => {
      resolveAvailability = resolve;
    });
    const middleware = new InMemorySchedulingMiddleware({
      availability: [deferred],
    });
    const { get_availability } = createSchedulingTools(middleware);
    const state = createState();
    const pending = get_availability.execute(
      {
        when: "2026-06-01",
        visitType: "medical",
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "availability-1",
      } as never,
    );

    applyPatientResult(state, {
      status: "verified",
      patientId: "patient-2",
      name: "John Doe",
      dob: "02/02/1982",
      phone: "+17275550102",
      appointments: [],
      appointmentsStatus: "none",
      insuranceCarrier: "self pay",
      insPlanId: null,
      respPartyId: null,
      routing: "all_three",
      allowedProviders: [],
      routingAmbiguous: false,
      preauthRequired: false,
    });
    resolveAvailability(availabilityFound([returnedSlot()]));

    await expect(pending).resolves.toBe(
      "Availability search was superseded because the patient or appointment context changed. Check availability again with the current details.",
    );
    expect(state.availability.slots).toEqual([]);
    expect(state.availability.bookingTokensBySlotId).toEqual({});
  });

  it("discards a late result after patient context changes away and back", async () => {
    const deferred = deferredResult<ReturnType<typeof availabilityFound>>();
    const middleware = new InMemorySchedulingMiddleware({
      availability: [deferred.promise],
    });
    const { get_availability } = createSchedulingTools(middleware);
    const state = createState();

    const pending = get_availability.execute(
      {
        when: "2026-06-01",
        visitType: "medical",
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "availability-1",
      } as never,
    );
    switchActivePatient(state);
    restoreFirstPatient(state);
    deferred.resolve(availabilityFound([returnedSlot()]));

    await expect(pending).resolves.toContain(
      "Availability search was superseded",
    );
    expect(state.identity.patient.patientId).toBe("patient-1");
    expect(state.availability.slots).toEqual([]);
    expect(state.availability.bookingTokensBySlotId).toEqual({});
  });

  it("preserves medical and routine-vision office capabilities", async () => {
    const middleware = new InMemorySchedulingMiddleware();
    const { get_availability } = createSchedulingTools(middleware);
    const opticalState = createState();
    opticalState.office.activeKey = "north-miami-beach-optical";
    opticalState.office.phoneOverrides = {
      "north-miami-beach-optical": "+13055550100",
    };
    const medicalResult = await get_availability.execute(
      { when: "2026-06-01", visitType: "medical" },
      {
        ctx: createToolContext(opticalState) as never,
        toolCallId: "medical-1",
      } as never,
    );
    const medicalState = createState();
    medicalState.office.activeKey = "crystal-river";
    medicalState.office.phoneOverrides = {
      "crystal-river": "+13523202007",
    };
    const routineResult = await get_availability.execute(
      { when: "2026-06-01", visitType: "routine_vision" },
      {
        ctx: createToolContext(medicalState) as never,
        toolCallId: "routine-1",
      } as never,
    );

    expect(medicalResult).toContain(
      "supports routine vision and optical scheduling",
    );
    expect(routineResult).toContain(
      "Route routine eye exams, glasses prescriptions, and contact lens prescriptions through a routine-vision office",
    );
    expect(middleware.operations).toEqual([]);
  });

  it("books the confirmed private slot and commits the observed outcome", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      bookings: [
        {
          status: "booked",
          appointmentId: 456,
          providerName: "Dr. Bach",
          locationName: "Spring Hill",
          appointmentTypeName: "Medical",
        },
      ],
    });
    const { book_appointment } = createSchedulingTools(middleware);
    const state = createState();
    state.workflow.current = {
      intent: "schedule",
      appointmentLane: "medical_md",
    };
    state.availability.slots = [
      {
        slotId: "S1",
        spoken: "2026-07-27 9:00 AM with Dr. Bach",
        provider: "Dr. Bach",
        date: "2026-07-27",
        time: "9:00 AM",
        datetime: "2026-07-27T09:00:00",
        routing: "all_three",
      },
    ];
    storeAvailabilityBookingToken(state, "S1", "private-token");

    const result = await book_appointment.execute(
      {
        appointmentSlotRef: "S1",
        appointmentReason: "left eye pain since yesterday",
        referringDoctor: "none",
        readBack: true,
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "booking-1",
      } as never,
    );

    expect(result).toMatch(
      /^Booked Monday, July 27 at 9:00 AM with Dr\. Bach\. Internal context: appointmentRef appointment-[a-z0-9]+\. Use this exact appointmentRef if the caller asks to cancel this appointment during this call\. Keep this opaque reference internal\.$/,
    );
    expect(middleware.operations).toMatchObject([
      {
        kind: "book",
        office: "+17275919997",
        request: {
          bookingToken: "private-token",
          patientId: "patient-1",
          appointmentReason: "left eye pain since yesterday",
          referringDoctor: "none",
          routing: "all_three",
        },
      },
    ]);
    expect(state.identity.patient.appointments).toContainEqual(
      expect.objectContaining({
        id: 456,
        date: "2026-07-27",
        time: "9:00 AM",
      }),
    );
    expect(appointmentActions(state)).toMatchObject([
      {
        action: "booked",
        status: "success",
        toolName: "book_appointment",
        appointment: { patientName: "Jane Doe" },
      },
    ]);
  });

  it("leaves the final appointment kind to middleware", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      bookings: [bookingReceipt()],
    });
    const { book_appointment } = createSchedulingTools(middleware);
    const state = createState();
    prepareBooking(state);
    const appointmentReason = "post-op check after cataract surgery";

    await book_appointment.execute(
      {
        appointmentSlotRef: "S1",
        appointmentReason,
        referringDoctor: "none",
        readBack: true,
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "booking-1",
      } as never,
    );

    const operation = middleware.operations[0];
    expect(operation).toMatchObject({
      kind: "book",
      request: {
        visitCategory: "medical",
        visitReason: appointmentReason,
      },
    });
    expect(operation).not.toHaveProperty("request.visitKind");
    expect(operation).not.toHaveProperty("request.isPostOp");
  });

  it("cancels a newly booked appointment by its returned appointment reference", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      bookings: [bookingReceipt()],
      cancellations: [{ status: "cancelled" }],
    });
    const { book_appointment, cancel_appointment } =
      createSchedulingTools(middleware);
    const state = createState();
    prepareBooking(state);
    const ctx = createToolContext(state);

    const bookingResult = await book_appointment.execute(
      {
        appointmentSlotRef: "S1",
        appointmentReason: "left eye pain since yesterday",
        referringDoctor: "none",
        readBack: true,
      },
      {
        ctx: ctx as never,
        toolCallId: "booking-1",
      } as never,
    );
    const appointmentRef = bookingResult.match(
      /appointmentRef (appointment-[a-z0-9]+)/,
    )?.[1];

    expect(appointmentRef).toBeDefined();
    expect(bookingResult).toContain("Keep this opaque reference internal.");

    await cancel_appointment.execute(
      { appointmentRef: appointmentRef as string },
      {
        ctx: ctx as never,
        toolCallId: "cancel-1",
      } as never,
    );

    expect(middleware.operations).toEqual([
      expect.objectContaining({ kind: "book" }),
      {
        kind: "cancel",
        office: "+17275919997",
        request: { appointmentId: 456, patientId: "patient-1" },
      },
    ]);
    expect(state.identity.patient.appointments).toEqual([]);
    expect(appointmentActions(state)[0]?.message).toBe(
      "Booked Monday, June 1 at 9:00 AM with Dr. Bach.",
    );
    expect(JSON.stringify(appointmentActions(state))).not.toContain(
      appointmentRef,
    );
  });

  it("invalidates completed availability after a successful booking", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      availability: [
        availabilityFound([returnedSlot()]),
        availabilityFound([
          returnedSlot({
            time: "10:00 AM",
            datetime: "2026-06-01T10:00:00",
            bookingToken: "replacement-token",
          }),
        ]),
      ],
      bookings: [bookingReceipt()],
    });
    const { book_appointment, get_availability } =
      createSchedulingTools(middleware);
    const state = createState();
    const ctx = createToolContext(state);
    const availabilityArgs = {
      when: "2026-06-01",
      visitType: "medical" as const,
    };

    await get_availability.execute(availabilityArgs, {
      ctx: ctx as never,
      toolCallId: "availability-1",
    } as never);
    await book_appointment.execute(
      {
        appointmentSlotRef: "S1",
        appointmentReason: "left eye pain since yesterday",
        referringDoctor: "none",
        readBack: true,
      },
      {
        ctx: ctx as never,
        toolCallId: "booking-1",
      } as never,
    );
    const refreshed = await get_availability.execute(availabilityArgs, {
      ctx: ctx as never,
      toolCallId: "availability-2",
    } as never);

    expect(refreshed).toContain("10:00 AM");
    expect(middleware.operations.map(({ kind }) => kind)).toEqual([
      "availability",
      "book",
      "availability",
    ]);
    expect(availabilityReadEvents(state)).toContainEqual(
      expect.objectContaining({
        operation: "invalidation",
        reason: "booking_succeeded",
      }),
    );
  });

  it("requires read-back confirmation before booking", async () => {
    const middleware = new InMemorySchedulingMiddleware();
    const { book_appointment } = createSchedulingTools(middleware);
    const state = createState();
    prepareBooking(state);

    const result = await book_appointment.execute(
      {
        appointmentSlotRef: "S1",
        appointmentReason: "left eye pain since yesterday",
        referringDoctor: "none",
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "booking-1",
      } as never,
    );

    expect(result).toBe(
      "Read back Monday, June 1 at 9:00 AM with Dr. Bach and ask the caller to confirm it. Call book_appointment again only after the caller confirms the appointment details are correct.",
    );
    expect(middleware.operations).toEqual([]);
  });

  it("requires a current private booking token", async () => {
    const middleware = new InMemorySchedulingMiddleware();
    const { book_appointment } = createSchedulingTools(middleware);
    const state = createState();
    prepareBooking(state);
    state.availability.bookingTokensBySlotId = {};

    await expect(
      book_appointment.execute(
        {
          appointmentSlotRef: "S1",
          appointmentReason: "left eye pain since yesterday",
          referringDoctor: "none",
          readBack: true,
        },
        {
          ctx: createToolContext(state) as never,
          toolCallId: "booking-1",
        } as never,
      ),
    ).resolves.toBe(
      "Search availability again before booking because the selected slot expired.",
    );
    expect(middleware.operations).toEqual([]);
    expect(state.availability.slots).toEqual([]);
  });

  it("does not confirm a booking without an appointment identity", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      bookings: [
        {
          status: "error",
          reason: "invalid_response",
          detail: "missing_appointment_id",
        },
      ],
    });
    const { book_appointment } = createSchedulingTools(middleware);
    const state = createState();
    prepareBooking(state);

    await expect(
      book_appointment.execute(
        {
          appointmentSlotRef: "S1",
          appointmentReason: "left eye pain since yesterday",
          referringDoctor: "none",
          readBack: true,
        },
        {
          ctx: createToolContext(state) as never,
          toolCallId: "booking-1",
        } as never,
      ),
    ).rejects.toThrow(
      "I couldn't book the appointment. I can try once more or connect you with the office.",
    );
    expect(state.identity.patient.appointments).toEqual([]);
    expect(appointmentActions(state)).toMatchObject([
      { action: "booked", status: "error" },
    ]);
    expect(ownedMiddlewareFailures(state)).toMatchObject([
      {
        operation: "bookAppointment",
        reason: "invalid_response",
        detail: "missing_appointment_id",
      },
    ]);
  });

  it.each([
    {
      name: "patient status and DOB",
      missing: ["patientStatus", "dob"] as const,
      message:
        "The appointment was not booked. Confirm whether the patient is new or established and verify the patient's date of birth, then try booking again.",
    },
    {
      name: "Spring Hill routine vision routing",
      missing: ["routeToSpringHill"] as const,
      message:
        "The appointment was not booked. Check routine vision availability at Spring Hill, then book a returned slot there.",
    },
    {
      name: "medical appointment lane",
      missing: ["appointmentLane"] as const,
      message:
        "The appointment was not booked. Treat the visit as medical and check Spring Hill medical availability before booking.",
    },
    {
      name: "supported medical routing",
      missing: ["routing"] as const,
      message:
        "The appointment was not booked. Check availability at an office that supports the required medical scheduling lane before booking.",
    },
    {
      name: "scheduling office",
      missing: ["office"] as const,
      message:
        "The appointment was not booked. Select the scheduling office and check availability again before booking.",
    },
  ])(
    "keeps the selected slot while recovering $name",
    async ({ missing, message }) => {
      const middleware = new InMemorySchedulingMiddleware({
        bookings: [
          {
            status: "needs_input",
            reason: "appointment_type_unresolved",
            missing: [...missing],
          },
        ],
      });
      const { book_appointment } = createSchedulingTools(middleware);
      const state = createState();
      prepareBooking(state);

      const result = await book_appointment.execute(
        {
          appointmentSlotRef: "S1",
          appointmentReason: "left eye pain since yesterday",
          referringDoctor: "none",
          readBack: true,
        },
        {
          ctx: createToolContext(state) as never,
          toolCallId: "booking-1",
        } as never,
      );

      expect(result).toBe(message);
      expect(state.availability.slots.map((slot) => slot.slotId)).toEqual([
        "S1",
      ]);
      expect(state.availability.bookingTokensBySlotId).toEqual({
        S1: "private-token",
      });
      expect(ownedMiddlewareFailures(state)).toEqual([]);
    },
  );

  it("removes an unavailable slot while preserving the next real option", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      bookings: [
        {
          status: "unavailable",
          reason: "slot_unavailable",
        },
      ],
    });
    const { book_appointment } = createSchedulingTools(middleware);
    const state = createState();
    prepareBooking(state);
    const nextSlot = availabilitySlot({
      slotId: "S2",
      time: "2:00 PM",
      datetime: "2026-06-01T14:00:00",
    });
    state.availability.slots.push(nextSlot);
    storeAvailabilityBookingToken(state, "S2", "next-token");

    const result = await book_appointment.execute(
      {
        appointmentSlotRef: "S1",
        appointmentReason: "left eye pain since yesterday",
        referringDoctor: "none",
        readBack: true,
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "booking-1",
      } as never,
    );

    expect(result).toBe(
      "That time is no longer available. I can offer Monday, June 1 at 2:00 PM with Dr. Bach instead.",
    );
    expect(state.availability.slots).toEqual([nextSlot]);
    expect(state.availability.bookingTokensBySlotId).toEqual({
      S2: "next-token",
    });
  });

  it("refetches availability after a cached slot is rejected", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      availability: [
        availabilityFound([
          returnedSlot(),
          returnedSlot({
            time: "2:00 PM",
            datetime: "2026-06-01T14:00:00",
            bookingToken: "next-token",
          }),
        ]),
        availabilityFound([
          returnedSlot({
            time: "3:00 PM",
            datetime: "2026-06-01T15:00:00",
            bookingToken: "refreshed-token",
          }),
        ]),
      ],
      bookings: [{ status: "unavailable", reason: "slot_unavailable" }],
    });
    const { book_appointment, get_availability } =
      createSchedulingTools(middleware);
    const state = createState();
    const ctx = createToolContext(state);
    const args = {
      when: "2026-06-01",
      visitType: "medical" as const,
    };

    await get_availability.execute(args, {
      ctx: ctx as never,
      toolCallId: "availability-1",
    } as never);
    await book_appointment.execute(
      {
        appointmentSlotRef: "S1",
        appointmentReason: "left eye pain since yesterday",
        referringDoctor: "none",
        readBack: true,
      },
      {
        ctx: ctx as never,
        toolCallId: "booking-1",
      } as never,
    );
    const refreshed = await get_availability.execute(args, {
      ctx: ctx as never,
      toolCallId: "availability-2",
    } as never);

    expect(refreshed).toContain("3:00 PM");
    expect(middleware.operations.map(({ kind }) => kind)).toEqual([
      "availability",
      "book",
      "availability",
    ]);
  });

  it("replays a completed booking without another write", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      bookings: [bookingReceipt()],
    });
    const { book_appointment } = createSchedulingTools(middleware);
    const state = createState();
    prepareBooking(state);
    const ctx = createToolContext(state);
    const args = {
      appointmentSlotRef: "S1",
      appointmentReason: "left eye pain since yesterday",
      referringDoctor: "none",
      readBack: true,
    };

    await book_appointment.execute(args, {
      ctx: ctx as never,
      toolCallId: "booking-1",
    } as never);
    const replay = await book_appointment.execute(args, {
      ctx: ctx as never,
      toolCallId: "booking-2",
    } as never);

    expect(replay).toBe(
      "The appointment is already booked. Tell the caller the confirmed appointment details instead of booking again.",
    );
    expect(middleware.operations).toHaveLength(1);
  });

  it("invalidates booking state on patient switch and permits the new patient", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      bookings: [bookingReceipt(), bookingReceipt({ appointmentId: 789 })],
    });
    const { book_appointment } = createSchedulingTools(middleware);
    const state = createState();
    prepareBooking(state);
    const ctx = createToolContext(state);
    const args = {
      appointmentSlotRef: "S1",
      appointmentReason: "left eye pain since yesterday",
      referringDoctor: "none",
      readBack: true,
    };
    await book_appointment.execute(args, {
      ctx: ctx as never,
      toolCallId: "booking-1",
    } as never);

    applyPatientResult(state, {
      status: "verified",
      patientId: "patient-2",
      name: "John Doe",
      dob: "02/02/1982",
      phone: "+17275550102",
      appointments: [],
      appointmentsStatus: "none",
      insuranceCarrier: "self pay",
      insPlanId: null,
      respPartyId: null,
      routing: "all_three",
      allowedProviders: [],
      routingAmbiguous: false,
      preauthRequired: false,
    });
    prepareBooking(state);
    await book_appointment.execute(args, {
      ctx: ctx as never,
      toolCallId: "booking-2",
    } as never);

    expect(middleware.operations).toMatchObject([
      { kind: "book", request: { patientId: "patient-1" } },
      { kind: "book", request: { patientId: "patient-2" } },
    ]);
    expect(state.identity.patient.appointments).toContainEqual(
      expect.objectContaining({ id: 789 }),
    );
  });

  it("does not apply an in-flight booking result to a newly active patient", async () => {
    const deferred = deferredResult<ReturnType<typeof bookingReceipt>>();
    const middleware = new InMemorySchedulingMiddleware({
      bookings: [deferred.promise],
    });
    const { book_appointment } = createSchedulingTools(middleware);
    const state = createState();
    prepareBooking(state);
    const currentAppointment = loadedAppointment({ id: 999 });

    const pending = book_appointment.execute(
      {
        appointmentSlotRef: "S1",
        appointmentReason: "left eye pain since yesterday",
        referringDoctor: "none",
        readBack: true,
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "booking-1",
      } as never,
    );
    switchActivePatient(state, [currentAppointment]);
    deferred.resolve(bookingReceipt({ appointmentId: 456 }));

    const result = await pending;

    expect(result).toContain(
      "The active patient changed before the booking result returned.",
    );
    expect(state.identity.patient).toMatchObject({ patientId: "patient-2" });
    expect(state.identity.patient.appointments).toEqual([
      expect.objectContaining(currentAppointment),
    ]);

    restoreFirstPatient(state);
    const replay = await book_appointment.execute(
      {
        appointmentSlotRef: "S1",
        appointmentReason: "left eye pain since yesterday",
        referringDoctor: "none",
        readBack: true,
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "booking-2",
      } as never,
    );

    expect(replay).toContain("The appointment is already booked.");
    expect(middleware.operations.map(({ kind }) => kind)).toEqual(["book"]);
    expect(appointmentActions(state)).toMatchObject([
      {
        action: "booked",
        status: "success",
        appointment: { patientName: "Jane Doe" },
      },
    ]);
  });

  it("cancels one loaded appointment once and replays the committed result", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      cancellations: [{ status: "cancelled" }],
    });
    const { cancel_appointment } = createSchedulingTools(middleware);
    const state = createState();
    restoreFirstPatient(state, [
      loadedAppointment({ appointmentTypeId: undefined }),
    ]);
    const ctx = createToolContext(state);
    const appointmentRef = loadedAppointmentRef(state);

    const result = await cancel_appointment.execute({ appointmentRef }, {
      ctx: ctx as never,
      toolCallId: "cancel-1",
    } as never);
    const replay = await cancel_appointment.execute({ appointmentRef }, {
      ctx: ctx as never,
      toolCallId: "cancel-2",
    } as never);

    expect(result).toBe(
      "Cancelled the appointment on Monday, June 1, 2026 at 9:00 AM.",
    );
    expect(replay).toBe(
      "That appointment was already cancelled on this call: Monday, June 1, 2026 at 9:00 AM. Continue without calling cancel_appointment again.",
    );
    expect(middleware.operations).toEqual([
      {
        kind: "cancel",
        office: "+17275919997",
        request: { appointmentId: 123, patientId: "patient-1" },
      },
    ]);
    expect(state.identity.patient.appointments).toEqual([]);
    expect(appointmentActions(state)).toMatchObject([
      {
        action: "cancelled",
        status: "success",
        toolName: "cancel_appointment",
        cancelledAppointment: { patientName: "Jane Doe" },
      },
    ]);
  });

  it("invalidates completed availability after a successful cancellation", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      availability: [
        availabilityFound([returnedSlot()]),
        availabilityFound([
          returnedSlot({
            time: "10:00 AM",
            datetime: "2026-06-01T10:00:00",
            bookingToken: "replacement-token",
          }),
        ]),
      ],
      cancellations: [{ status: "cancelled" }],
    });
    const { cancel_appointment, get_availability } =
      createSchedulingTools(middleware);
    const state = createState();
    restoreFirstPatient(state, [loadedAppointment()]);
    const ctx = createToolContext(state);
    const args = {
      when: "2026-06-01",
      visitType: "medical" as const,
    };

    await get_availability.execute(args, {
      ctx: ctx as never,
      toolCallId: "availability-1",
    } as never);
    await cancel_appointment.execute(
      { appointmentRef: loadedAppointmentRef(state) },
      {
        ctx: ctx as never,
        toolCallId: "cancel-1",
      } as never,
    );
    const refreshed = await get_availability.execute(args, {
      ctx: ctx as never,
      toolCallId: "availability-2",
    } as never);

    expect(refreshed).toContain("10:00 AM");
    expect(middleware.operations.map(({ kind }) => kind)).toEqual([
      "availability",
      "cancel",
      "availability",
    ]);
  });

  it("maps the selected appointment reference to its private cancellation token", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      cancellations: [{ status: "cancelled" }],
    });
    const { cancel_appointment } = createSchedulingTools(middleware);
    const state = createState();
    restoreFirstPatient(state, [
      {
        ...loadedAppointment(),
        cancellationToken: "private-cancellation-token",
      },
      {
        ...loadedAppointment({
          id: 222,
          date: "Tuesday, June 2, 2026",
          time: "2:00 PM",
        }),
        cancellationToken: "private-other-token",
      },
    ]);
    const appointmentRef = loadedAppointmentRef(state);

    const result = await cancel_appointment.execute({ appointmentRef }, {
      ctx: createToolContext(state) as never,
      toolCallId: "cancel-1",
    } as never);

    expect(middleware.operations).toEqual([
      {
        kind: "cancel",
        office: "+17275919997",
        request: { cancellationToken: "private-cancellation-token" },
      },
    ]);
    expect(state.identity.patient.appointments.map(({ id }) => id)).toEqual([
      222,
    ]);
    const modelAndAnalytics = JSON.stringify({
      result,
      appointmentActions: appointmentActions(state),
    });
    expect(modelAndAnalytics).not.toContain("private-cancellation-token");
    expect(modelAndAnalytics).not.toContain("private-other-token");
    expect(
      appointmentActions(state)[0]?.cancelledAppointment,
    ).not.toHaveProperty("appointmentId");
  });

  it("cancels a paired-office token appointment without asserting the call office", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json(
        "office" in body
          ? {
              status: "error",
              outcome: "invalid_cancellation_token",
              message:
                "The call office does not match the token owning office.",
            }
          : {
              status: "cancelled",
              message: "Appointment cancelled successfully.",
            },
      );
    });
    setOwnedMiddleware(
      new HttpOwnedMiddleware({
        fetch: fetchMock,
        productionBaseUrl: "https://middleware.test",
      }),
    );
    const { cancel_appointment } = createSchedulingTools(
      productionSchedulingMiddleware,
    );
    const state = createState();
    state.office.activeKey = "spring-hill";
    state.office.phoneOverrides["spring-hill"] = SPRING_HILL_OFFICE_PHONE;
    state.runtime.trunkPhone = SPRING_HILL_OFFICE_PHONE;
    restoreFirstPatient(state, [
      loadedAppointment({
        facility: "Brooksville",
        cancellationToken: "brooksville-owned-cancellation-token",
      }),
    ]);
    const appointmentRef = loadedAppointmentRef(state);

    const result = await cancel_appointment.execute({ appointmentRef }, {
      ctx: createToolContext(state) as never,
      toolCallId: "cancel-1",
    } as never);

    expect(result).toBe(
      "Cancelled the appointment on Monday, June 1, 2026 at 9:00 AM.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://middleware.test/api/appointment/cancel",
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      cancellationToken: "brooksville-owned-cancellation-token",
    });
  });

  it("keeps a loaded appointment when cancellation fails", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      cancellations: [
        {
          status: "error",
          reason: "middleware_error",
        },
      ],
    });
    const { cancel_appointment } = createSchedulingTools(middleware);
    const state = createState();
    restoreFirstPatient(state, [loadedAppointment()]);
    const appointmentRef = loadedAppointmentRef(state);

    await expect(
      cancel_appointment.execute({ appointmentRef }, {
        ctx: createToolContext(state) as never,
        toolCallId: "cancel-1",
      } as never),
    ).rejects.toThrow(
      "I couldn't cancel the appointment. I can try once more or connect you with the office.",
    );
    expect(state.identity.patient.appointments).toEqual([
      expect.objectContaining(loadedAppointment()),
    ]);
    expect(ownedMiddlewareFailures(state)).toMatchObject([
      { operation: "cancelAppointment", reason: "middleware_error" },
    ]);
  });

  it("invalidates stale appointment authorization after token rejection without fallback", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      cancellations: [
        {
          status: "rejected",
          reason: "invalid_cancellation_token",
          message:
            "cancellationToken is invalid or expired. Please load appointments again and choose the appointment to cancel.",
        },
      ],
    });
    const { cancel_appointment } = createSchedulingTools(middleware);
    const state = createState();
    restoreFirstPatient(state, [
      loadedAppointment({
        cancellationToken: "expired-cancellation-token",
      }),
    ]);
    const appointmentRef = loadedAppointmentRef(state);
    const ctx = createToolContext(state);

    const result = await cancel_appointment.execute({ appointmentRef }, {
      ctx: ctx as never,
      toolCallId: "cancel-1",
    } as never);

    expect(result).toBe(
      "That loaded appointment authorization is no longer valid. Load appointments again, confirm the exact appointment with the caller, then use its new appointmentRef to cancel.",
    );
    expect(middleware.operations).toEqual([
      {
        kind: "cancel",
        office: "+17275919997",
        request: { cancellationToken: "expired-cancellation-token" },
      },
    ]);
    expect(state.identity.patient).toMatchObject({
      appointments: [],
      appointmentsStatus: "error",
    });
    expect(ownedMiddlewareFailures(state)).toMatchObject([
      {
        operation: "cancelAppointment",
        reason: "invalid_cancellation_token",
      },
    ]);

    await expect(
      cancel_appointment.execute({ appointmentRef }, {
        ctx: ctx as never,
        toolCallId: "cancel-2",
      } as never),
    ).resolves.toBe(
      "No loaded appointment matches that appointmentRef. Use the appointmentRef shown with the current loaded appointment.",
    );
    expect(middleware.operations).toHaveLength(1);
  });

  it("rejects an ambiguous appointment reference without cancelling", async () => {
    const middleware = new InMemorySchedulingMiddleware();
    const { cancel_appointment } = createSchedulingTools(middleware);
    const state = createState();
    restoreFirstPatient(state, [loadedAppointment(), loadedAppointment()]);
    const appointmentRef = loadedAppointmentRef(state);

    const result = await cancel_appointment.execute({ appointmentRef }, {
      ctx: createToolContext(state) as never,
      toolCallId: "cancel-1",
    } as never);

    expect(result).toBe(
      "More than one loaded appointment has that appointmentRef. Load appointments again and confirm the exact appointment before cancelling.",
    );
    expect(middleware.operations).toEqual([]);
  });

  it("rejects an invalid or stale appointment reference without cancelling", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      cancellations: [{ status: "cancelled" }],
    });
    const { cancel_appointment } = createSchedulingTools(middleware);
    const state = createState();
    restoreFirstPatient(state, [loadedAppointment()]);

    await expect(
      cancel_appointment.execute({ appointmentRef: "appointment-stale" }, {
        ctx: createToolContext(state) as never,
        toolCallId: "cancel-1",
      } as never),
    ).resolves.toBe(
      "No loaded appointment matches that appointmentRef. Use the appointmentRef shown with the current loaded appointment.",
    );
    expect(middleware.operations).toEqual([]);
    expect(state.identity.patient.appointments).toHaveLength(1);
  });

  it("requires an appointment reference even when one appointment is loaded", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      cancellations: [{ status: "cancelled" }],
    });
    const { cancel_appointment } = createSchedulingTools(middleware);
    const state = createState();
    restoreFirstPatient(state, [loadedAppointment()]);

    await expect(
      cancel_appointment.execute(
        {} as never,
        {
          ctx: createToolContext(state) as never,
          toolCallId: "cancel-1",
        } as never,
      ),
    ).resolves.toBe(
      "Pass the appointmentRef shown with the caller-confirmed loaded appointment before cancelling.",
    );
    expect(middleware.operations).toEqual([]);
  });

  it("requires a reference after an earlier cancellation completed", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      cancellations: [{ status: "cancelled" }],
    });
    const { cancel_appointment } = createSchedulingTools(middleware);
    const state = createState();
    restoreFirstPatient(state, [loadedAppointment()]);
    const appointmentRef = loadedAppointmentRef(state);
    const ctx = createToolContext(state);
    await cancel_appointment.execute({ appointmentRef }, {
      ctx: ctx as never,
      toolCallId: "cancel-1",
    } as never);

    await expect(
      cancel_appointment.execute(
        {} as never,
        {
          ctx: ctx as never,
          toolCallId: "cancel-2",
        } as never,
      ),
    ).resolves.toBe(
      "Pass the appointmentRef shown with the caller-confirmed loaded appointment before cancelling.",
    );
    expect(middleware.operations.map(({ kind }) => kind)).toEqual(["cancel"]);
  });

  it("rejects an appointment reference owned by a different active patient", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      cancellations: [{ status: "cancelled" }],
    });
    const { cancel_appointment } = createSchedulingTools(middleware);
    const state = createState();
    const sameBackendAppointment = loadedAppointment();
    restoreFirstPatient(state, [sameBackendAppointment]);
    const firstPatientRef = loadedAppointmentRef(state);

    switchActivePatient(state, [sameBackendAppointment]);
    expect(loadedAppointmentRef(state)).not.toBe(firstPatientRef);

    await expect(
      cancel_appointment.execute({ appointmentRef: firstPatientRef }, {
        ctx: createToolContext(state) as never,
        toolCallId: "cancel-1",
      } as never),
    ).resolves.toBe(
      "No loaded appointment matches that appointmentRef. Use the appointmentRef shown with the current loaded appointment.",
    );
    expect(middleware.operations).toEqual([]);
  });

  it("keeps appointment references stable when loaded appointments are reordered", () => {
    const state = createState();
    const first = loadedAppointment();
    const second = loadedAppointment({
      id: 222,
      date: "Tuesday, June 2, 2026",
      time: "2:00 PM",
    });
    restoreFirstPatient(state, [first, second]);
    const refsById = new Map(
      state.identity.patient.appointments.map(({ id, appointmentRef }) => [
        id,
        appointmentRef,
      ]),
    );

    restoreFirstPatient(state, [second, first]);

    expect(
      new Map(
        state.identity.patient.appointments.map(({ id, appointmentRef }) => [
          id,
          appointmentRef,
        ]),
      ),
    ).toEqual(refsById);
    expect([...refsById.values()]).toEqual([
      expect.stringMatching(/^appointment-[a-f0-9]{24}$/),
      expect.stringMatching(/^appointment-[a-f0-9]{24}$/),
    ]);
  });

  it("does not remove the newly active patient's appointment when cancellation finishes", async () => {
    const deferred = deferredResult<{ status: "cancelled" }>();
    const middleware = new InMemorySchedulingMiddleware({
      cancellations: [deferred.promise],
    });
    const { cancel_appointment } = createSchedulingTools(middleware);
    const state = createState();
    restoreFirstPatient(state, [loadedAppointment()]);
    const appointmentRef = loadedAppointmentRef(state);
    const currentAppointment = loadedAppointment({ id: 123 });

    const pending = cancel_appointment.execute({ appointmentRef }, {
      ctx: createToolContext(state) as never,
      toolCallId: "cancel-1",
    } as never);
    switchActivePatient(state, [currentAppointment]);
    deferred.resolve({ status: "cancelled" });

    const result = await pending;

    expect(result).toContain(
      "The active patient changed before the cancellation result returned.",
    );
    expect(state.identity.patient).toMatchObject({ patientId: "patient-2" });
    expect(state.identity.patient.appointments).toEqual([
      expect.objectContaining(currentAppointment),
    ]);

    restoreFirstPatient(state, [loadedAppointment()]);
    const replay = await cancel_appointment.execute({ appointmentRef }, {
      ctx: createToolContext(state) as never,
      toolCallId: "cancel-2",
    } as never);

    expect(replay).toContain("already cancelled on this call");
    expect(middleware.operations.map(({ kind }) => kind)).toEqual(["cancel"]);
    expect(appointmentActions(state)).toMatchObject([
      {
        action: "cancelled",
        status: "success",
        cancelledAppointment: {
          patientName: "Jane Doe",
        },
      },
    ]);
  });

  it("keeps cancellation replay protection scoped to the active patient", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      cancellations: [{ status: "cancelled" }, { status: "cancelled" }],
    });
    const { cancel_appointment } = createSchedulingTools(middleware);
    const state = createState();
    restoreFirstPatient(state, [loadedAppointment()]);
    const ctx = createToolContext(state);
    const firstAppointmentRef = loadedAppointmentRef(state);
    await cancel_appointment.execute({ appointmentRef: firstAppointmentRef }, {
      ctx: ctx as never,
      toolCallId: "cancel-1",
    } as never);

    applyPatientResult(state, {
      status: "verified",
      patientId: "patient-2",
      name: "John Doe",
      dob: "02/02/1982",
      phone: "+17275550102",
      appointments: [loadedAppointment({ id: 789 })],
      appointmentsStatus: "found",
      insuranceCarrier: "self pay",
      insPlanId: null,
      respPartyId: null,
      routing: "all_three",
      allowedProviders: [],
      routingAmbiguous: false,
      preauthRequired: false,
    });
    const secondAppointmentRef = loadedAppointmentRef(state);
    await cancel_appointment.execute({ appointmentRef: secondAppointmentRef }, {
      ctx: ctx as never,
      toolCallId: "cancel-2",
    } as never);

    expect(middleware.operations).toMatchObject([
      {
        kind: "cancel",
        request: { appointmentId: 123, patientId: "patient-1" },
      },
      {
        kind: "cancel",
        request: { appointmentId: 789, patientId: "patient-2" },
      },
    ]);
  });

  it("reschedules by booking before cancellation and commits one final outcome", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      bookings: [
        {
          status: "booked",
          appointmentId: 456,
          providerName: "Dr. Bach",
          locationName: "Spring Hill",
          appointmentTypeName: "Medical",
        },
      ],
      cancellations: [{ status: "cancelled" }],
    });
    const { reschedule_appointment } = createSchedulingTools(middleware);
    const state = createState();
    state.workflow.current = {
      intent: "change_appointment",
      appointmentLane: "not_applicable",
    };
    state.identity.patient.appointments = [
      {
        id: 123,
        cancellationToken: "private-reschedule-cancellation-token",
        date: "Monday, June 1, 2026",
        time: "9:00 AM",
        provider: "Dr. Licht",
        type: "Follow-up",
        appointmentTypeId: 1005,
        facility: "Spring Hill",
        confirmed: true,
      },
    ];
    state.availability.slots = [
      {
        slotId: "S1",
        spoken: "2026-06-03 10:00 AM with Dr. Bach",
        provider: "Dr. Bach",
        date: "2026-06-03",
        time: "10:00 AM",
        datetime: "2026-06-03T10:00:00",
        routing: "all_three",
      },
    ];
    storeAvailabilityBookingToken(state, "S1", "private-token");

    const result = await reschedule_appointment.execute(
      {
        appointmentSlotRef: "S1",
        appointmentReason: "move my follow-up",
        referringDoctor: "none",
        readBack: true,
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "reschedule-1",
      } as never,
    );

    expect(result).toBe(
      "Rescheduled the appointment to Wednesday, June 3 at 10:00 AM with Dr. Bach. Cancelled the old appointment on Monday, June 1, 2026 at 9:00 AM.",
    );
    expect(middleware.operations.map((operation) => operation.kind)).toEqual([
      "book",
      "cancel",
    ]);
    expect(middleware.operations[1]).toMatchObject({
      kind: "cancel",
      request: {
        cancellationToken: "private-reschedule-cancellation-token",
      },
    });
    expect(
      JSON.stringify({ result, appointmentActions: appointmentActions(state) }),
    ).not.toContain("private-reschedule-cancellation-token");
    expect(state.identity.patient.appointments).toEqual([
      expect.objectContaining({
        id: 456,
        date: "2026-06-03",
        time: "10:00 AM",
      }),
    ]);
    expect(appointmentActions(state)).toMatchObject([
      {
        action: "rescheduled",
        status: "success",
        toolName: "reschedule_appointment",
        appointment: { patientName: "Jane Doe" },
        cancelledAppointment: { patientName: "Jane Doe" },
      },
    ]);
  });

  it("invalidates completed availability after a successful reschedule", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      availability: [
        availabilityFound([
          returnedSlot({
            date: "2026-06-03",
            datetime: "2026-06-03T09:00:00",
          }),
        ]),
        availabilityFound([
          returnedSlot({
            date: "2026-06-04",
            time: "10:00 AM",
            datetime: "2026-06-04T10:00:00",
            bookingToken: "replacement-token",
          }),
        ]),
      ],
      bookings: [bookingReceipt()],
      cancellations: [{ status: "cancelled" }],
    });
    const { get_availability, reschedule_appointment } =
      createSchedulingTools(middleware);
    const state = createState();
    restoreFirstPatient(state, [loadedAppointment()]);
    const ctx = createToolContext(state);
    const args = { when: "2026-06-01" };

    await get_availability.execute(args, {
      ctx: ctx as never,
      toolCallId: "availability-1",
    } as never);
    await reschedule_appointment.execute(
      {
        appointmentSlotRef: "S1",
        appointmentReason: "move my follow-up",
        referringDoctor: "none",
        readBack: true,
      },
      {
        ctx: ctx as never,
        toolCallId: "reschedule-1",
      } as never,
    );
    const refreshed = await get_availability.execute(args, {
      ctx: ctx as never,
      toolCallId: "availability-2",
    } as never);

    expect(refreshed).toContain("June 4 at 10:00 AM");
    expect(middleware.operations.map(({ kind }) => kind)).toEqual([
      "availability",
      "book",
      "cancel",
      "availability",
    ]);
  });

  it("routes paired-office reschedule token cancellation through the call office", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      bookings: [bookingReceipt()],
      cancellations: [{ status: "cancelled" }],
    });
    const { reschedule_appointment } = createSchedulingTools(middleware);
    const state = createState();
    prepareReschedule(state, {
      appointment: loadedAppointment({
        facility: "Crystal River",
        cancellationToken: "crystal-river-owned-cancellation-token",
      }),
    });

    await reschedule_appointment.execute(
      {
        appointmentSlotRef: "S1",
        appointmentReason: "move my follow-up",
        referringDoctor: "none",
        readBack: true,
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "reschedule-1",
      } as never,
    );

    expect(middleware.operations).toEqual([
      expect.objectContaining({
        kind: "book",
        office: SPRING_HILL_OFFICE_PHONE,
      }),
      {
        kind: "cancel",
        office: SPRING_HILL_OFFICE_PHONE,
        request: {
          cancellationToken: "crystal-river-owned-cancellation-token",
        },
      },
    ]);
  });

  it("requires read-back confirmation before rescheduling", async () => {
    const middleware = new InMemorySchedulingMiddleware();
    const { reschedule_appointment } = createSchedulingTools(middleware);
    const state = createState();
    prepareReschedule(state);

    const result = await reschedule_appointment.execute(
      {
        appointmentSlotRef: "S1",
        appointmentReason: "move my follow-up",
        referringDoctor: "none",
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "reschedule-1",
      } as never,
    );

    expect(result).toBe(
      "Read back Monday, June 1 at 9:00 AM with Dr. Bach and ask the caller to confirm it as the new appointment. Call reschedule_appointment again only after the caller confirms the new appointment details are correct.",
    );
    expect(middleware.operations).toEqual([]);
  });

  it("returns old appointment refs before rescheduling multiple loaded appointments", async () => {
    const middleware = new InMemorySchedulingMiddleware();
    const { reschedule_appointment } = createSchedulingTools(middleware);
    const state = createState();
    prepareReschedule(state);
    state.identity.patient.appointments = [
      loadedAppointment(),
      loadedAppointment({
        id: 222,
        date: "Tuesday, June 2, 2026",
        time: "2:00 PM",
      }),
    ];

    const result = await reschedule_appointment.execute(
      {
        appointmentSlotRef: "S1",
        appointmentReason: "move my follow-up",
        referringDoctor: "none",
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "reschedule-1",
      } as never,
    );

    expect(result).toContain("Which loaded appointment should I reschedule?");
    expect(result).toContain("oldAppointmentRef");
    expect(result).toContain("Monday, June 1, 2026 at 9:00 AM");
    expect(result).toContain("Tuesday, June 2, 2026 at 2:00 PM");
    expect(middleware.operations).toEqual([]);
  });

  it("rejects a duplicate old appointment reference before rescheduling", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      bookings: [bookingReceipt()],
      cancellations: [{ status: "cancelled" }],
    });
    const { reschedule_appointment } = createSchedulingTools(middleware);
    const state = createState();
    prepareReschedule(state);
    restoreFirstPatient(state, [loadedAppointment(), loadedAppointment()]);
    const oldAppointmentRef = loadedAppointmentRef(state);

    const result = await reschedule_appointment.execute(
      {
        oldAppointmentRef,
        appointmentSlotRef: "S1",
        appointmentReason: "move my follow-up",
        referringDoctor: "none",
        readBack: true,
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "reschedule-1",
      } as never,
    );

    expect(result).toBe(
      "More than one loaded appointment has that oldAppointmentRef. Load appointments again and confirm the exact appointment before rescheduling.",
    );
    expect(middleware.operations).toEqual([]);
  });

  it("does not apply an in-flight reschedule booking to a newly active patient", async () => {
    const deferred = deferredResult<ReturnType<typeof bookingReceipt>>();
    const middleware = new InMemorySchedulingMiddleware({
      bookings: [deferred.promise],
      cancellations: [{ status: "cancelled" }],
    });
    const { reschedule_appointment } = createSchedulingTools(middleware);
    const state = createState();
    prepareReschedule(state);
    const currentAppointment = loadedAppointment({ id: 999 });

    const pending = reschedule_appointment.execute(
      {
        appointmentSlotRef: "S1",
        appointmentReason: "move my follow-up",
        referringDoctor: "none",
        readBack: true,
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "reschedule-1",
      } as never,
    );
    switchActivePatient(state, [currentAppointment]);
    deferred.resolve(bookingReceipt({ appointmentId: 456 }));

    const result = await pending;

    expect(result).toContain(
      "The active patient changed before the old appointment could be cancelled.",
    );
    expect(middleware.operations.map(({ kind }) => kind)).toEqual(["book"]);
    expect(state.identity.patient).toMatchObject({ patientId: "patient-2" });
    expect(state.identity.patient.appointments).toEqual([
      expect.objectContaining(currentAppointment),
    ]);

    restoreFirstPatient(state, [loadedAppointment()]);
    const replay = await reschedule_appointment.execute(
      {
        appointmentSlotRef: "S1",
        appointmentReason: "move my follow-up",
        referringDoctor: "none",
        readBack: true,
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "reschedule-2",
      } as never,
    );

    expect(replay).toContain("old appointment still needs office staff");
    expect(middleware.operations.map(({ kind }) => kind)).toEqual(["book"]);
    expect(appointmentActions(state)).toMatchObject([
      {
        action: "rescheduled",
        status: "partial",
        appointment: { patientName: "Jane Doe" },
      },
    ]);
  });

  it("does not apply an in-flight reschedule cancellation to a newly active patient", async () => {
    const deferred = deferredResult<{ status: "cancelled" }>();
    const middleware = new InMemorySchedulingMiddleware({
      bookings: [bookingReceipt({ appointmentId: 456 })],
      cancellations: [deferred.promise],
    });
    const { reschedule_appointment } = createSchedulingTools(middleware);
    const state = createState();
    prepareReschedule(state);
    const currentAppointment = loadedAppointment({ id: 999 });

    const pending = reschedule_appointment.execute(
      {
        appointmentSlotRef: "S1",
        appointmentReason: "move my follow-up",
        referringDoctor: "none",
        readBack: true,
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "reschedule-1",
      } as never,
    );
    await Promise.resolve();
    expect(middleware.operations.map(({ kind }) => kind)).toEqual([
      "book",
      "cancel",
    ]);
    switchActivePatient(state, [currentAppointment]);
    deferred.resolve({ status: "cancelled" });

    const result = await pending;

    expect(result).toContain(
      "The active patient changed before the cancellation result returned.",
    );
    expect(state.identity.patient).toMatchObject({ patientId: "patient-2" });
    expect(state.identity.patient.appointments).toEqual([
      expect.objectContaining(currentAppointment),
    ]);

    restoreFirstPatient(state, [loadedAppointment()]);
    const replay = await reschedule_appointment.execute(
      {
        appointmentSlotRef: "S1",
        appointmentReason: "move my follow-up",
        referringDoctor: "none",
        readBack: true,
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "reschedule-2",
      } as never,
    );

    expect(replay).toContain("already rescheduled");
    expect(middleware.operations.map(({ kind }) => kind)).toEqual([
      "book",
      "cancel",
    ]);
    expect(appointmentActions(state)).toMatchObject([
      {
        action: "rescheduled",
        status: "success",
        appointment: { patientName: "Jane Doe" },
      },
    ]);
  });

  it("does not cancel when the replacement booking fails", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      bookings: [
        {
          status: "unavailable",
          reason: "slot_unavailable",
        },
      ],
    });
    const { reschedule_appointment } = createSchedulingTools(middleware);
    const state = createState();
    prepareReschedule(state);

    const result = await reschedule_appointment.execute(
      {
        appointmentSlotRef: "S1",
        appointmentReason: "move my follow-up",
        referringDoctor: "none",
        readBack: true,
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "reschedule-1",
      } as never,
    );

    expect(result).toBe(
      "That time is no longer available. Check availability again before booking. I did not cancel the existing appointment.",
    );
    expect(middleware.operations.map((operation) => operation.kind)).toEqual([
      "book",
    ]);
    expect(state.identity.patient.appointments).toEqual([loadedAppointment()]);
  });

  it("surfaces a replacement booking backend failure as a tool error", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      bookings: [{ status: "error", reason: "middleware_error" }],
    });
    const { reschedule_appointment } = createSchedulingTools(middleware);
    const state = createState();
    prepareReschedule(state);

    await expect(
      reschedule_appointment.execute(
        {
          appointmentSlotRef: "S1",
          appointmentReason: "move my follow-up",
          referringDoctor: "none",
          readBack: true,
        },
        {
          ctx: createToolContext(state) as never,
          toolCallId: "reschedule-1",
        } as never,
      ),
    ).rejects.toThrow(
      "I couldn't book the new appointment. I did not cancel the existing appointment.",
    );
    expect(middleware.operations.map((operation) => operation.kind)).toEqual([
      "book",
    ]);
    expect(state.identity.patient.appointments).toEqual([loadedAppointment()]);
  });

  it("records a partial reschedule when cancellation fails and blocks replay", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      bookings: [bookingReceipt()],
      cancellations: [
        {
          status: "error",
          reason: "middleware_error",
        },
      ],
    });
    const { reschedule_appointment } = createSchedulingTools(middleware);
    const state = createState();
    prepareReschedule(state);
    const ctx = createToolContext(state);
    const args = {
      appointmentSlotRef: "S1",
      appointmentReason: "move my follow-up",
      referringDoctor: "none",
      readBack: true,
    };

    const result = await reschedule_appointment.execute(args, {
      ctx: ctx as never,
      toolCallId: "reschedule-1",
    } as never);
    const replay = await reschedule_appointment.execute(args, {
      ctx: ctx as never,
      toolCallId: "reschedule-2",
    } as never);

    expect(result).toBe(
      "Booked the new appointment for Monday, June 1 at 9:00 AM with Dr. Bach, but I could not cancel the old appointment. The old appointment was not cancelled. I need to transfer you so the office can finish the cancellation.",
    );
    expect(replay).toBe(
      "The new appointment was already booked, but the old appointment still needs office staff to finish cancellation. Transfer the caller instead of rescheduling again.",
    );
    expect(middleware.operations.map((operation) => operation.kind)).toEqual([
      "book",
      "cancel",
    ]);
    expect(ownedMiddlewareFailures(state)).toMatchObject([
      { operation: "cancelAppointment", reason: "middleware_error" },
    ]);
    expect(state.identity.patient.appointments.map(({ id }) => id)).toEqual([
      123, 456,
    ]);
    expect(appointmentActions(state)).toMatchObject([
      { action: "rescheduled", status: "partial" },
    ]);
  });

  it("keeps the partial reschedule outcome when cancellation token validation fails", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      bookings: [bookingReceipt()],
      cancellations: [
        {
          status: "rejected",
          reason: "invalid_cancellation_token",
          message:
            "cancellationToken is invalid or expired. Please load appointments again and choose the appointment to cancel.",
        },
      ],
    });
    const { reschedule_appointment } = createSchedulingTools(middleware);
    const state = createState();
    prepareReschedule(state, {
      appointment: loadedAppointment({
        cancellationToken: "expired-cancellation-token",
      }),
    });
    const ctx = createToolContext(state);
    const args = {
      appointmentSlotRef: "S1",
      appointmentReason: "move my follow-up",
      referringDoctor: "none",
      readBack: true,
    };

    const result = await reschedule_appointment.execute(args, {
      ctx: ctx as never,
      toolCallId: "reschedule-1",
    } as never);
    const replay = await reschedule_appointment.execute(args, {
      ctx: ctx as never,
      toolCallId: "reschedule-2",
    } as never);

    expect(result).toBe(
      "Booked the new appointment for Monday, June 1 at 9:00 AM with Dr. Bach, but I could not cancel the old appointment. The old appointment was not cancelled. I need to transfer you so the office can finish the cancellation.",
    );
    expect(replay).toBe(
      "The new appointment was already booked, but the old appointment still needs office staff to finish cancellation. Transfer the caller instead of rescheduling again.",
    );
    expect(middleware.operations).toEqual([
      expect.objectContaining({ kind: "book" }),
      {
        kind: "cancel",
        office: "+17275919997",
        request: { cancellationToken: "expired-cancellation-token" },
      },
    ]);
    expect(ownedMiddlewareFailures(state)).toMatchObject([
      {
        operation: "cancelAppointment",
        reason: "invalid_cancellation_token",
      },
    ]);
  });

  it("records the same partial outcome when cancellation throws", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      bookings: [bookingReceipt()],
      cancellations: [new Error("request failed")],
    });
    const { reschedule_appointment } = createSchedulingTools(middleware);
    const state = createState();
    prepareReschedule(state);

    const result = await reschedule_appointment.execute(
      {
        appointmentSlotRef: "S1",
        appointmentReason: "move my follow-up",
        referringDoctor: "none",
        readBack: true,
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "reschedule-1",
      } as never,
    );

    expect(result).toContain(
      "The old appointment was not cancelled. I need to transfer you",
    );
    expect(state.identity.patient.appointments.map(({ id }) => id)).toEqual([
      123, 456,
    ]);
    expect(ownedMiddlewareFailures(state)).toMatchObject([
      { operation: "cancelAppointment", reason: "network_error" },
    ]);
    expect(state.identity.completedReschedulesByPatientId["patient-1"]).toEqual(
      {
        status: "needs_human_cancellation",
        appointmentDescription: "Monday, June 1 at 9:00 AM with Dr. Bach",
      },
    );
  });

  it("replays a completed reschedule without duplicate writes", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      bookings: [bookingReceipt()],
      cancellations: [{ status: "cancelled" }],
    });
    const { reschedule_appointment } = createSchedulingTools(middleware);
    const state = createState();
    prepareReschedule(state);
    const ctx = createToolContext(state);
    const args = {
      appointmentSlotRef: "S1",
      appointmentReason: "move my follow-up",
      referringDoctor: "none",
      readBack: true,
    };
    await reschedule_appointment.execute(args, {
      ctx: ctx as never,
      toolCallId: "reschedule-1",
    } as never);
    state.availability.slots = [availabilitySlot()];

    const replay = await reschedule_appointment.execute(args, {
      ctx: ctx as never,
      toolCallId: "reschedule-2",
    } as never);

    expect(replay).toBe(
      "The appointment is already rescheduled to Monday, June 1 at 9:00 AM with Dr. Bach. Tell the caller the confirmed appointment details instead of rescheduling again.",
    );
    expect(middleware.operations.map((operation) => operation.kind)).toEqual([
      "book",
      "cancel",
    ]);
  });

  it("allows a corrected alternate slot after a completed reschedule", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      bookings: [
        bookingReceipt(),
        bookingReceipt({ appointmentId: 789, startDatetime: "2026-06-03" }),
      ],
      cancellations: [{ status: "cancelled" }, { status: "cancelled" }],
    });
    const { reschedule_appointment } = createSchedulingTools(middleware);
    const state = createState();
    prepareReschedule(state);
    const ctx = createToolContext(state);
    await reschedule_appointment.execute(
      {
        appointmentSlotRef: "S1",
        appointmentReason: "move my follow-up",
        referringDoctor: "none",
        readBack: true,
      },
      { ctx: ctx as never, toolCallId: "reschedule-1" } as never,
    );
    const correctedSlot = availabilitySlot({
      slotId: "S2",
      date: "2026-06-03",
      time: "2:00 PM",
      datetime: "2026-06-03T14:00:00",
    });
    state.availability.slots = [correctedSlot];
    storeAvailabilityBookingToken(state, "S2", "corrected-token");

    const corrected = await reschedule_appointment.execute(
      {
        appointmentSlotRef: "S2",
        appointmentReason: "move my follow-up",
        referringDoctor: "none",
        readBack: true,
      },
      { ctx: ctx as never, toolCallId: "reschedule-2" } as never,
    );

    expect(corrected).toBe(
      "Rescheduled the appointment to Wednesday, June 3 at 2:00 PM with Dr. Bach. Cancelled the old appointment on 2026-06-01 at 9:00 AM.",
    );
    expect(middleware.operations.map((operation) => operation.kind)).toEqual([
      "book",
      "cancel",
      "book",
      "cancel",
    ]);
    expect(middleware.operations[3]).toMatchObject({
      kind: "cancel",
      request: { appointmentId: 456, patientId: "patient-1" },
    });
  });

  it("cancels the old appointment through its original office", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      bookings: [bookingReceipt()],
      cancellations: [{ status: "cancelled" }],
    });
    const { reschedule_appointment } = createSchedulingTools(middleware);
    const state = createState();
    state.office.phoneOverrides = {
      "spring-hill": "+17275919997",
      "crystal-river": "+13523202007",
    };
    prepareReschedule(state, {
      appointment: loadedAppointment({
        facility: "Crystal River",
        type: "Crystal River New Patient",
        appointmentTypeId: 6167,
      }),
    });

    await reschedule_appointment.execute(
      {
        appointmentSlotRef: "S1",
        appointmentReason: "move my follow-up",
        referringDoctor: "none",
        readBack: true,
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "reschedule-1",
      } as never,
    );

    expect(middleware.operations).toMatchObject([
      {
        kind: "book",
        office: "+17275919997",
        request: { patientStatus: "new" },
      },
      {
        kind: "cancel",
        office: "+13523202007",
        request: { appointmentId: 123 },
      },
    ]);
  });
});
