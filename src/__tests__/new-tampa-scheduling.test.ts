import type { BookAppointmentResult } from "../clients/owned-middleware.js";
import { createSchedulingTools } from "../scheduling/tools.js";
import {
  recordCompletedBookingForPatient,
  recordCompletedRescheduleForPatient,
} from "../state/appointments.js";
import { describe, expect, it } from "vitest";
import {
  triage_eye_care,
  createNewTampaDemoTools,
} from "../customers/abita/new-tampa-demo.js";
import {
  NEW_TAMPA_DEMO_TRUNK_PHONE,
  DEMO_BOOKING_OFFICE_PHONE,
} from "../customers/abita/profile.js";
import { createConfirmedPatientState } from "./support/call-state.js";
import { createToolContext } from "./support/tool-context.js";
import { InMemorySchedulingMiddleware } from "./support/scheduling-middleware.js";
import { activeAppointments } from "../state/appointments.js";
import { appointmentActions } from "../state/observability.js";
import { storeAvailabilityBookingToken } from "../scheduling/availability.js";
import type {
  CallerAppointment,
  StoredAvailabilitySlot,
} from "../state/call-state.js";
const createState = createConfirmedPatientState;
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
  state.workflow.visitType = "medical";
  const slot =
    options.slot ??
    availabilitySlot({
      routing: "all_three",
    });
  state.availability.slots = [slot];
  storeAvailabilityBookingToken(
    state,
    slot.slotId,
    options.token ?? "private-token",
  );
}

