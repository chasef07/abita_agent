import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";
import { bindSchedulingMiddleware } from "../scheduling/middleware.js";
import { createSchedulingTools } from "../scheduling/tools.js";
import {
  check_insurance,
  createAddPatientTool,
  create_staff_task,
  transfer_call,
  createUpdateInsuranceTool,
} from "../tools/index.js";
import { createResolvePatientTool } from "../tools/resolve-patient.js";
import { InMemoryOwnedMiddleware } from "./support/owned-middleware.js";

const middleware = new InMemoryOwnedMiddleware();
const add_patient = createAddPatientTool(middleware);
const resolve_patient = createResolvePatientTool(middleware);
const update_insurance = createUpdateInsuranceTool(middleware);

const {
  book_appointment,
  cancel_appointment,
  get_availability,
  reschedule_appointment,
} = createSchedulingTools(bindSchedulingMiddleware(middleware));

describe("model-facing tool result contract", () => {
  it("constrains every custom tool return path to plain text", () => {
    expect(
      [
        resolve_patient,
        add_patient,
        update_insurance,
        book_appointment,
        cancel_appointment,
        get_availability,
        reschedule_appointment,
        check_insurance,
        transfer_call,
        create_staff_task,
      ].map((tool) => tool.id),
    ).toEqual([
      "resolve_patient",
      "add_patient",
      "update_insurance",
      "book_appointment",
      "cancel_appointment",
      "get_availability",
      "reschedule_appointment",
      "check_insurance",
      "transfer_call",
      "create_staff_task",
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

  it("keeps instruction and context labels out of direct tool replies", () => {
    const resultOwners = [
      "../insurance-rules.ts",
      "../identity/patient-identity.ts",
      "../scheduling/appointments.ts",
      "../scheduling/availability.ts",
      "../scheduling/booking.ts",
      "../scheduling/context.ts",
      "../scheduling/workflow.ts",
      "../tools/add-patient.ts",
      "../tools/create-staff-task.ts",
      "../tools/update-insurance.ts",
    ];
    const source = resultOwners
      .map((file) => readFileSync(join(import.meta.dirname, file), "utf8"))
      .join("\n");

    expect(source).not.toMatch(
      /Internal context:|Tell the caller:|Offer this slot:|Offer these options:|Call add_patient again|Call book_appointment again|Call reschedule_appointment again|call get_availability again|call resolve_patient|Run check_insurance/,
    );
  });
});
