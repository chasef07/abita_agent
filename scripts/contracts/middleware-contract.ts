// Run against the authenticated Go handler fixture; never a live provider.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { HttpOwnedMiddleware } from "../../src/clients/owned-middleware.js";
import { createConfirmedPatientState } from "../../src/__tests__/support/call-state.js";
import { loadAvailability } from "../../src/scheduling/availability.js";
import { SchedulingWorkflow } from "../../src/scheduling/workflow.js";
import { activeAppointments } from "../../src/state/appointments.js";
import { SPRING_HILL_OFFICE_PHONE } from "../../src/customers/abita/profile.js";
const url = process.argv[2]!;
assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
const fixture = (await (await fetch(url + "/fixture")).json()) as {
  now: string;
  scenario: string;
};
const responses: Record<string, unknown> = {};
const client = new HttpOwnedMiddleware({
  middlewareBaseUrl: url,
  authToken: "test-auth",
  fetch: async (input, init) => {
    const response = await fetch(input, init);
    responses[
      responses[new URL(String(input)).pathname]
        ? "unsupported"
        : new URL(String(input)).pathname
    ] = await response.clone().json();
    return response;
  },
});
const patient = await client.resolvePatient({
  office: SPRING_HILL_OFFICE_PHONE,
  identity: { patientId: "12345" },
});
assert.equal(patient.status, "verified");
if (patient.status !== "verified") throw new Error("patient not verified");
const state = createConfirmedPatientState();
Object.assign(state.identity.activePatient!, {
  patientId: patient.patientId,
  dob: patient.dob,
  appointments: patient.appointments,
  appointmentsStatus: patient.appointmentsStatus,
});
const old = activeAppointments(state)[0]!;
assert.equal(old.officeId, "spring_hill");
assert.equal(old.visitType, "medical");
assert.ok(old.cancellationToken && old.rescheduleToken);
const clock = { now: () => new Date(fixture.now) };
await loadAvailability(
  state,
  { visitType: "medical", startDate: "2026-06-03" },
  client,
  clock,
);
const workflow = new SchedulingWorkflow(client, clock);
const args = {
  oldAppointmentRef: old.appointmentRef!,
  appointmentSlotRef: state.availability.slots[0]!.slotId,
  appointmentReason: "Medical follow up",
  referringDoctor: "none",
  readBack: true,
};
const result = await workflow.rescheduleAppointment(state, args, "contract");
assert.match(
  result,
  fixture.scenario === "success"
    ? /Rescheduled/
    : fixture.scenario === "partial"
      ? /unconfirmed/
      : fixture.scenario === "uncertain"
        ? /uncertain/
        : /failed/,
);
const ids = activeAppointments(state).map((a) => a.id);
assert.deepEqual(
  ids,
  fixture.scenario === "success"
    ? [98765]
    : fixture.scenario === "partial"
      ? [54321, 98765]
      : [54321],
);
if (fixture.scenario !== "failure")
  await workflow.rescheduleAppointment(state, args, "repeat");
const unsupported = await client.getAvailability({
  office: "+13523202007",
  visitType: "routine_vision",
  startDate: "2026-06-03",
});
assert.equal(unsupported.status, "unsupported");
// Save only actual handler responses, including signed fixture tokens.
writeFileSync(
  new URL(
    `../../src/__tests__/fixtures/scheduling/${fixture.scenario}.json`,
    import.meta.url,
  ),
  JSON.stringify(responses, null, 2) + "\n",
);
console.log(fixture.scenario, result, unsupported.status);
