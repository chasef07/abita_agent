import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSchedulingTools } from "../scheduling/tools.js";
import { replaceActiveAppointments } from "../state/appointments.js";
import { createConfirmedPatientState } from "./support/call-state.js";
import { createToolContext } from "./support/tool-context.js";
import { InMemorySchedulingMiddleware } from "./support/scheduling-middleware.js";
import type { AvailabilityResult } from "../scheduling/middleware.js";

function setup() {
  const state = createConfirmedPatientState();
  replaceActiveAppointments(
    state,
    [
      {
        id: 101,
        date: "2026-06-01",
        time: "9:00 AM",
        provider: "Dr. Bach",
        type: "Medical",
        appointmentTypeId: 1007,
        facility: "Spring Hill",
        confirmed: true,
        cancellationToken: "medical-cancel",
      },
      {
        id: 102,
        date: "2026-06-02",
        time: "10:00 AM",
        provider: "Dr. Calero",
        type: "Vision",
        appointmentTypeId: 4245,
        facility: "Spring Hill",
        confirmed: true,
        cancellationToken: "vision-cancel",
      },
    ],
    "found",
  );
  return {
    state,
    options: { ctx: createToolContext(state), toolCallId: "test" } as never,
  };
}
function inventory(): AvailabilityResult {
  return {
    status: "found",
    slots: [
      {
        provider: "Dr. Bach",
        date: "2026-06-03",
        time: "9:00 AM",
        datetime: "2026-06-03T09:00:00",
        bookingToken: "slot-token",
      },
    ],
    bookingTokenExpiresAt: "2026-05-30T16:15:00Z",
    dateShifted: false,
    shouldRetrySameSearch: false,
  };
}

