import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { HttpOwnedMiddleware } from "../clients/owned-middleware.js";
import { SchedulingWorkflow } from "../scheduling/workflow.js";
import { loadAvailability } from "../scheduling/availability.js";
import {
  activeAppointments,
  replaceActiveAppointments,
} from "../state/appointments.js";
import { currentAppointmentReferences } from "../scheduling/appointments.js";
import {
  createConfirmedPatientState,
  confirmedActivePatient,
} from "./support/call-state.js";
import { deferredResult } from "./support/deferred-result.js";
import { SPRING_HILL_OFFICE_PHONE } from "../customers/abita/profile.js";

// These envelopes were captured from middleware 9dd501d's authenticated handlers
// with only AdvancedMD mocked. See scripts/contracts for the executable producer.
function fixture(scenario = "success") {
  return JSON.parse(
    readFileSync(
      new URL(`./fixtures/scheduling/${scenario}.json`, import.meta.url),
      "utf8",
    ),
  );
}
async function setup(scenario = "success") {
  const data = fixture(scenario);
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  let mutation = async () => data["/api/appointment/reschedule"];
  const client = new HttpOwnedMiddleware({
    middlewareBaseUrl: "http://fixture.local",
    authToken: "test-auth",
    fetch: vi.fn(async (input, init) => {
      const path = new URL(String(input)).pathname;
      requests.push({ path, body: JSON.parse(String(init?.body)) });
      const value =
        path === "/api/appointment/reschedule" ? await mutation() : data[path];
      if (value instanceof Response) return value;
      return new Response(JSON.stringify(value), { status: 200 });
    }),
  });
  const patient = await client.resolvePatient({
    office: SPRING_HILL_OFFICE_PHONE,
    identity: { patientId: "12345" },
  });
  if (patient.status !== "verified")
    throw new Error("fixture patient not verified");
  const state = createConfirmedPatientState();
  Object.assign(state.identity.activePatient!, {
    patientId: patient.patientId,
    appointments: patient.appointments,
    appointmentsStatus: patient.appointmentsStatus,
    dob: patient.dob,
  });
  let now = new Date("2026-06-01T12:00:00Z");
  const clock = { now: () => now };
  const search = () =>
    loadAvailability(
      state,
      { visitType: "medical", startDate: "2026-06-03" },
      client,
      clock,
    );
  await search();
  const old = activeAppointments(state)[0]!;
  const args = {
    oldAppointmentRef: old.appointmentRef!,
    appointmentSlotRef: state.availability.slots[0]!.slotId,
    appointmentReason: "Medical follow up",
    referringDoctor: "none",
    readBack: true,
  };
  const workflow = new SchedulingWorkflow(client, clock);
  const writes = () =>
    requests.filter((r) => r.path.startsWith("/api/appointment/"));
  return {
    data,
    state,
    client,
    old,
    args,
    workflow,
    search,
    writes,
    requests,
    setMutation: (fn: typeof mutation) => {
      mutation = fn;
    },
    setNow: (value: Date) => {
      now = value;
    },
  };
}

