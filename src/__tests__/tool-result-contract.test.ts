import { describe, expect, expectTypeOf, it } from "vitest";
import { productionSchedulingMiddleware } from "../scheduling/middleware.js";
import { createSchedulingTools } from "../scheduling/tools.js";
import {
  add_patient,
  check_insurance,
  create_staff_task,
  resolve_patient,
  transfer_call,
  update_insurance,
} from "../tools/index.js";

const {
  book_appointment,
  cancel_appointment,
  get_availability,
  reschedule_appointment,
} = createSchedulingTools(productionSchedulingMiddleware);

describe("model-facing tool result contract", () => {
  it("constrains every custom tool return path to plain text", () => {
    expect(
      [
        book_appointment,
        cancel_appointment,
        get_availability,
        reschedule_appointment,
      ].map((tool) => tool.id),
    ).toEqual([
      "book_appointment",
      "cancel_appointment",
      "get_availability",
      "reschedule_appointment",
    ]);

    expectTypeOf<
      Awaited<ReturnType<typeof resolve_patient.execute>>
    >().toEqualTypeOf<string>();
    expectTypeOf<
      Awaited<ReturnType<typeof add_patient.execute>>
    >().toEqualTypeOf<string>();
    expectTypeOf<
      Awaited<ReturnType<typeof update_insurance.execute>>
    >().toEqualTypeOf<string>();
    expectTypeOf<
      Awaited<ReturnType<typeof get_availability.execute>>
    >().toEqualTypeOf<string>();
    expectTypeOf<
      Awaited<ReturnType<typeof book_appointment.execute>>
    >().toEqualTypeOf<string>();
    expectTypeOf<
      Awaited<ReturnType<typeof cancel_appointment.execute>>
    >().toEqualTypeOf<string>();
    expectTypeOf<
      Awaited<ReturnType<typeof reschedule_appointment.execute>>
    >().toEqualTypeOf<string>();
    expectTypeOf<
      Awaited<ReturnType<typeof check_insurance.execute>>
    >().toEqualTypeOf<string>();
    expectTypeOf<
      Awaited<ReturnType<typeof transfer_call.execute>>
    >().toEqualTypeOf<string>();
    expectTypeOf<
      Awaited<ReturnType<typeof create_staff_task.execute>>
    >().toEqualTypeOf<string>();
  });
});