describe("generic inventory for rescheduling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-30T16:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());
  it("has one inventory tool and puts the old reference only on the reschedule mutation", () => {
    const tools = createSchedulingTools(
      new InMemorySchedulingMiddleware(),
      undefined,
      { availabilityOfficeMode: "required" },
    );
    expect(tools).not.toHaveProperty("select_appointment_to_reschedule");
    const schema = tools.list_available_appointments.parameters as any;
    expect(Object.keys(schema.shape)).toEqual(["range", "visitType", "office"]);
    for (const visitType of ["medical", "routine_vision"]) {
      expect(
        schema.safeParse({ range: "default", visitType, office: "hollywood" })
          .success,
      ).toBe(true);
    }
    expect(
      schema.safeParse({
        range: "default",
        visitType: null,
        office: "hollywood",
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        range: "default",
        visitType: "medical",
        office: "hollywood",
        oldAppointmentRef: "old",
      }).success,
    ).toBe(false);
    const mutation = tools.reschedule_appointment.parameters as any;
    const args = {
      appointmentSlotRef: "S1",
      appointmentReason: "move",
      referringDoctor: "none",
      readBack: true,
    };
    expect(mutation.safeParse(args).success).toBe(false);
    expect(
      mutation.safeParse({ ...args, oldAppointmentRef: "A1" }).success,
    ).toBe(true);
  });
  it.each([0, 1, 2])(
    "loads the same inventory with %i existing appointments and no selection",
    async (count) => {
      const { state, options } = setup();
      replaceActiveAppointments(
        state,
        state.identity.activePatient!.appointments.slice(0, count),
        count ? "found" : "none",
      );
      const middleware = new InMemorySchedulingMiddleware({
        availability: [inventory()],
      });
      const tools = createSchedulingTools(middleware);
      for (let i = 0; i < 2; i++)
        await tools.list_available_appointments.execute(
          { range: "default", visitType: "medical" },
          options,
        );
      expect(middleware.operations).toHaveLength(1);
      expect(middleware.operations[0]).toMatchObject({
        request: { rangeDays: 14, routing: "all_three" },
      });
      expect(state.availability.slots[0]?.slotId).toBe("S1");
    },
  );
  it.each(["unknown", "", undefined])(
    "rejects invalid old reference %s without writes",
    async (oldAppointmentRef) => {
      const { state, options } = setup();
      const middleware = new InMemorySchedulingMiddleware({
        availability: [inventory()],
      });
      const tools = createSchedulingTools(middleware);
      await tools.list_available_appointments.execute(
        { range: "default", visitType: "medical" },
        options,
      );
      await tools.reschedule_appointment.execute(
        {
          oldAppointmentRef,
          appointmentSlotRef: "S1",
          appointmentReason: "move",
          referringDoctor: "none",
          readBack: true,
        } as never,
        options,
      );
      expect(middleware.operations.map((op) => op.kind)).toEqual([
        "availability",
      ]);
      expect(
        state.identity.activePatient!.appointments.map((a) => a.id),
      ).toEqual([101, 102]);
    },
  );
  it.each([
    ["medical", 1],
    ["routine_vision", 0],
  ] as const)(
    "rejects %s inventory for the other visit category",
    async (visitType, index) => {
      const { state, options } = setup();
      const middleware = new InMemorySchedulingMiddleware({
        availability: [inventory()],
      });
      const tools = createSchedulingTools(middleware);
      await tools.list_available_appointments.execute(
        { range: "default", visitType },
        options,
      );
      const result = await tools.reschedule_appointment.execute(
        {
          oldAppointmentRef:
            state.identity.activePatient!.appointments[index]!.appointmentRef!,
          appointmentSlotRef: "S1",
          appointmentReason: "move",
          referringDoctor: "none",
          readBack: true,
        },
        options,
      );
      expect(result).toContain("Load matching availability");
      expect(middleware.operations.map((op) => op.kind)).toEqual([
        "availability",
      ]);
    },
  );
  it.each([false, true])(
    "honors a second explicit appointment after a prior reschedule (same replacement time: %s)",
    async (sameTime) => {
      const later = inventory();
      if (later.status !== "found") throw Error("fixture");
      if (!sameTime)
        later.slots[0] = {
          ...later.slots[0]!,
          date: "2026-06-04",
          datetime: "2026-06-04T09:00:00",
        };
      const middleware = new InMemorySchedulingMiddleware({
        availability: [inventory(), later],
        bookings: [
          {
            status: "booked",
            appointmentId: 901,
            appointmentTypeId: 1007,
            providerName: "Dr. Bach",
            locationName: "Spring Hill",
            appointmentTypeName: "Medical",
            message: null,
          },
          {
            status: "booked",
            appointmentId: 902,
            appointmentTypeId: 4245,
            providerName: "Dr. Calero",
            locationName: "Spring Hill",
            appointmentTypeName: "Vision",
            message: null,
          },
        ],
        cancellations: [
          { status: "cancelled", message: null },
          { status: "cancelled", message: null },
        ],
      });
      const tools = createSchedulingTools(middleware);
      const { state, options } = setup();
      const firstRef =
        state.identity.activePatient!.appointments[0]!.appointmentRef!;
      const secondRef =
        state.identity.activePatient!.appointments[1]!.appointmentRef!;
      for (const appointmentRef of [firstRef, secondRef]) {
        await tools.list_available_appointments.execute(
          {
            range: "default",
            visitType:
              appointmentRef === firstRef ? "medical" : "routine_vision",
          },
          options,
        );
        const appointmentSlotRef = state.availability.slots[0]!.slotId;
        await tools.reschedule_appointment.execute(
          {
            oldAppointmentRef: appointmentRef,
            appointmentSlotRef,
            appointmentReason: "move my appointment",
            referringDoctor: "none",
            readBack: true,
          },
          options,
        );
      }
      expect(middleware.operations.map((op) => op.kind)).toEqual([
        "availability",
        "book",
        "cancel",
        "availability",
        "book",
        "cancel",
      ]);
      expect(middleware.operations[4]).toMatchObject({
        request: { appointmentTypeId: 4245 },
      });
      expect(middleware.operations[5]).toMatchObject({
        request: { cancellationToken: "vision-cancel" },
      });
      expect(
        state.identity.activePatient!.appointments.map(
          (appointment) => appointment.id,
        ),
      ).toEqual([901, 902]);
    },
  );
});