describe("middleware scheduling HTTP contracts", () => {
  it.each(["success", "partial", "failure", "uncertain"])(
    "consumes the actual %s envelope with one reschedule POST",
    async (scenario) => {
      const c = await setup(scenario);
      const result = await c.workflow.rescheduleAppointment(
        c.state,
        c.args,
        "move",
      );
      expect(result).toMatch(
        scenario === "success"
          ? /Rescheduled/
          : scenario === "partial"
            ? /unconfirmed/
            : scenario === "uncertain"
              ? /uncertain/
              : /failed/,
      );
      expect(c.writes()).toHaveLength(1);
      expect(c.writes()[0]).toMatchObject({
        path: "/api/appointment/reschedule",
        body: {
          patientId: "12345",
          rescheduleToken: c.old.rescheduleToken,
          visitCategory: "medical",
        },
      });
      expect(c.writes()[0]!.body).not.toHaveProperty("office");
      expect(c.writes()[0]!.body).not.toHaveProperty("appointmentTypeId");
      expect(activeAppointments(c.state).map((a) => a.id)).toEqual(
        scenario === "success"
          ? [98765]
          : scenario === "partial"
            ? [54321, 98765]
            : [54321],
      );
      if (scenario === "success" || scenario === "partial") {
        const replacement = activeAppointments(c.state).find(
          (a) => a.id === 98765,
        )!;
        expect(replacement).toMatchObject({
          officeId: "spring_hill",
          office: "Spring Hill",
          visitType: "medical",
        });
        expect(replacement.cancellationToken).toBeTruthy();
        expect(replacement.rescheduleToken).toBeTruthy();
        await c.workflow.rescheduleAppointment(c.state, c.args, "repeat");
        expect(c.writes()).toHaveLength(1);
      }
      expect(result + currentAppointmentReferences(c.state)).not.toContain(
        c.old.rescheduleToken,
      );
      expect(result + currentAppointmentReferences(c.state)).not.toContain(
        c.old.cancellationToken,
      );
    },
  );

  it("requires a new search and confirmation after a definite no-write failure", async () => {
    const c = await setup("failure");
    await c.workflow.rescheduleAppointment(c.state, c.args, "failed");
    await expect(
      c.workflow.rescheduleAppointment(c.state, c.args, "repeat"),
    ).rejects.toThrow(/Search availability/);
    await c.search();
    const args = {
      ...c.args,
      appointmentSlotRef: c.state.availability.slots[0]!.slotId,
    };
    c.setMutation(async () => fixture()["/api/appointment/reschedule"]);
    expect(
      await c.workflow.rescheduleAppointment(
        c.state,
        { ...args, readBack: false },
        "confirm",
      ),
    ).toContain("Let me confirm");
    expect(c.writes()).toHaveLength(1);
    expect(
      await c.workflow.rescheduleAppointment(c.state, args, "retry"),
    ).toContain("Rescheduled");
    expect(c.writes()).toHaveLength(2);
  });

  it.each([
    "partial",
    "lost",
    "invalid-json",
    "uncertain",
    "wrong-patient",
    "missing-receipt",
    "wrong-cancellation",
  ])("blocks all further patient writes after %s", async (scenario) => {
    const c = await setup(scenario === "partial" ? "partial" : "success");
    if (scenario === "lost")
      c.setMutation(async () => {
        throw new Error("lost response");
      });
    if (scenario === "invalid-json")
      c.setMutation(async () => new Response("{"));
    if (scenario === "uncertain")
      c.setMutation(async () => ({
        status: "uncertain",
        outcome: "indeterminate_write",
      }));
    if (scenario === "wrong-patient")
      c.data["/api/appointment/reschedule"].booking.patientId = "someone-else";
    if (scenario === "missing-receipt")
      delete c.data["/api/appointment/reschedule"].booking;
    if (scenario === "wrong-cancellation")
      c.data["/api/appointment/reschedule"].cancellation.appointmentId = 999;
    const result = await c.workflow.rescheduleAppointment(
      c.state,
      c.args,
      "move",
    );
    expect(result).toMatch(/uncertain|unconfirmed/);
    for (const run of [
      () => c.workflow.rescheduleAppointment(c.state, c.args, "repeat"),
      () => c.workflow.bookAppointment(c.state, c.args, "book"),
      () =>
        c.workflow.cancelAppointment(
          c.state,
          { appointmentRef: c.args.oldAppointmentRef },
          "cancel",
        ),
    ])
      expect(await run()).toBe(result);
    // Reloading cannot make an ambiguous write safe to repeat.
    replaceActiveAppointments(c.state, [c.old], "found");
    expect(
      await c.workflow.rescheduleAppointment(c.state, c.args, "reload-repeat"),
    ).toBe(result);
    expect(c.writes()).toHaveLength(1);
  });

  it.each(["success", "partial", "failure", "uncertain"])(
    "keeps %s effects with the captured patient across context changes",
    async (scenario) => {
      const c = await setup(scenario === "uncertain" ? "success" : scenario);
      const deferred = deferredResult<unknown>();
      c.setMutation(() => deferred.promise);
      const inFlight = c.workflow.rescheduleAppointment(
        c.state,
        c.args,
        "move",
      );
      const originalPatient = c.state.identity.activePatient!;
      c.state.identity.activePatient = confirmedActivePatient({
        patientId: "other",
      });
      c.state.identity.transitionVersion++;
      deferred.resolve(
        scenario === "uncertain"
          ? { status: "uncertain" }
          : c.data["/api/appointment/reschedule"],
      );
      await inFlight;
      expect(activeAppointments(c.state)).toEqual([]);
      c.state.identity.activePatient = {
        ...originalPatient,
        appointments: [c.old],
      };
      c.state.identity.transitionVersion++;
      expect(activeAppointments(c.state).map((a) => a.id)).toEqual(
        scenario === "success"
          ? [98765]
          : scenario === "partial"
            ? [54321, 98765]
            : [54321],
      );
      if (scenario === "partial" || scenario === "uncertain")
        expect(
          await c.workflow.cancelAppointment(
            c.state,
            { appointmentRef: c.old.appointmentRef! },
            "cancel",
          ),
        ).toMatch(/unconfirmed|uncertain/);
      expect(c.writes()).toHaveLength(1);
    },
  );

  it("serializes concurrent writes even across workflow instances", async () => {
    const c = await setup();
    const deferred = deferredResult<unknown>();
    c.setMutation(() => deferred.promise);
    const inFlight = c.workflow.rescheduleAppointment(c.state, c.args, "move");
    const other = new SchedulingWorkflow(c.client);
    expect(
      await other.cancelAppointment(
        c.state,
        { appointmentRef: c.old.appointmentRef! },
        "cancel",
      ),
    ).toContain("still in progress");
    expect(
      await other.rescheduleAppointment(c.state, c.args, "repeat"),
    ).toContain("still in progress");
    deferred.resolve(c.data["/api/appointment/reschedule"]);
    await inFlight;
    expect(c.writes()).toHaveLength(1);
  });

  it.each([
    "confirmation",
    "expired-slot",
    "missing-token",
    "unknown-type",
    "wrong-type",
    "stale-ref",
    "ambiguous-ref",
  ])("guards %s without a write", async (guard) => {
    const c = await setup();
    if (guard === "confirmation") c.args.readBack = false;
    if (guard === "expired-slot") c.setNow(new Date("2026-06-01T12:16:00Z"));
    if (guard === "missing-token")
      delete c.state.identity.activePatient!.appointments[0]!.rescheduleToken;
    if (guard === "unknown-type")
      delete c.state.identity.activePatient!.appointments[0]!.visitType;
    if (guard === "wrong-type") c.state.workflow.visitType = "routine_vision";
    if (guard === "stale-ref")
      c.state.identity.activePatient!.appointments[0]!.time = "10:00 AM";
    if (guard === "ambiguous-ref")
      c.state.identity.activePatient!.appointments.push({ ...c.old });
    const result = await c.workflow
      .rescheduleAppointment(c.state, c.args, "move")
      .catch((error: Error) => error.message);
    expect(result).toMatch(/confirm|expired|Reload|matching|match|reload/i);
    expect(c.writes()).toEqual([]);
  });

  it("reloads after expired action authorization", async () => {
    const c = await setup();
    c.setMutation(async () => ({
      status: "failed",
      outcome: "invalid_reschedule_token",
    }));
    await c.workflow.rescheduleAppointment(c.state, c.args, "move");
    expect(c.state.identity.activePatient!.appointmentsStatus).toBe("error");
    expect(c.state.availability.slots).toEqual([]);
    expect(c.writes()).toHaveLength(1);
  });

  it("requires cancellation authorization instead of falling back to IDs", async () => {
    const c = await setup();
    delete c.state.identity.activePatient!.appointments[0]!.cancellationToken;
    await expect(
      c.workflow.cancelAppointment(
        c.state,
        { appointmentRef: c.old.appointmentRef! },
        "cancel",
      ),
    ).rejects.toThrow(/Reload/);
    expect(c.writes()).toEqual([]);
  });

  it("keeps unsupported office/visit combinations distinct from a full calendar", async () => {
    const c = await setup();
    c.data["/api/scheduler/slots"] = c.data.unsupported;
    c.state.workflow.visitType = null; // invalidate the loaded search on next request
    const message = await loadAvailability(
      c.state,
      { visitType: "routine_vision", startDate: "2026-06-03" },
      c.client,
      { now: () => new Date("2026-06-01T12:00:00Z") },
    );
    expect(message).toContain("No providers are eligible");
    expect(message).not.toMatch(/other day|no openings/);
    expect(c.state.availability.slots).toEqual([]);
    expect(c.requests.at(-1)!.body).toHaveProperty(
      "visitType",
      "routine_vision",
    );
  });
});

