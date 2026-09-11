import { currentAppointmentReferences } from "../scheduling/appointments.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolError } from "@livekit/agents";

import {
  DEMO_BOOKING_OFFICE_PHONE,
  HOLLYWOOD_OFFICE_PHONE,
  NEW_TAMPA_DEMO_TRUNK_PHONE,
  SPRING_HILL_OFFICE_PHONE,
  SWEETWATER_OFFICE_PHONE,
} from "../customers/abita/profile.js";
import { HttpOwnedMiddleware } from "../clients/owned-middleware.js";
import type { AvailabilityResult } from "../clients/owned-middleware.js";
import { visitTypeForAppointment } from "../scheduling/routing.js";
import { createSchedulingTools } from "../scheduling/tools.js";
import {
  appointmentActions,
  domainOutcomeReceipts,
} from "../state/observability.js";
import {
  activeAppointments,
  normalizeCallerAppointments,
} from "../state/appointments.js";
import {
  clearAvailabilitySelection,
  storeAvailabilityBookingToken,
} from "../scheduling/availability.js";
import { type PatientActivation } from "../identity/patient-identity.js";
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

function activateExistingPatient(
  state: ReturnType<typeof createState>,
  patient: Omit<PatientActivation, "kind" | "backend"> & {
    insPlanId: string | null;
    respPartyId: string | null;
  },
) {
  const { insPlanId, respPartyId, ...activePatient } = patient;
  const next = createConfirmedPatientState({
    insuranceCarrier: patient.insuranceCarrier,
    checkedInsurancePlan: patient.insuranceCarrier,
    routing: patient.routing,
    preauthRequired: patient.preauthRequired,
    activePatient: {
      ...activePatient,
      kind: "existing",
      appointments: normalizeCallerAppointments(
        patient.appointments,
        patient.patientId,
      ),
      backend: { insPlanId, respPartyId },
    },
  });
  if (state.identity.activePatient?.patientId !== patient.patientId) {
    clearAvailabilitySelection(state, { invalidateReads: true });
    state.workflow = next.workflow;
  }
  state.identity.activePatient = next.identity.activePatient;
  state.identity.operationVersion += 1;
  state.identity.transitionVersion += 1;
  state.insurance = next.insurance;
}

function createHollywoodSweetwaterState(office: "hollywood" | "sweetwater") {
  const state = createState();
  const officePhone =
    office === "hollywood" ? HOLLYWOOD_OFFICE_PHONE : SWEETWATER_OFFICE_PHONE;
  state.office.activeKey = office;
  state.runtime.trunkPhone = officePhone;
  return state;
}

