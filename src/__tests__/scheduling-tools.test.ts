import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  HOLLYWOOD_OFFICE_PHONE,
  SWEETWATER_OFFICE_PHONE,
} from "../customers/abita/profile.js";
import { createSchedulingTools } from "../scheduling/tools.js";
import { InMemorySchedulingMiddleware } from "../scheduling/testing.js";
import {
  appointmentActions,
  ownedMiddlewareFailures,
} from "../state/observability.js";
import { storeAvailabilityBookingToken } from "../scheduling/state.js";
import { activatePatient } from "../state/identity.js";
import type {
  CallerAppointment,
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

function createHollywoodSweetwaterState(office: "hollywood" | "sweetwater") {
  const state = createState();
  const officePhone =
    office === "hollywood" ? HOLLYWOOD_OFFICE_PHONE : SWEETWATER_OFFICE_PHONE;
  state.office.activeKey = office;
  state.office.phoneOverrides[office] = officePhone;
  state.runtime.trunkPhone = officePhone;
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

function deferredResult<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((value) => {
    resolve = value;
  });
  return { promise, resolve };
}

function switchActivePatient(
  state: ReturnType<typeof createState>,
  appointments: CallerAppointment[] = [],
) {
  activatePatient(state, {
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
  activatePatient(state, {
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
      { date: "2026-06-01", appointmentLane: "medical_md" },
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
          date: "2026-06-01",
          appointmentLane: "medical_md",
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
        date: "2026-06-01",
        appointmentLane: "medical_md",
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
        date: "2026-06-01",
        appointmentLane: "medical_md",
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "availability-1",
      } as never,
    );

    expect(result).toBe(
      "Offer this slot: June 1 at 9:00 AM with Dr. Bach (appointmentSlotRef S1). If the caller accepts it, use appointmentSlotRef S1; if they want a different day or time, ask for another date to check and call get_availability with that date.",
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
          date: "2026-06-01",
          dob: "01/01/1980",
          routing: "all_three",
        },
      },
    ]);
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
      date: "2026-06-01",
      appointmentLane: "medical_md" as const,
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
      "No openings were found from June 1 through June 15. Ask whether to check starting June 16, or whether they prefer a different day or time.",
    );
    expect(second).toBe(first);
    expect(middleware.operations).toHaveLength(1);
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
      date: "2026-06-01",
      appointmentLane: "medical_md" as const,
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
      "Availability was not fully checked from June 1 through June 2. Call get_availability again once with the same date.",
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

    const result = await get_availability.execute(
      { date: "2026-06-01", appointmentLane: "medical_md" },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "availability-1",
      } as never,
    );

    expect(result).toBe(
      "I'm having trouble checking availability. Let me try once more. Ask for a different date or time preference.",
    );
    expect(ownedMiddlewareFailures(state)).toMatchObject([
      { operation: "getAvailability", reason: "middleware_error" },
    ]);
  });

  it("ranks returned slots by the caller's time preference", async () => {
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
        date: "2026-06-01",
        appointmentLane: "medical_md",
        timePreference: "afternoon",
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "availability-1",
      } as never,
    );

    expect(result).toBe(
      "Offer this slot: June 1 at 2:00 PM with Dr. Noel (appointmentSlotRef S1). If the caller accepts it, use appointmentSlotRef S1; if they want a different day or time, ask for another date to check and call get_availability with that date.",
    );
    expect(state.availability.bookingTokensBySlotId).toEqual({
      S1: "afternoon-token",
    });
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
        date: "2026-06-01",
        appointmentLane: "medical_md",
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "availability-1",
      } as never,
    );

    activatePatient(state, {
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

  it("preserves medical and routine-vision office capabilities", async () => {
    const middleware = new InMemorySchedulingMiddleware();
    const { get_availability } = createSchedulingTools(middleware);
    const opticalState = createState();
    opticalState.office.activeKey = "north-miami-beach-optical";
    opticalState.office.phoneOverrides = {
      "north-miami-beach-optical": "+13055550100",
    };
    const medicalResult = await get_availability.execute(
      { date: "2026-06-01", appointmentLane: "medical_md" },
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
      { date: "2026-06-01", appointmentLane: "routine_od" },
      {
        ctx: createToolContext(medicalState) as never,
        toolCallId: "routine-1",
      } as never,
    );

    expect(medicalResult).toContain(
      "supports routine vision and optical scheduling only",
    );
    expect(routineResult).toContain("does not schedule routine eye exams");
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
        spoken: "2026-06-01 9:00 AM with Dr. Bach",
        provider: "Dr. Bach",
        date: "2026-06-01",
        time: "9:00 AM",
        datetime: "2026-06-01T09:00:00",
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

    expect(result).toBe("Booked June 1 at 9:00 AM with Dr. Bach.");
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
        date: "2026-06-01",
        time: "9:00 AM",
      }),
    );
    expect(appointmentActions(state)).toMatchObject([
      {
        action: "booked",
        status: "success",
        toolName: "book_appointment",
        appointment: { appointmentId: "456" },
      },
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
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "booking-1",
      } as never,
    );

    expect(result).toBe(
      "Read back June 1 at 9:00 AM with Dr. Bach and ask the caller to confirm it. Call book_appointment again only after the caller confirms the appointment details are correct.",
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
    ).rejects.toThrow(
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
      "I could not confirm the booking because the appointment ID was missing. Check availability again before booking.",
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
      "That time is no longer available. I can offer June 1 at 2:00 PM with Dr. Bach instead.",
    );
    expect(state.availability.slots).toEqual([nextSlot]);
    expect(state.availability.bookingTokensBySlotId).toEqual({
      S2: "next-token",
    });
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

    activatePatient(state, {
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
    expect(state.identity.patient.appointments).toEqual([currentAppointment]);

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
        appointment: { appointmentId: "456", patientName: "Jane Doe" },
      },
    ]);
  });

  it("cancels one loaded appointment once and replays the committed result", async () => {
    const middleware = new InMemorySchedulingMiddleware({
      cancellations: [{ status: "cancelled" }],
    });
    const { cancel_appointment } = createSchedulingTools(middleware);
    const state = createState();
    state.identity.patient.appointments = [
      {
        id: 123,
        date: "Monday, June 1, 2026",
        time: "9:00 AM",
        provider: "Dr. Licht",
        type: "Follow-up",
        facility: "Spring Hill",
        confirmed: true,
      },
    ];
    const ctx = createToolContext(state);

    const result = await cancel_appointment.execute({}, {
      ctx: ctx as never,
      toolCallId: "cancel-1",
    } as never);
    const replay = await cancel_appointment.execute({}, {
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
        cancelledAppointment: { appointmentId: "123" },
      },
    ]);
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
    state.identity.patient.appointments = [loadedAppointment()];

    const result = await cancel_appointment.execute({}, {
      ctx: createToolContext(state) as never,
      toolCallId: "cancel-1",
    } as never);

    expect(result).toBe("The appointment was not cancelled.");
    expect(state.identity.patient.appointments).toEqual([loadedAppointment()]);
    expect(ownedMiddlewareFailures(state)).toMatchObject([
      { operation: "cancelAppointment", reason: "middleware_error" },
    ]);
  });

  it("requires caller selection when loaded cancellations are ambiguous", async () => {
    const middleware = new InMemorySchedulingMiddleware();
    const { cancel_appointment } = createSchedulingTools(middleware);
    const state = createState();
    state.identity.patient.appointments = [
      loadedAppointment(),
      loadedAppointment({
        id: 222,
        date: "Tuesday, June 2, 2026",
        time: "2:00 PM",
      }),
    ];

    const result = await cancel_appointment.execute({}, {
      ctx: createToolContext(state) as never,
      toolCallId: "cancel-1",
    } as never);

    expect(result).toContain("Which appointment should I cancel?");
    expect(result).toContain("Monday, June 1, 2026 at 9:00 AM");
    expect(result).toContain("Tuesday, June 2, 2026 at 2:00 PM");
    expect(middleware.operations).toEqual([]);
  });

  it.each([
    {
      selector: { appointmentDate: "June 2nd" },
      selectedId: 222,
    },
    {
      selector: { appointmentDate: "June 25", appointmentTime: "3:15 PM" },
      selectedId: 333,
    },
  ])(
    "cancels the loaded appointment selected by caller date and time",
    async ({ selector, selectedId }) => {
      const middleware = new InMemorySchedulingMiddleware({
        cancellations: [{ status: "cancelled" }],
      });
      const { cancel_appointment } = createSchedulingTools(middleware);
      const state = createState();
      state.identity.patient.appointments = [
        loadedAppointment({ id: 111 }),
        loadedAppointment({
          id: 222,
          date: "Tuesday, June 2, 2026",
          time: "10:00 AM",
        }),
        loadedAppointment({
          id: 333,
          date: "Thursday, June 25, 2026",
          time: "3:15 PM",
        }),
      ];

      await cancel_appointment.execute(selector, {
        ctx: createToolContext(state) as never,
        toolCallId: "cancel-1",
      } as never);

      expect(middleware.operations).toMatchObject([
        { kind: "cancel", request: { appointmentId: selectedId } },
      ]);
      expect(
        state.identity.patient.appointments.map(({ id }) => id),
      ).not.toContain(selectedId);
    },
  );

  it("does not remove the newly active patient's appointment when cancellation finishes", async () => {
    const deferred = deferredResult<{ status: "cancelled" }>();
    const middleware = new InMemorySchedulingMiddleware({
      cancellations: [deferred.promise],
    });
    const { cancel_appointment } = createSchedulingTools(middleware);
    const state = createState();
    state.identity.patient.appointments = [loadedAppointment()];
    const currentAppointment = loadedAppointment({ id: 123 });

    const pending = cancel_appointment.execute({}, {
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
    expect(state.identity.patient.appointments).toEqual([currentAppointment]);

    restoreFirstPatient(state, [loadedAppointment()]);
    const replay = await cancel_appointment.execute({}, {
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
          appointmentId: "123",
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
    state.identity.patient.appointments = [loadedAppointment()];
    const ctx = createToolContext(state);
    await cancel_appointment.execute({}, {
      ctx: ctx as never,
      toolCallId: "cancel-1",
    } as never);

    activatePatient(state, {
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
    await cancel_appointment.execute({}, {
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
      "Rescheduled the appointment to June 3 at 10:00 AM with Dr. Bach. Cancelled the old appointment on Monday, June 1, 2026 at 9:00 AM.",
    );
    expect(middleware.operations.map((operation) => operation.kind)).toEqual([
      "book",
      "cancel",
    ]);
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
        appointment: { appointmentId: "456" },
        cancelledAppointment: { appointmentId: "123" },
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
      "Read back June 1 at 9:00 AM with Dr. Bach and ask the caller to confirm it as the new appointment. Call reschedule_appointment again only after the caller confirms the new appointment details are correct.",
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
    expect(state.identity.patient.appointments).toEqual([currentAppointment]);

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
        appointment: { appointmentId: "456", patientName: "Jane Doe" },
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
    expect(state.identity.patient.appointments).toEqual([currentAppointment]);

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
        appointment: { appointmentId: "456", patientName: "Jane Doe" },
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
      "Booked the new appointment for June 1 at 9:00 AM with Dr. Bach, but I could not cancel the old appointment. The old appointment was not cancelled. I need to transfer you so the office can finish the cancellation.",
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
        appointmentDescription: "June 1 at 9:00 AM with Dr. Bach",
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
      "The appointment is already rescheduled to June 1 at 9:00 AM with Dr. Bach. Tell the caller the confirmed appointment details instead of rescheduling again.",
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
      "Rescheduled the appointment to June 3 at 2:00 PM with Dr. Bach. Cancelled the old appointment on 2026-06-01 at 9:00 AM.",
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