describe("current middleware first-name and DOB contract", () => {
  it.each([
    ["unique", "verified"],
    ["not_found", "not_found"],
    ["multiple_matches", "multiple_matches"],
    ["incomplete", "lookup_failed"],
    ["provider_failure", "lookup_failed"],
  ])(
    "consumes %s without selecting or hydrating candidates",
    async (scenario, expected) => {
      const { resolveExistingPatient } =
        await import("../identity/patient-identity.js");
      const { createTestCallState } = await import("./support/call-state.js");
      const envelopes = fixture("patient-resolution");
      const fetcher = vi.fn(
        async () => new Response(JSON.stringify(envelopes[scenario!])),
      );
      const client = new HttpOwnedMiddleware({
        middlewareBaseUrl: "http://fixture.local",
        fetch: fetcher,
      });
      const state = createTestCallState();
      const result = await resolveExistingPatient(
        state,
        { firstName: "Jane", dob: "01/01/1980" },
        (office, identity) => client.resolvePatient({ office, identity }),
      );
      expect(result.outcome).toBe(expected);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(state.identity.activePatient?.patientId ?? null).toBe(
        scenario === "unique" ? "1" : null,
      );
      if (scenario !== "unique")
        expect(result.reply).not.toMatch(/Meyer|Other|candidate|01\/01\/1980/);
    },
  );
});