function availabilitySlot(
  overrides: Partial<StoredAvailabilitySlot> = {},
): StoredAvailabilitySlot {
  return {
    slotId: "S1",
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
  state.workflow.visitType = "medical";
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
  state.identity.activePatient!.appointments = [
    options.appointment ?? loadedAppointment(),
  ];
  const visitType = visitTypeForAppointment(activeAppointments(state)[0]!);
  state.workflow.visitType = visitType;
  const slot =
    options.slot ??
    availabilitySlot({
      routing: visitType === "medical" ? "all_three" : "optical_only",
    });
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
  activateExistingPatient(state, {
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
    preauthRequired: false,
  });
}

function restoreFirstPatient(
  state: ReturnType<typeof createState>,
  appointments: CallerAppointment[] = [],
) {
  activateExistingPatient(state, {
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
    preauthRequired: false,
  });
}

function loadedAppointmentRef(
  state: ReturnType<typeof createState>,
  index = 0,
): string {
  const appointmentRef = activeAppointments(state)[index]?.appointmentRef;
  if (!appointmentRef) throw new Error("Expected a loaded appointmentRef.");
  return appointmentRef;
}

describe("scheduling tools", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-30T16:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects concurrent duplicate scheduling writes", () => {
    const tools = createSchedulingTools(new InMemorySchedulingMiddleware());

    expect(tools.book_appointment.onDuplicate).toBe("reject");
    expect(tools.cancel_appointment.onDuplicate).toBe("reject");
    expect(tools.reschedule_appointment.onDuplicate).toBe("reject");
  });

  it.each(["medical", "routine_vision"] as const)(
    "uses %s as the scheduling visit type",
    async (visitType) => {
      const middleware = new InMemorySchedulingMiddleware({
        availability: [availabilityFound([returnedSlot()])],
      });
      const { list_available_appointments } = createSchedulingTools(middleware);
      const state = createState();

      await list_available_appointments.execute({ visitType }, {
        ctx: createToolContext(state) as never,
        toolCallId: "availability-1",
      } as never);

      expect(state.workflow.visitType).toBe(visitType);
      expect(middleware.operations).toHaveLength(1);
    },
  );

  it("blocks availability and booking for a partially registered patient", async () => {
    const middleware = new InMemorySchedulingMiddleware();
    const { book_appointment, list_available_appointments } =
      createSchedulingTools(middleware);
    const state = createState();
    state.identity.activePatient!.kind = "created";
    state.insurance.onFile = null;
    prepareBooking(state);
    const message =
      "The patient chart exists, but insurance is not attached. Connect the caller to office staff to finish registration before scheduling.";

    const availabilityResult = await list_available_appointments.execute(
      { visitType: "medical" },
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
      const { list_available_appointments } = createSchedulingTools(
        middleware,
        undefined,
        { availabilityOfficeMode: "required" },
      );
      const state = createHollywoodSweetwaterState(office);

      const result = await list_available_appointments.execute(
        {
          visitType: "medical",
        } as never,
        {
          ctx: createToolContext(state) as never,
          toolCallId: "tool-1",
        } as never,
      );

      expect(result.split("\n")[0]).toBe(
        "Ask whether the caller wants the Hollywood or Sweetwater office, then check availability again with that office.",
      );
      expect(middleware.operations).toEqual([]);
    },
  );

  it("searches the Hollywood schedule when a Sweetwater caller chooses Hollywood", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      availability: [availabilityFound([returnedSlot({ time: "10:00 AM" })])],
    });
    const { list_available_appointments } = createSchedulingTools(
      middleware,
      undefined,
      {
        availabilityOfficeMode: "required",
      },
    );
    const state = createHollywoodSweetwaterState("sweetwater");

    await list_available_appointments.execute(
      {
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

  it.each(["2026-05-29", "2026-05-30"])(
    "explains the earliest search date without querying or shifting %s",
    async (startDate) => {
      // Already May 31 in UTC, but still May 30 at the clinic.
      vi.setSystemTime(new Date("2026-05-31T02:00:00Z"));
      const middleware = new InMemorySchedulingMiddleware();
      const { list_available_appointments } = createSchedulingTools(middleware);
      const state = createState();
      const ctx = createToolContext(state);

      for (let attempt = 0; attempt < 3; attempt += 1) {
        await expect(
          list_available_appointments.execute(
            { startDate, visitType: "medical" },
            {
              ctx: ctx as never,
              toolCallId: `same-day-${attempt}`,
            } as never,
          ),
        ).resolves.toBe(
          "Same-day and past-date appointments cannot be scheduled here. The earliest search date is Sunday, May 31. Ask whether that date or later works; do not retry the same date or change it without the caller's agreement. Follow office policy if the caller needs help today.",
        );
      }
      expect(middleware.operations).toEqual([]);
      expect(state.availability.requestedStartDate).toBeUndefined();
    },
  );

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
    const { list_available_appointments } = createSchedulingTools(middleware);
    const state = createState();

    const result = await list_available_appointments.execute(
      {
        visitType: "medical",
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "availability-1",
      } as never,
    );

    expect(result).toContain("S1 — Monday, June 1 at 9:00 AM with Dr. Bach");
    expect(result).not.toContain("appointmentSlotRef");
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
          rangeDays: 14,
          startDate: "2026-05-31",
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
    const { book_appointment, list_available_appointments } =
      createSchedulingTools(middleware);
    const state = createState();
    const ctx = createToolContext(state);

    const availability = await list_available_appointments.execute(
      { visitType: "medical" },
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

    expect(availability).toContain(
      "S1 — Monday, June 1 at 9:00 AM with Dr. Bach",
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
    const { list_available_appointments } = createSchedulingTools(middleware);
    const state = createState();
    const args = {
      visitType: "medical" as const,
    };
    const ctx = createToolContext(state);

    const first = list_available_appointments.execute(args, {
      ctx: ctx as never,
      toolCallId: "availability-1",
    } as never);
    const second = list_available_appointments.execute(args, {
      ctx: ctx as never,
      toolCallId: "availability-2",
    } as never);
    vi.advanceTimersByTime(25);
    deferred.resolve(availabilityFound([returnedSlot()]));

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.stringContaining("S1 — Monday, June 1 at 9:00 AM with Dr. Bach"),
      expect.stringContaining("S1 — Monday, June 1 at 9:00 AM with Dr. Bach"),
    ]);
    expect(middleware.operations).toHaveLength(1);
  });

  it("keeps a settled availability read shared until its result is committed", async () => {
    const result = availabilityFound([returnedSlot()]);
    const middleware = new InMemorySchedulingMiddleware({
      availability: [result, availabilityFound([returnedSlot()])],
    });
    const { list_available_appointments } = createSchedulingTools(middleware);
    const state = createState();
    const ctx = createToolContext(state);
    const args = {
      visitType: "medical" as const,
    };
    let lateOverlap: Promise<string> | undefined;
    Object.defineProperty(result, "status", {
      configurable: true,
      get: () => {
        lateOverlap ??= list_available_appointments.execute(args, {
          ctx: ctx as never,
          toolCallId: "availability-overlap",
        } as never) as Promise<string>;
        return "found";
      },
    });

    const first = await list_available_appointments.execute(args, {
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
    const { list_available_appointments } = createSchedulingTools(middleware);
    const state = createState();
    const args = {
      visitType: "medical" as const,
    };
    const ctx = createToolContext(state);

    const first = await list_available_appointments.execute(args, {
      ctx: ctx as never,
      toolCallId: "availability-1",
    } as never);
    const second = await list_available_appointments.execute(args, {
      ctx: ctx as never,
      toolCallId: "availability-2",
    } as never);

    expect(first).toBe(
      "I couldn't find any openings from Monday, June 1 through Monday, June 15. What other day or time works for you?",
    );
    expect(second).toBe(first);
    expect(middleware.operations).toHaveLength(1);
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
    const { list_available_appointments } = createSchedulingTools(middleware);
    const state = createState();
    const ctx = createToolContext(state);
    const args = {
      visitType: "medical" as const,
    };

    const initial = await list_available_appointments.execute(args, {
      ctx: ctx as never,
      toolCallId: "availability-1",
    } as never);
    vi.setSystemTime(new Date("2026-05-30T16:15:00.000Z"));
    const refreshed = await list_available_appointments.execute(args, {
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
    const { list_available_appointments } = createSchedulingTools(middleware);
    const state = createState();
    const availability = list_available_appointments.execute(
      { visitType: "medical" },
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
    const { list_available_appointments } = createSchedulingTools(middleware);
    const state = createState();
    const ctx = createToolContext(state);
    const lookup = (toolCallId: string) =>
      list_available_appointments.execute({ visitType: "medical" }, {
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
    const { list_available_appointments } = createSchedulingTools(middleware);
    const state = createState();

    vi.setSystemTime(new Date("2026-05-30T16:15:00.000Z"));
    const response = await list_available_appointments.execute(
      { visitType: "medical" },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "availability-1",
      } as never,
    );

    expect(response).toBe(
      "Those openings expired before I could offer them. Let me check again.",
    );
    expect(
      middleware.operations.filter(
        (operation) => operation.kind === "availability",
      ),
    ).toHaveLength(2);
    expect(state.availability.slots).toEqual([]);
    expect(state.availability.bookingTokensBySlotId).toEqual({});
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
    const { book_appointment, list_available_appointments } =
      createSchedulingTools(middleware);
    const state = createState();
    const ctx = createToolContext(state);

    await list_available_appointments.execute({ visitType: "medical" }, {
      ctx: ctx as never,
      toolCallId: "availability-1",
    } as never);
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
        state.identity.activePatient!.patientId = "patient-2";
        return {};
      },
    },
    {
      name: "expanded range",
      change: () => ({ startDate: "2026-11-02" }),
    },
    {
      name: "date of birth",
      change: (state: ReturnType<typeof createState>) => {
        state.identity.activePatient!.dob = "02/02/1982";
        return {};
      },
    },
    {
      name: "provider office",
      change: (state: ReturnType<typeof createState>) => {
        state.office.activeKey = "crystal-river";
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
      const { list_available_appointments } = createSchedulingTools(middleware);
      const state = createState();
      const ctx = createToolContext(state);
      const args = {
        visitType: "medical" as const,
      };

      await list_available_appointments.execute(args, {
        ctx: ctx as never,
        toolCallId: "availability-1",
      } as never);
      await list_available_appointments.execute({ ...args, ...change(state) }, {
        ctx: ctx as never,
        toolCallId: "availability-2",
      } as never);

      expect(middleware.operations).toHaveLength(2);
    },
  );

  it("uses an explicit visit type when an existing appointment is loaded", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      availability: [availabilityFound([returnedSlot()])],
    });
    const { list_available_appointments } = createSchedulingTools(middleware);
    const state = createState();
    restoreFirstPatient(state, [
      loadedAppointment({
        type: "Established adult vision",
        appointmentTypeId: 4245,
      }),
    ]);
    state.workflow.visitType = null;

    await list_available_appointments.execute({ visitType: "medical" }, {
      ctx: createToolContext(state) as never,
      toolCallId: "availability-1",
    } as never);

    expect(state.workflow.visitType).toBe("medical");
    expect(middleware.operations).toMatchObject([
      {
        kind: "availability",
        request: expect.not.objectContaining({ routing: "optical_only" }),
      },
    ]);
  });

  it("keeps explicit new scheduling available when an appointment is already loaded", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      availability: [availabilityFound([returnedSlot()])],
    });
    const { list_available_appointments } = createSchedulingTools(middleware);
    const state = createState();
    restoreFirstPatient(state, [loadedAppointment()]);

    await list_available_appointments.execute({ visitType: "medical" }, {
      ctx: createToolContext(state) as never,
      toolCallId: "availability-1",
    } as never);

    expect(state.workflow.visitType).toBe("medical");
    expect(middleware.operations).toMatchObject([
      {
        kind: "availability",
        request: expect.not.objectContaining({ routing: "optical_only" }),
      },
    ]);
  });

  it("requires a visit type when listing without one", async () => {
    const middleware = new InMemorySchedulingMiddleware();
    const { list_available_appointments } = createSchedulingTools(middleware);
    const state = createState();
    restoreFirstPatient(state, [
      loadedAppointment(),
      loadedAppointment({
        id: 222,
        date: "Tuesday, June 2, 2026",
      }),
    ]);

    const result = await list_available_appointments.execute({}, {
      ctx: createToolContext(state) as never,
      toolCallId: "availability-1",
    } as never);

    expect(result.split("\n")[0]).toBe(
      "Is this visit for medical care or routine vision?",
    );
    expect(middleware.operations).toEqual([]);
  });

  it("uses explicit routine availability with a loaded appointment missing its type ID", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      availability: [availabilityFound([returnedSlot()])],
    });
    const { list_available_appointments } = createSchedulingTools(middleware);
    const state = createState();
    state.identity.activePatient!.appointments = [
      loadedAppointment({
        appointmentTypeId: undefined,
        type: "Optometry",
      }),
    ];

    await list_available_appointments.execute({ visitType: "routine_vision" }, {
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

  it("uses explicit routine availability with an unrecognized loaded type", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      availability: [availabilityFound([returnedSlot()])],
    });
    const { list_available_appointments } = createSchedulingTools(middleware);
    const state = createState();
    state.identity.activePatient!.appointments = [
      loadedAppointment({
        appointmentTypeId: 9999,
        type: "Medical visit",
      }),
    ];

    await list_available_appointments.execute({ visitType: "routine_vision" }, {
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
    const { list_available_appointments } = createSchedulingTools(middleware);
    const state = createState();
    state.identity.activePatient!.appointments = [
      loadedAppointment({
        appointmentTypeId: 1005,
        type: "Optometry",
      }),
    ];

    await list_available_appointments.execute({ visitType: "medical" }, {
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

  it("loads routine availability for a routine reschedule", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      availability: [availabilityFound([returnedSlot()])],
    });
    const { list_available_appointments } = createSchedulingTools(middleware);
    const state = createState();
    state.identity.activePatient!.appointments = [
      loadedAppointment({
        appointmentTypeId: 1010,
        type: "Medical visit",
      }),
    ];

    await list_available_appointments.execute({ visitType: "routine_vision" }, {
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
    const { list_available_appointments } = createSchedulingTools(
      middleware,
      undefined,
      {
        availabilityOfficeMode: "required",
      },
    );
    const state = createHollywoodSweetwaterState("sweetwater");
    const ctx = createToolContext(state);

    await list_available_appointments.execute(
      {
        visitType: "medical",
        office: "hollywood",
      },
      {
        ctx: ctx as never,
        toolCallId: "availability-1",
      } as never,
    );
    await list_available_appointments.execute(
      {
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
    const { list_available_appointments } = createSchedulingTools(middleware);
    const firstState = createState();
    const secondState = createState();
    const args = {
      visitType: "medical" as const,
    };

    const first = await list_available_appointments.execute(args, {
      ctx: createToolContext(firstState) as never,
      toolCallId: "first-call-1",
    } as never);
    const firstReplay = await list_available_appointments.execute(args, {
      ctx: createToolContext(firstState) as never,
      toolCallId: "first-call-2",
    } as never);
    const second = await list_available_appointments.execute(args, {
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

  it("preserves stable references when expanding the loaded inventory", async () => {
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
    const { book_appointment, list_available_appointments } =
      createSchedulingTools(middleware);
    const state = createState();
    const ctx = createToolContext(state);
    const args = {
      visitType: "medical" as const,
    };

    const initial = await list_available_appointments.execute(args, {
      ctx: ctx as never,
      toolCallId: "availability-1",
    } as never);
    const reranked = await list_available_appointments.execute(
      { ...args, startDate: "2026-11-02" },
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

    expect(initial).toContain("9:00 AM");
    expect(initial).toContain("2:00 PM");
    expect(reranked).toContain("2:00 PM");
    expect(reranked).toContain("3:00 PM");
    expect(`${initial} ${reranked}`).not.toContain("appointmentSlotRef");
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
    const { list_available_appointments } = createSchedulingTools(middleware);
    const state = createState();
    const ctx = createToolContext(state);
    const args = {
      visitType: "medical" as const,
    };

    await list_available_appointments.execute(args, {
      ctx: ctx as never,
      toolCallId: "availability-1",
    } as never);
    await list_available_appointments.execute(args, {
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
      const { list_available_appointments } = createSchedulingTools(middleware);
      const state = createState();
      const ctx = createToolContext(state);
      const args = {
        visitType: "medical" as const,
      };

      await expect(
        list_available_appointments.execute(args, {
          ctx: ctx as never,
          toolCallId: "availability-1",
        } as never),
      ).rejects.toThrow(message);
      await expect(
        list_available_appointments.execute(args, {
          ctx: ctx as never,
          toolCallId: "availability-2",
        } as never),
      ).resolves.toContain("S1 — Monday, June 1");

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
    const { list_available_appointments } = createSchedulingTools(middleware);
    const state = createState();
    const ctx = createToolContext(state);
    const controller = new AbortController();
    const args = {
      visitType: "medical" as const,
    };

    const abandoned = list_available_appointments.execute(args, {
      abortSignal: controller.signal,
      ctx: ctx as never,
      toolCallId: "availability-1",
    } as never);
    await Promise.resolve();
    expect(middleware.operations[0]).toMatchObject({
      kind: "availability",
      signal: controller.signal,
    });
    controller.abort();
    const retry = list_available_appointments.execute(args, {
      ctx: ctx as never,
      toolCallId: "availability-2",
    } as never);

    await expect(retry).resolves.toContain("10:00 AM");
    deferred.resolve(availabilityFound([returnedSlot()]));
    await expect(abandoned).resolves.toContain(
      "The patient or appointment changed while I was checking.",
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
    const { list_available_appointments } = createSchedulingTools(middleware);
    const state = createState();
    const ctx = createToolContext(state);
    const waiterController = new AbortController();
    const args = {
      visitType: "medical" as const,
    };

    const owner = list_available_appointments.execute(args, {
      ctx: ctx as never,
      toolCallId: "availability-owner",
    } as never);
    const waiter = list_available_appointments.execute(args, {
      abortSignal: waiterController.signal,
      ctx: ctx as never,
      toolCallId: "availability-waiter",
    } as never);
    waiterController.abort();
    deferred.resolve(availabilityFound([returnedSlot()]));

    await expect(owner).resolves.toContain("S1 — Monday, June 1");
    await expect(waiter).resolves.toContain(
      "The patient or appointment changed while I was checking.",
    );
    expect(middleware.operations).toHaveLength(1);
    expect(state.availability.slots).toEqual([
      expect.objectContaining({ slotId: "S1" }),
    ]);
  });

  it("allows one retry of an incomplete window, then stops identical backend reads", async () => {
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
      availability: [
        incomplete,
        incomplete,
        availabilityFound([returnedSlot()]),
      ],
    });
    const { list_available_appointments } = createSchedulingTools(middleware);
    const state = createState();
    const args = {
      visitType: "medical" as const,
    };
    const ctx = createToolContext(state);

    const first = await list_available_appointments.execute(args, {
      ctx: ctx as never,
      toolCallId: "availability-1",
    } as never);
    const second = await list_available_appointments.execute(args, {
      ctx: ctx as never,
      toolCallId: "availability-2",
    } as never);

    expect(first).toBe(
      "I couldn't finish checking availability from Monday, June 1 through Tuesday, June 2. Let me try once more.",
    );
    expect(second).toBe(
      "I still couldn't verify availability from Monday, June 1 through Tuesday, June 2. Do not retry this search or describe it as no openings. Offer staff help according to office policy.",
    );
    const third = await list_available_appointments.execute(args, {
      ctx: ctx as never,
      toolCallId: "availability-3",
    } as never);
    expect(third).toBe(second);
    expect(middleware.operations).toHaveLength(2);

    await expect(
      list_available_appointments.execute(
        { ...args, startDate: "2026-06-15" },
        {
          ctx: ctx as never,
          toolCallId: "availability-another-window",
        } as never,
      ),
    ).resolves.toContain("Loaded 1 eligible appointments");
    expect(middleware.operations).toHaveLength(3);

    await expect(
      list_available_appointments.execute(args, {
        ctx: ctx as never,
        toolCallId: "availability-original-window",
      } as never),
    ).resolves.toBe(second);
    expect(middleware.operations).toHaveLength(3);
  });

  it("counts shared incomplete reads once and resets the budget for another patient", async () => {
    const deferred = deferredResult<AvailabilityResult>();
    const incomplete: AvailabilityResult = {
      status: "incomplete",
      slots: [],
      dateShifted: false,
      shouldRetrySameSearch: true,
    };
    const middleware = new InMemorySchedulingMiddleware({
      availability: [
        deferred.promise,
        incomplete,
        availabilityFound([returnedSlot()]),
      ],
    });
    const { list_available_appointments } = createSchedulingTools(middleware);
    const state = createState();
    const ctx = createToolContext(state);
    const search = (toolCallId: string) =>
      list_available_appointments.execute({ visitType: "medical" }, {
        ctx: ctx as never,
        toolCallId,
      } as never);
    const owner = search("owner");
    const waiter = search("waiter");
    deferred.resolve(incomplete);

    for (const result of await Promise.all([owner, waiter])) {
      expect(result).toContain("Let me try once more.");
    }
    expect(middleware.operations).toHaveLength(1);
    await expect(search("retry")).resolves.toContain(
      "Do not retry this search",
    );
    await expect(search("exhausted")).resolves.toContain(
      "Do not retry this search",
    );
    expect(middleware.operations).toHaveLength(2);

    switchActivePatient(state);
    await expect(search("another-patient")).resolves.toContain(
      "Loaded 1 eligible appointments",
    );
    expect(middleware.operations).toHaveLength(3);
  });

  it("preserves the retry limit and diagnostic when an incomplete search retries with a network error", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      availability: [
        {
          status: "incomplete",
          slots: [],
          dateShifted: false,
          shouldRetrySameSearch: true,
        },
        { status: "error", reason: "network_error" },
      ],
    });
    const { list_available_appointments } = createSchedulingTools(middleware);
    const state = createState();
    const search = (toolCallId: string) =>
      list_available_appointments.execute({ visitType: "medical" }, {
        ctx: createToolContext(state) as never,
        toolCallId,
      } as never);

    await expect(search("first")).resolves.toContain("Let me try once more.");
    for (const toolCallId of ["retry", "exhausted"]) {
      const failure = search(toolCallId);
      await expect(failure).rejects.toBeInstanceOf(ToolError);
      await expect(failure).rejects.toThrow("Do not retry this search");
    }
    expect(middleware.operations).toHaveLength(2);
  });

  it("surfaces a middleware failure without exposing backend details", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      availability: [
        {
          status: "error",
          reason: "middleware_error",
        },
      ],
    });
    const { list_available_appointments } = createSchedulingTools(middleware);
    const state = createState();

    await expect(
      list_available_appointments.execute({ visitType: "medical" }, {
        ctx: createToolContext(state) as never,
        toolCallId: "availability-1",
      } as never),
    ).rejects.toThrow(
      "I couldn't check availability. I can try once more or connect you with the office.",
    );
  });

  it("leaves an invalid availability response as an internal error", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      availability: [{ status: "error", reason: "invalid_response" }],
    });
    const { list_available_appointments } = createSchedulingTools(middleware);
    const state = createState();

    const failure = list_available_appointments.execute(
      { visitType: "medical" },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "availability-1",
      } as never,
    );

    await expect(failure).rejects.toThrow(
      "Owned Middleware returned a non-retryable failure.",
    );
    await expect(failure).rejects.not.toBeInstanceOf(ToolError);
  });

  it("discards availability returned after the active patient changes", async () => {
    let resolveAvailability: (value: unknown) => void = () => undefined;
    const deferred = new Promise((resolve) => {
      resolveAvailability = resolve;
    });
    const middleware = new InMemorySchedulingMiddleware({
      availability: [deferred],
    });
    const { list_available_appointments } = createSchedulingTools(middleware);
    const state = createState();
    const pending = list_available_appointments.execute(
      {
        visitType: "medical",
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "availability-1",
      } as never,
    );

    activateExistingPatient(state, {
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
      preauthRequired: false,
    });
    resolveAvailability(availabilityFound([returnedSlot()]));

    await expect(pending).resolves.toBe(
      "The patient or appointment changed while I was checking. Let me check again with the current details.",
    );
    expect(state.availability.slots).toEqual([]);
    expect(state.availability.bookingTokensBySlotId).toEqual({});
  });

  it("discards a late result after patient context changes away and back", async () => {
    const deferred = deferredResult<ReturnType<typeof availabilityFound>>();
    const middleware = new InMemorySchedulingMiddleware({
      availability: [deferred.promise],
    });
    const { list_available_appointments } = createSchedulingTools(middleware);
    const state = createState();

    const pending = list_available_appointments.execute(
      {
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
      "The patient or appointment changed while I was checking.",
    );
    expect(state.identity.activePatient!.patientId).toBe("patient-1");
    expect(state.availability.slots).toEqual([]);
    expect(state.availability.bookingTokensBySlotId).toEqual({});
  });

  it("preserves medical and routine-vision office capabilities", async () => {
    const middleware = new InMemorySchedulingMiddleware();
    const { list_available_appointments } = createSchedulingTools(middleware);
    const opticalState = createState();
    opticalState.office.activeKey = "north-miami-beach-optical";
    const medicalResult = await list_available_appointments.execute(
      { visitType: "medical" },
      {
        ctx: createToolContext(opticalState) as never,
        toolCallId: "medical-1",
      } as never,
    );
    const medicalState = createState();
    medicalState.office.activeKey = "crystal-river";
    const routineResult = await list_available_appointments.execute(
      { visitType: "routine_vision" },
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
    state.workflow.visitType = "medical";
    state.availability.slots = [
      {
        slotId: "S1",
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

    expect(result.split("\n")[0]).toBe(
      "Booked Monday, July 27 at 9:00 AM with Dr. Bach.",
    );
    expect(result).toContain("appointmentRef");
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
    expect(state.identity.activePatient!.appointments).toContainEqual(
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
        externalPatientId: "patient-1",
        newAppointmentId: "456",
        bookingResult: expect.objectContaining({
          status: "booked",
          appointmentId: 456,
        }),
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

  it("cancels a newly booked appointment using only its returned reference", async () => {
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
      /appointmentRef (appointment-[a-f0-9]+)/,
    )?.[1];

    expect(appointmentRef).toBeDefined();
    expect(bookingResult).toContain("do not read aloud");
    expect(bookingResult).not.toContain("private-token");
    expect(bookingResult).not.toContain("patient-1");
    expect(bookingResult).not.toContain("appointmentId");

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
    expect(state.identity.activePatient!.appointments).toEqual([]);
    expect(domainOutcomeReceipts(state)[0]?.evidence).not.toHaveProperty(
      "message",
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
    const { book_appointment, list_available_appointments } =
      createSchedulingTools(middleware);
    const state = createState();
    const ctx = createToolContext(state);
    const availabilityArgs = {
      visitType: "medical" as const,
    };

    await list_available_appointments.execute(availabilityArgs, {
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
    const refreshed = await list_available_appointments.execute(
      availabilityArgs,
      {
        ctx: ctx as never,
        toolCallId: "availability-2",
      } as never,
    );

    expect(refreshed).toContain("10:00 AM");
    expect(middleware.operations.map(({ kind }) => kind)).toEqual([
      "availability",
      "book",
      "availability",
    ]);
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
        readBack: null,
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "booking-1",
      } as never,
    );

    expect(result.split("\n")[0]).toBe(
      "Let me confirm: Monday, June 1 at 9:00 AM with Dr. Bach. Is that correct?",
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

    const failure = book_appointment.execute(
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

    await expect(failure).rejects.toThrow(
      "Owned Middleware returned a non-retryable failure.",
    );
    await expect(failure).rejects.not.toBeInstanceOf(ToolError);
    expect(state.identity.activePatient!.appointments).toEqual([]);
    expect(appointmentActions(state)).toMatchObject([
      { action: "booked", status: "error" },
    ]);
  });

  it.each([
    {
      name: "patient status and DOB",
      missing: ["patientStatus", "dob"] as const,
      message:
        "I couldn't book that yet. Is the patient new or established, and what is their date of birth?",
    },
    {
      name: "Spring Hill routine vision routing",
      missing: ["routeToSpringHill"] as const,
      message:
        "I couldn't book that here. Let me check routine vision availability at Spring Hill.",
    },
    {
      name: "medical appointment lane",
      missing: ["appointmentLane"] as const,
      message:
        "I couldn't book that. Let me check Spring Hill medical availability.",
    },
    {
      name: "supported medical routing",
      missing: ["routing"] as const,
      message:
        "I couldn't book that at this office. Let me check an office that supports the visit.",
    },
    {
      name: "scheduling office",
      missing: ["office"] as const,
      message: "I couldn't book that yet. Which office would you prefer?",
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

      expect(result.split("\n")[0]).toBe(message);
      expect(state.availability.slots.map((slot) => slot.slotId)).toEqual([
        "S1",
      ]);
      expect(state.availability.bookingTokensBySlotId).toEqual({
        S1: "private-token",
      });
    },
  );

  it("removes an unavailable slot and refreshes instead of offering an arbitrary alternative", async () => {
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

    expect(result.split("\n")[0]).toBe(
      "That time is no longer available. Let me refresh the appointments and find another time that fits.",
    );
    expect(result).not.toContain("2:00 PM");
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
    const { book_appointment, list_available_appointments } =
      createSchedulingTools(middleware);
    const state = createState();
    const ctx = createToolContext(state);
    const args = {
      visitType: "medical" as const,
    };

    await list_available_appointments.execute(args, {
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
    const refreshed = await list_available_appointments.execute(args, {
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

    expect(replay.split("\n")[0]).toBe("That appointment is already booked.");
    expect(middleware.operations).toHaveLength(1);
    expect(domainOutcomeReceipts(state)).toMatchObject([
      {
        callId: "booking-1",
        outcome: "booked",
        status: "success",
        toolName: "book_appointment",
      },
      {
        callId: "booking-2",
        outcome: "booked",
        status: "success",
        toolName: "book_appointment",
      },
    ]);
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

    activateExistingPatient(state, {
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
    expect(state.identity.activePatient!.appointments).toContainEqual(
      expect.objectContaining({ id: 789 }),
    );
  });

  it("does not append appointment references after an identity transition during booking", async () => {
    const deferred = deferredResult<ReturnType<typeof bookingReceipt>>();
    const middleware = new InMemorySchedulingMiddleware({
      bookings: [deferred.promise],
    });
    const { book_appointment } = createSchedulingTools(middleware);
    const state = createState();
    prepareBooking(state);
    const pending = book_appointment.execute(
      {
        appointmentSlotRef: "S1",
        appointmentReason: "follow-up",
        referringDoctor: "none",
        readBack: true,
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "booking-transition",
      } as never,
    );
    state.identity.transitionVersion += 1;
    deferred.resolve(bookingReceipt());
    const result = await pending;
    expect(result).toContain("Booked");
    expect(currentAppointmentReferences(state)).toContain("appointmentRef");
    expect(result).not.toContain("appointmentRef");
    expect(middleware.operations).toHaveLength(1);
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

    expect(result).toContain("The patient changed while I was working.");
    expect(result).not.toContain("appointmentRef");
    expect(result).not.toContain("999");
    expect(state.identity.activePatient!).toMatchObject({
      patientId: "patient-2",
    });
    expect(state.identity.activePatient!.appointments).toEqual([
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

    expect(replay).toContain("That appointment is already booked.");
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

    expect(result.split("\n")[0]).toBe(
      "Cancelled the appointment on Monday, June 1, 2026 at 9:00 AM.",
    );
    expect(replay.split("\n")[0]).toBe(
      "That appointment was already cancelled on this call. It was scheduled for Monday, June 1, 2026 at 9:00 AM.",
    );
    expect(middleware.operations).toEqual([
      {
        kind: "cancel",
        office: "+17275919997",
        request: { appointmentId: 123, patientId: "patient-1" },
      },
    ]);
    expect(state.identity.activePatient!.appointments).toEqual([]);
    expect(appointmentActions(state)).toMatchObject([
      {
        action: "cancelled",
        status: "success",
        toolName: "cancel_appointment",
        cancelledAppointment: { patientName: "Jane Doe" },
      },
    ]);
    expect(domainOutcomeReceipts(state)).toMatchObject([
      {
        callId: "cancel-1",
        outcome: "cancelled",
        status: "success",
        toolName: "cancel_appointment",
      },
      {
        callId: "cancel-2",
        outcome: "cancelled",
        status: "success",
        toolName: "cancel_appointment",
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
    const { cancel_appointment, list_available_appointments } =
      createSchedulingTools(middleware);
    const state = createState();
    restoreFirstPatient(state, [loadedAppointment()]);
    const ctx = createToolContext(state);
    const args = {
      visitType: "medical" as const,
    };

    await list_available_appointments.execute(args, {
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
    const refreshed = await list_available_appointments.execute(args, {
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
    expect(
      state.identity.activePatient!.appointments.map(({ id }) => id),
    ).toEqual([222]);
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
    const ownedMiddleware = new HttpOwnedMiddleware({
      fetch: fetchMock,
      middlewareBaseUrl: "https://middleware.test",
    });
    const { cancel_appointment } = createSchedulingTools(ownedMiddleware);
    const state = createState();
    state.office.activeKey = "spring-hill";
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

    expect(result.split("\n")[0]).toBe(
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
    expect(state.identity.activePatient!.appointments).toEqual([
      expect.objectContaining(loadedAppointment()),
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

    expect(result.split("\n")[0]).toBe(
      "The appointment details expired. I need to reload the appointments and confirm which one you want to cancel.",
    );
    expect(middleware.operations).toEqual([
      {
        kind: "cancel",
        office: "+17275919997",
        request: { cancellationToken: "expired-cancellation-token" },
      },
    ]);
    expect(state.identity.activePatient!).toMatchObject({
      appointments: [],
      appointmentsStatus: "error",
    });

    await expect(
      cancel_appointment.execute({ appointmentRef }, {
        ctx: ctx as never,
        toolCallId: "cancel-2",
      } as never),
    ).resolves.toBe(
      `I couldn't match that appointment. Which upcoming appointment would you like to cancel?`,
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

    expect(result.split("\n")[0]).toBe(
      "I need to reload the appointments and confirm the exact one before cancelling.",
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
      `I couldn't match that appointment. Which upcoming appointment would you like to cancel?\n${currentAppointmentReferences(state)}`,
    );
    expect(middleware.operations).toEqual([]);
    expect(state.identity.activePatient!.appointments).toHaveLength(1);
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
      `Which upcoming appointment would you like to cancel?\n${currentAppointmentReferences(state)}`,
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
    ).resolves.toBe(`Which upcoming appointment would you like to cancel?`);
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
      `I couldn't match that appointment. Which upcoming appointment would you like to cancel?\n${currentAppointmentReferences(state)}`,
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
      state.identity.activePatient!.appointments.map(
        ({ id, appointmentRef }) => [id, appointmentRef],
      ),
    );

    restoreFirstPatient(state, [second, first]);

    expect(
      new Map(
        state.identity.activePatient!.appointments.map(
          ({ id, appointmentRef }) => [id, appointmentRef],
        ),
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
      "Cancelled the appointment on Monday, June 1, 2026 at 9:00 AM.",
    );
    expect(state.identity.activePatient!).toMatchObject({
      patientId: "patient-2",
    });
    expect(state.identity.activePatient!.appointments).toEqual([
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
        externalPatientId: "patient-1",
        oldAppointmentId: "123",
        cancellationResult: { status: "cancelled" },
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

    activateExistingPatient(state, {
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

  it("rejects medical rescheduling into routine inventory", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      availability: [availabilityFound([returnedSlot()])],
      bookings: [bookingReceipt()],
      cancellations: [{ status: "cancelled" }],
    });
    const { list_available_appointments, reschedule_appointment } =
      createSchedulingTools(middleware);
    const state = createState();
    restoreFirstPatient(state, [
      loadedAppointment({
        type: "Established adult vision",
        appointmentTypeId: 4245,
      }),
      loadedAppointment({
        id: 222,
        date: "Tuesday, June 2, 2026",
        type: "Follow-up",
        appointmentTypeId: 1005,
      }),
    ]);
    const differentAppointmentRef = loadedAppointmentRef(state, 1);
    const ctx = createToolContext(state);

    await list_available_appointments.execute(
      {
        visitType: "routine_vision",
      },
      {
        ctx: ctx as never,
        toolCallId: "availability-1",
      } as never,
    );
    const result = await reschedule_appointment.execute(
      {
        oldAppointmentRef: differentAppointmentRef,
        appointmentSlotRef: "S1",
        appointmentReason: "move my appointment",
        referringDoctor: "none",
        readBack: true,
      },
      {
        ctx: ctx as never,
        toolCallId: "reschedule-1",
      } as never,
    );

    expect(result.split("\n")[0]).toBe(
      "The existing appointment is medical. Load matching availability before rescheduling it.",
    );
    expect(middleware.operations.map(({ kind }) => kind)).toEqual([
      "availability",
    ]);
  });

  it("reschedules the explicit old appointment using generic availability", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      availability: [availabilityFound([returnedSlot()])],
      bookings: [bookingReceipt()],
      cancellations: [{ status: "cancelled" }],
    });
    const { list_available_appointments, reschedule_appointment } =
      createSchedulingTools(middleware);
    const state = createState();
    restoreFirstPatient(state, [
      loadedAppointment({
        cancellationToken: "selected-appointment-token",
      }),
      loadedAppointment({
        id: 222,
        date: "Tuesday, June 2, 2026",
        cancellationToken: "other-appointment-token",
      }),
    ]);
    const selectedAppointmentRef = loadedAppointmentRef(state, 0);
    const ctx = createToolContext(state);

    await list_available_appointments.execute(
      {
        visitType: "medical",
      },
      {
        ctx: ctx as never,
        toolCallId: "availability-1",
      } as never,
    );
    await reschedule_appointment.execute(
      {
        oldAppointmentRef: selectedAppointmentRef,
        appointmentSlotRef: "S1",
        appointmentReason: "move my appointment",
        referringDoctor: "none",
        readBack: true,
      },
      {
        ctx: ctx as never,
        toolCallId: "reschedule-1",
      } as never,
    );

    expect(middleware.operations.map(({ kind }) => kind)).toEqual([
      "availability",
      "book",
      "cancel",
    ]);
    expect(middleware.operations[2]).toMatchObject({
      kind: "cancel",
      request: {
        cancellationToken: "selected-appointment-token",
      },
    });
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
    state.workflow.visitType = null;
    state.identity.activePatient!.appointments = [
      {
        id: 123,
        cancellationToken: "private-reschedule-cancellation-token",
        rescheduleToken: "private-reschedule-token",
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
        oldAppointmentRef: loadedAppointmentRef(state),
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

    expect(result.split("\n")[0]).toBe(
      "Rescheduled the appointment to Wednesday, June 3 at 10:00 AM with Dr. Bach. Cancelled the old appointment on Monday, June 1, 2026 at 9:00 AM.",
    );
    expect(middleware.operations.map((operation) => operation.kind)).toEqual([
      "book",
      "cancel",
    ]);
    expect(middleware.operations[0]).toMatchObject({
      kind: "book",
      request: {
        appointmentTypeId: 1005,
        rescheduleToken: "private-reschedule-token",
      },
    });
    expect(middleware.operations[1]).toMatchObject({
      kind: "cancel",
      request: {
        cancellationToken: "private-reschedule-cancellation-token",
      },
    });
    expect(
      JSON.stringify({ result, appointmentActions: appointmentActions(state) }),
    ).not.toContain("private-reschedule-cancellation-token");
    expect(state.identity.activePatient!.appointments).toEqual([
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

  it("sends a signed reschedule type through booking even when the type is not recognized", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      bookings: [bookingReceipt()],
      cancellations: [{ status: "cancelled" }],
    });
    const { reschedule_appointment } = createSchedulingTools(middleware);
    const state = createState();
    prepareReschedule(state, {
      appointment: loadedAppointment({
        appointmentTypeId: 9999,
        cancellationToken: "private-cancellation-token",
        rescheduleToken: "signed-unknown-type-appointment",
      }),
      slot: availabilitySlot({ routing: "optical_only" }),
    });

    await reschedule_appointment.execute(
      {
        oldAppointmentRef: loadedAppointmentRef(state),
        appointmentSlotRef: "S1",
        appointmentReason: "move my appointment",
        referringDoctor: "none",
        readBack: true,
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "reschedule-1",
      } as never,
    );

    expect(middleware.operations[0]).toMatchObject({
      kind: "book",
      request: {
        appointmentTypeId: 9999,
        rescheduleToken: "signed-unknown-type-appointment",
        routing: "optical_only",
      },
    });
  });

  it("reloads appointments when the reschedule authorization expires", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      bookings: [
        {
          status: "rejected",
          reason: "invalid_reschedule_token",
        },
      ],
    });
    const { reschedule_appointment } = createSchedulingTools(middleware);
    const state = createState();
    prepareReschedule(state, {
      appointment: loadedAppointment({
        cancellationToken: "private-cancellation-token",
        rescheduleToken: "expired-reschedule-token",
      }),
    });

    const result = await reschedule_appointment.execute(
      {
        oldAppointmentRef: loadedAppointmentRef(state),
        appointmentSlotRef: "S1",
        appointmentReason: "move my appointment",
        referringDoctor: "none",
        readBack: true,
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "reschedule-1",
      } as never,
    );

    expect(result.split("\n")[0]).toBe(
      "I couldn't reschedule because the appointment details expired. Your existing appointment is still scheduled. I need to reload it and check availability again.",
    );
    expect(middleware.operations.map(({ kind }) => kind)).toEqual(["book"]);
    expect(state.identity.activePatient!.appointments).toEqual([]);
    expect(state.identity.activePatient!.appointmentsStatus).toBe("error");
    expect(state.availability.slots).toEqual([]);
  });

  it("invalidates a selected reschedule when the loaded appointment type changes", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      availability: [availabilityFound([returnedSlot()])],
    });
    const { list_available_appointments, reschedule_appointment } =
      createSchedulingTools(middleware);
    const state = createState();
    restoreFirstPatient(state, [
      loadedAppointment({
        appointmentTypeId: 4245,
        cancellationToken: "private-cancellation-token",
        rescheduleToken: "private-reschedule-token",
      }),
    ]);

    await list_available_appointments.execute({ visitType: "routine_vision" }, {
      ctx: createToolContext(state) as never,
      toolCallId: "availability-1",
    } as never);
    const originalRef = loadedAppointmentRef(state);
    restoreFirstPatient(state, [
      loadedAppointment({
        appointmentTypeId: 9999,
        cancellationToken: "refreshed-cancellation-token",
        rescheduleToken: "refreshed-reschedule-token",
      }),
    ]);

    const result = await reschedule_appointment.execute(
      {
        oldAppointmentRef: originalRef,
        appointmentSlotRef: "S1",
        appointmentReason: "move my appointment",
        referringDoctor: "none",
        readBack: true,
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "reschedule-1",
      } as never,
    );
    expect(result.split("\n")[0]).toBe(
      "I couldn't match that appointment. Which upcoming appointment would you like to reschedule?",
    );
    expect(middleware.operations.map(({ kind }) => kind)).toEqual([
      "availability",
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
    const { list_available_appointments, reschedule_appointment } =
      createSchedulingTools(middleware);
    const state = createState();
    restoreFirstPatient(state, [loadedAppointment()]);
    const ctx = createToolContext(state);
    const args = { visitType: "medical" };

    await list_available_appointments.execute(args, {
      ctx: ctx as never,
      toolCallId: "availability-1",
    } as never);
    await reschedule_appointment.execute(
      {
        oldAppointmentRef: loadedAppointmentRef(state),
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
    const refreshed = await list_available_appointments.execute(args, {
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
        oldAppointmentRef: loadedAppointmentRef(state),
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
        oldAppointmentRef: loadedAppointmentRef(state),
        appointmentSlotRef: "S1",
        appointmentReason: "move my follow-up",
        referringDoctor: "none",
        readBack: null,
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "reschedule-1",
      } as never,
    );

    expect(result.split("\n")[0]).toBe(
      "Let me confirm the new appointment: Monday, June 1 at 9:00 AM with Dr. Bach. Is that correct?",
    );
    expect(middleware.operations).toEqual([]);
  });

  it("requires an explicit old reference before rescheduling", async () => {
    const middleware = new InMemorySchedulingMiddleware();
    const { reschedule_appointment } = createSchedulingTools(middleware);
    const state = createState();
    prepareReschedule(state);
    state.identity.activePatient!.appointments = [
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

    expect(result.split("\n")[0]).toBe(
      "Which upcoming appointment would you like to reschedule?",
    );
    expect(result).not.toContain("oldAppointmentRef");
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

    const result = await reschedule_appointment.execute(
      {
        oldAppointmentRef: loadedAppointmentRef(state),
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

    expect(result.split("\n")[0]).toBe(
      "I need to reload the appointments and confirm the exact one before rescheduling.",
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
        oldAppointmentRef: loadedAppointmentRef(state),
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
    expect(result).not.toContain("appointmentRef");
    expect(result).not.toContain("999");
    expect(middleware.operations.map(({ kind }) => kind)).toEqual(["book"]);
    expect(state.identity.activePatient!).toMatchObject({
      patientId: "patient-2",
    });
    expect(state.identity.activePatient!.appointments).toEqual([
      expect.objectContaining(currentAppointment),
    ]);

    restoreFirstPatient(state, [loadedAppointment()]);
    const replay = await reschedule_appointment.execute(
      {
        oldAppointmentRef: loadedAppointmentRef(state),
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
        oldAppointmentRef: loadedAppointmentRef(state),
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
      "Rescheduled the appointment to Monday, June 1 at 9:00 AM with Dr. Bach. Cancelled the old appointment on Monday, June 1, 2026 at 9:00 AM.",
    );
    expect(state.identity.activePatient!).toMatchObject({
      patientId: "patient-2",
    });
    expect(state.identity.activePatient!.appointments).toEqual([
      expect.objectContaining(currentAppointment),
    ]);

    restoreFirstPatient(state, [loadedAppointment()]);
    const replay = await reschedule_appointment.execute(
      {
        oldAppointmentRef: loadedAppointmentRef(state),
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
        externalPatientId: "patient-1",
        oldAppointmentId: "123",
        newAppointmentId: "456",
        bookingResult: expect.objectContaining({
          status: "booked",
          appointmentId: 456,
        }),
        cancellationResult: { status: "cancelled" },
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
        oldAppointmentRef: loadedAppointmentRef(state),
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

    expect(result.split("\n")[0]).toBe(
      "That time is no longer available. Let me refresh the appointments and find another time that fits. I did not cancel the existing appointment.",
    );
    expect(middleware.operations.map((operation) => operation.kind)).toEqual([
      "book",
    ]);
    expect(state.identity.activePatient!.appointments).toEqual([
      loadedAppointment(),
    ]);
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
          oldAppointmentRef: loadedAppointmentRef(state),
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
    expect(state.identity.activePatient!.appointments).toEqual([
      loadedAppointment(),
    ]);
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
      oldAppointmentRef: loadedAppointmentRef(state),
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

    expect(result.split("\n")[0]).toBe(
      "Booked the new appointment for Monday, June 1 at 9:00 AM with Dr. Bach, but I could not cancel the old appointment. The old appointment was not cancelled. I need to transfer you so the office can finish the cancellation.",
    );
    expect(replay.split("\n")[0]).toBe(
      "The new appointment is booked, but the old appointment still needs office staff to cancel it. Would you like me to transfer you?",
    );
    expect(middleware.operations.map((operation) => operation.kind)).toEqual([
      "book",
      "cancel",
    ]);
    expect(
      state.identity.activePatient!.appointments.map(({ id }) => id),
    ).toEqual([123, 456]);
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
      oldAppointmentRef: loadedAppointmentRef(state),
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

    expect(result.split("\n")[0]).toBe(
      "Booked the new appointment for Monday, June 1 at 9:00 AM with Dr. Bach, but I could not cancel the old appointment. The old appointment was not cancelled. I need to transfer you so the office can finish the cancellation.",
    );
    expect(replay.split("\n")[0]).toBe(
      "The new appointment is booked, but the old appointment still needs office staff to cancel it. Would you like me to transfer you?",
    );
    expect(middleware.operations).toEqual([
      expect.objectContaining({ kind: "book" }),
      {
        kind: "cancel",
        office: "+17275919997",
        request: { cancellationToken: "expired-cancellation-token" },
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
        oldAppointmentRef: loadedAppointmentRef(state),
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
    expect(
      state.identity.activePatient!.appointments.map(({ id }) => id),
    ).toEqual([123, 456]);
    expect(state.identity.completedReschedulesByPatientId["patient-1"]).toEqual(
      {
        status: "needs_human_cancellation",
        originalAppointmentRef: loadedAppointmentRef(state),
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
      oldAppointmentRef: loadedAppointmentRef(state),
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

    expect(replay.split("\n")[0]).toBe(
      "You're already rescheduled for Monday, June 1 at 9:00 AM with Dr. Bach.",
    );
    expect(middleware.operations.map((operation) => operation.kind)).toEqual([
      "book",
      "cancel",
    ]);
  });

  it("allows a corrected alternate slot after a completed reschedule", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      bookings: [
        bookingReceipt({
          appointmentTypeId: 9999,
          rescheduleToken: "replacement-reschedule-token",
        }),
        bookingReceipt({
          appointmentId: 789,
          appointmentTypeId: 9999,
          rescheduleToken: "corrected-reschedule-token",
          startDatetime: "2026-06-03",
        }),
      ],
      cancellations: [{ status: "cancelled" }, { status: "cancelled" }],
    });
    const { reschedule_appointment } = createSchedulingTools(middleware);
    const state = createState();
    prepareReschedule(state, {
      appointment: loadedAppointment({
        appointmentTypeId: 9999,
        cancellationToken: "original-cancellation-token",
        rescheduleToken: "original-reschedule-token",
      }),
    });
    const ctx = createToolContext(state);
    await reschedule_appointment.execute(
      {
        oldAppointmentRef: loadedAppointmentRef(state),
        appointmentSlotRef: "S1",
        appointmentReason: "move my follow-up",
        referringDoctor: "none",
        readBack: true,
      },
      { ctx: ctx as never, toolCallId: "reschedule-1" } as never,
    );
    const correctedSlot = availabilitySlot({
      slotId: "S2",
      routing: "optical_only",
      date: "2026-06-03",
      time: "2:00 PM",
      datetime: "2026-06-03T14:00:00",
    });
    state.availability.slots = [correctedSlot];
    storeAvailabilityBookingToken(state, "S2", "corrected-token");

    const corrected = await reschedule_appointment.execute(
      {
        oldAppointmentRef: loadedAppointmentRef(state),
        appointmentSlotRef: "S2",
        appointmentReason: "move my follow-up",
        referringDoctor: "none",
        readBack: true,
      },
      { ctx: ctx as never, toolCallId: "reschedule-2" } as never,
    );

    expect(corrected.split("\n")[0]).toBe(
      "Rescheduled the appointment to Wednesday, June 3 at 2:00 PM with Dr. Bach. Cancelled the old appointment on 2026-06-01 at 9:00 AM.",
    );
    expect(middleware.operations.map((operation) => operation.kind)).toEqual([
      "book",
      "cancel",
      "book",
      "cancel",
    ]);
    expect(middleware.operations[2]).toMatchObject({
      kind: "book",
      request: {
        appointmentTypeId: 9999,
        rescheduleToken: "replacement-reschedule-token",
      },
    });
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
    prepareReschedule(state, {
      appointment: loadedAppointment({
        facility: "Crystal River",
        type: "Crystal River New Patient",
        appointmentTypeId: 6167,
      }),
    });

    await reschedule_appointment.execute(
      {
        oldAppointmentRef: loadedAppointmentRef(state),
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

  it("keeps demo reschedule booking and cancellation on the shared demo account", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      bookings: [bookingReceipt()],
      cancellations: [{ status: "cancelled" }],
    });
    const { reschedule_appointment } = createSchedulingTools(middleware);
    const state = createState();
    state.office.activeKey = "new-tampa-demo";
    state.runtime.trunkPhone = NEW_TAMPA_DEMO_TRUNK_PHONE;
    prepareReschedule(state, {
      appointment: loadedAppointment({
        facility: "Crystal River",
        type: "Demo follow-up",
        appointmentTypeId: 6167,
      }),
    });

    await reschedule_appointment.execute(
      {
        oldAppointmentRef: loadedAppointmentRef(state),
        appointmentSlotRef: "S1",
        appointmentReason: "move my follow-up",
        referringDoctor: "none",
        readBack: true,
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "reschedule-demo",
      } as never,
    );

    expect(middleware.operations).toMatchObject([
      { kind: "book", office: DEMO_BOOKING_OFFICE_PHONE },
      { kind: "cancel", office: DEMO_BOOKING_OFFICE_PHONE },
    ]);
  });
});