function bookingReceipt(
  overrides: Partial<
    Extract<BookAppointmentResult, { status: "booked" | "partial" }>
  > = {},
): Extract<BookAppointmentResult, { status: "booked" | "partial" }> {
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

function loadedAppointmentRef(
  state: ReturnType<typeof createState>,
  index = 0,
): string {
  const appointmentRef = activeAppointments(state)[index]?.appointmentRef;
  if (!appointmentRef) throw new Error("Expected a loaded appointmentRef.");
  return appointmentRef;
}

describe("New Tampa provider guards at appointment mutation", () => {
  async function newTampaState() {
    const state = createState();
    state.office.activeKey = "new-tampa-demo";
    state.runtime.trunkPhone = NEW_TAMPA_DEMO_TRUNK_PHONE;
    await triage_eye_care.execute(
      { purpose: "retina", requestedProvider: "Scott Friedman" },
      { ctx: createToolContext(state) } as never,
    );
    return state;
  }

  it("books a matched provider using the original demo token and successful receipt", async () => {
    const state = await newTampaState();
    prepareBooking(state, availabilitySlot({ provider: "Scott Friedman" }));
    const middleware = new InMemorySchedulingMiddleware({
      bookings: [
        bookingReceipt({
          providerName: "Scott Friedman",
          locationName: "Demo account",
        }),
      ],
    });
    const { book_appointment } = createNewTampaDemoTools(middleware);
    const result = await book_appointment.execute(
      {
        appointmentSlotRef: "S1",
        appointmentReason: "retina follow-up",
        referringDoctor: "none",
        readBack: true,
      },
      { ctx: createToolContext(state), toolCallId: "new-tampa-book" } as never,
    );
    expect(result).toContain("Scott Friedman");
    expect(middleware.operations).toMatchObject([
      {
        kind: "book",
        office: DEMO_BOOKING_OFFICE_PHONE,
        request: { bookingToken: "private-token" },
      },
    ]);
    expect(appointmentActions(state)).toMatchObject([
      { action: "booked", status: "success" },
    ]);
  });

  it("reschedules with a matched provider and keeps both mutations on the demo account", async () => {
    const state = await newTampaState();
    prepareReschedule(state, {
      appointment: loadedAppointment({
        facility: "Crystal River",
        provider: "Scott Friedman",
        appointmentTypeId: 6167,
      }),
      slot: availabilitySlot({ provider: "Scott Friedman" }),
    });
    const middleware = new InMemorySchedulingMiddleware({
      bookings: [
        bookingReceipt({
          providerName: "Scott Friedman",
          locationName: "Demo account",
        }),
      ],
      cancellations: [{ status: "cancelled", message: null }],
    });
    const { reschedule_appointment } = createNewTampaDemoTools(middleware);
    const result = await reschedule_appointment.execute(
      {
        oldAppointmentRef: loadedAppointmentRef(state),
        appointmentSlotRef: "S1",
        appointmentReason: "retina follow-up",
        referringDoctor: "none",
        readBack: true,
      },
      { ctx: createToolContext(state), toolCallId: "new-tampa-move" } as never,
    );
    expect(result).toContain("Rescheduled");
    expect(middleware.operations).toMatchObject([
      { kind: "book", office: DEMO_BOOKING_OFFICE_PHONE },
      { kind: "cancel", office: DEMO_BOOKING_OFFICE_PHONE },
    ]);
  });

  it.each(["rescheduled", "needs_human_cancellation"] as const)(
    "preserves %s replay after a later blocked triage",
    async (status) => {
      const state = await newTampaState();
      recordCompletedRescheduleForPatient(state, "patient-1", {
        status,
        originalAppointmentRef: "original",
        replacementAppointmentRef: "replacement",
        appointmentDescription: "the confirmed demo appointment",
      });
      await triage_eye_care.execute(
        { purpose: "urgent", requestedProvider: null },
        { ctx: createToolContext(state) } as never,
      );
      const middleware = new InMemorySchedulingMiddleware();
      const options = {
        ctx: createToolContext(state),
        toolCallId: "replay",
      } as never;
      const args = {
        oldAppointmentRef: "original",
        appointmentSlotRef: "expired",
        appointmentReason: "follow-up",
        referringDoctor: "none",
        readBack: true as const,
      };
      const expected = await createSchedulingTools(
        middleware,
      ).reschedule_appointment.execute(args, options);
      const result = await createNewTampaDemoTools(
        middleware,
      ).reschedule_appointment.execute(args, options);
      expect(result).toBe(expected);
      expect(result).toContain(
        status === "needs_human_cancellation"
          ? "old appointment still needs office staff to cancel"
          : "already rescheduled",
      );
      expect(middleware.operations).toEqual([]);
    },
  );

  it("preserves completed booking replay after a later blocked triage", async () => {
    const state = await newTampaState();
    recordCompletedBookingForPatient(state, "patient-1", {
      appointmentId: 456,
      appointmentDescription: "the confirmed demo appointment",
    });
    await triage_eye_care.execute(
      { purpose: "urgent", requestedProvider: null },
      { ctx: createToolContext(state) } as never,
    );
    const middleware = new InMemorySchedulingMiddleware();
    const result = await createNewTampaDemoTools(
      middleware,
    ).book_appointment.execute(
      {
        appointmentSlotRef: "expired",
        appointmentReason: "follow-up",
        referringDoctor: "none",
        readBack: true,
      },
      { ctx: createToolContext(state), toolCallId: "replay" } as never,
    );
    expect(result).toBe("That appointment is already booked.");
    expect(middleware.operations).toEqual([]);
  });

  it.each(["book", "reschedule"] as const)(
    "blocks %s with a mismatched provider without backend mutations",
    async (action) => {
      const state = await newTampaState();
      prepareReschedule(state, {
        slot: availabilitySlot({ provider: "Gretta Fridman" }),
      });
      const middleware = new InMemorySchedulingMiddleware();
      const tools = createNewTampaDemoTools(middleware);
      const args = {
        oldAppointmentRef: loadedAppointmentRef(state),
        appointmentSlotRef: "S1",
        appointmentReason: "retina follow-up",
        referringDoctor: "none",
        readBack: true as const,
      };
      const ctx = {
        ctx: createToolContext(state),
        toolCallId: "new-tampa-mismatch",
      } as never;
      const result =
        action === "book"
          ? await tools.book_appointment.execute(args, ctx)
          : await tools.reschedule_appointment.execute(args, ctx);
      expect(result).toContain("does not match the current New Tampa triage");
      expect(middleware.operations).toEqual([]);
      expect(activeAppointments(state)).toHaveLength(1);
    },
  );
});