describe("single-shot booking and cancellation", () => {
  it.each(["book", "cancel"])(
    "blocks repeated %s writes after an ambiguous response",
    async (kind) => {
      const c = await setup();
      c.data[`/api/appointment/${kind}`] = {
        status: "error",
        outcome: "indeterminate_write",
      };
      const run = () =>
        kind === "book"
          ? c.workflow.bookAppointment(c.state, c.args, "book")
          : c.workflow.cancelAppointment(
              c.state,
              { appointmentRef: c.old.appointmentRef! },
              "cancel",
            );
      const result = await run();
      expect(result).toContain("outcome is uncertain");
      expect(await run()).toBe(result);
      expect(
        await c.workflow.rescheduleAppointment(c.state, c.args, "move"),
      ).toBe(result);
      expect(c.writes()).toHaveLength(1);
    },
  );

  it("allows a fresh confirmed booking after a definite write failure", async () => {
    const c = await setup();
    c.data["/api/appointment/book"] = {
      status: "error",
      outcome: "write_failed",
    };
    expect(
      await c.workflow.bookAppointment(c.state, c.args, "failed"),
    ).toContain("Search availability again");
    await expect(
      c.workflow.bookAppointment(c.state, c.args, "repeat"),
    ).rejects.toThrow(/Search availability/);
    await c.search();
    const args = {
      ...c.args,
      appointmentSlotRef: c.state.availability.slots[0]!.slotId,
    };
    c.data["/api/appointment/book"] =
      c.data["/api/appointment/reschedule"].booking;
    expect(
      await c.workflow.bookAppointment(
        c.state,
        { ...args, readBack: false },
        "confirm",
      ),
    ).toContain("Let me confirm");
    expect(c.writes()).toHaveLength(1);
    expect(await c.workflow.bookAppointment(c.state, args, "retry")).toContain(
      "Booked",
    );
    expect(c.writes()).toHaveLength(2);
  });
});

describe("receipt reconciliation before patient acknowledgment", () => {
  it("preserves required reloads when a confirmed receipt restores an appointment", async () => {
    const c = await setup();
    await c.workflow.rescheduleAppointment(c.state, c.args, "move");
    replaceActiveAppointments(c.state, [], "error");
    expect(currentAppointmentReferences(c.state)).toContain("appointmentRef");
    expect(activeAppointments(c.state).map((a) => a.id)).toEqual([98765]);
    expect(c.state.identity.activePatient!.appointmentsStatus).toBe("error");
  });

  it.each(["missing replacement", "stale original"])(
    "reconciles a reload with %s before speaking",
    async (scenario) => {
      const { resolveExistingPatient } =
        await import("../identity/patient-identity.js");
      const c = await setup();
      await c.workflow.rescheduleAppointment(c.state, c.args, "move");
      if (scenario === "missing replacement") {
        c.data["/api/patient/resolve"].appointments = [];
        c.data["/api/patient/resolve"].appointmentsStatus = "none";
      }
      c.state.identity.activePatient!.appointmentsStatus = "error";
      const result = await resolveExistingPatient(
        c.state,
        { firstName: "Jane", dob: "01/15/1980" },
        (office, identity) => c.client.resolvePatient({ office, identity }),
      );
      expect(result.outcome).toBe("verified");
      expect(result.reply).toContain("one upcoming appointment");
      expect(result.reply).not.toContain("don't see any upcoming appointments");
      expect(result.reply).toContain("appointmentRef");
      expect(activeAppointments(c.state).map((a) => a.id)).toEqual([98765]);
      expect(c.writes()).toHaveLength(1);
    },
  );
});
