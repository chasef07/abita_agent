import { createUpdateInsuranceTool } from "../tools/update-insurance.js";
import { createAddPatientTool } from "../tools/add-patient.js";
import { describe, expect, it, vi } from "vitest";
import { HttpOwnedMiddleware } from "../clients/owned-middleware.js";
import { parseInsuranceDecision } from "../clients/insurance-decision.js";
import { createCheckInsuranceTool } from "../tools/check-insurance.js";
import {
  loadAvailability,
  storeAvailabilityBookingToken,
} from "../scheduling/availability.js";
import { bookingRequestBodyForSlot } from "../scheduling/booking.js";
import { medicalInsuranceSchedulingBlock } from "../scheduling/state.js";
import { createConfirmedPatientState } from "./support/call-state.js";
import { createToolContext } from "./support/tool-context.js";
import { medicalDecision } from "./support/insurance-decision.js";
import { InMemoryOwnedMiddleware } from "./support/owned-middleware.js";
import { deferredResult } from "./support/deferred-result.js";

const clock = { now: () => new Date("2026-09-17T12:00:00Z") };
function options(state: ReturnType<typeof createConfirmedPatientState>) {
  return { ctx: createToolContext(state), toolCallId: "insurance" } as never;
}

describe("middleware medical insurance contract", () => {
  it("sends the clarified backend product and current routing into scoped availability and booking", async () => {
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    const decision = medicalDecision({
      canonicalPlan: "Humana Medicare PPO",
      carrierCode: "HUM PPO",
      routing: "bach_only",
      selfPay: false,
    });
    const client = new HttpOwnedMiddleware({
      middlewareBaseUrl: "https://middleware.test",
      fetch: vi.fn(async (url, init) => {
        const path = new URL(String(url)).pathname;
        requests.push({ path, body: JSON.parse(String(init?.body)) });
        return Response.json(
          path === "/api/insurance/decision"
            ? decision
            : { outcome: "no_availability", slots: [] },
        );
      }),
    });
    const state = createConfirmedPatientState({
      insuranceCarrier: "HUMANA PPO POS",
      routing: "all_three",
      preauthRequired: true,
    });
    const answer = await createCheckInsuranceTool(client).execute(
      { plan: "Humana Medicare PPO", coverageType: "medical" },
      options(state),
    );
    expect(answer).toBe(decision.answer);
    await loadAvailability(
      state,
      { visitType: "medical", startDate: "2026-09-18" },
      client,
      clock,
    );
    expect(requests[1]?.body).toMatchObject({
      patientId: "patient-1",
      insurancePlan: "Humana Medicare PPO",
      coverageType: "medical",
      routing: "bach_only",
    });
    expect(requests[1]?.body).not.toHaveProperty("preauthRequired");
    const slot = {
      slotId: "S1",
      provider: "Dr. Bach",
      date: "2026-09-18",
      time: "9:00 AM",
      datetime: "2026-09-18T09:00:00-04:00",
      routing: "all_three",
    };
    storeAvailabilityBookingToken(
      state,
      "S1",
      "opaque",
      "2026-09-18T00:00:00Z",
    );
    const body = bookingRequestBodyForSlot(state, {
      selectedSlot: slot,
      patientId: "patient-1",
      appointmentReason: "eye irritation",
      referringDoctor: "none",
      now: clock.now(),
    });
    expect(body).toMatchObject({
      insurancePlan: "Humana Medicare PPO",
      routing: "bach_only",
      visitCategory: "medical",
    });
  });

  it("retains registration permission while blocking scheduling for HUM02 authorization", async () => {
    const decision = medicalDecision({
      canonicalPlan: "Humana Medicaid HMO",
      carrierCode: "HUM02",
      canSchedule: false,
      outcome: "needs_staff_task",
      requirements: [
        { kind: "prior_authorization", verification: "unverified" },
      ],
      answer: "blocked: Prior authorization is required.",
    });
    const state = createConfirmedPatientState();
    state.workflow.visitType = "medical";
    const client = new InMemoryOwnedMiddleware({
      checkInsurance: [decision, undefined],
    });
    const tool = createCheckInsuranceTool(client);
    expect(
      await tool.execute(
        { plan: "Humana Medicaid HMO", coverageType: "medical" },
        options(state),
      ),
    ).toBe(decision.answer);
    expect(state.insurance.lastEligibilityCheck?.accepted).toBe(true);
    expect(medicalInsuranceSchedulingBlock(state)).toBe(decision.answer);
    await tool.execute(
      { plan: "another plan", coverageType: "medical" },
      options(state),
    );
    expect(state.insurance.lastEligibilityCheck?.accepted).toBe(false);
    expect(medicalInsuranceSchedulingBlock(state)).toContain("Check");
  });

  it("does not apply a late medical check to a changed patient", async () => {
    const pending = deferredResult<ReturnType<typeof medicalDecision>>();
    const client = new InMemoryOwnedMiddleware({
      checkInsurance: [pending.promise],
    });
    const state = createConfirmedPatientState();
    const response = createCheckInsuranceTool(client).execute(
      { plan: "Self Pay", coverageType: "medical" },
      options(state),
    );
    state.identity.transitionVersion++;
    state.insurance.lastEligibilityCheck = null;
    pending.resolve(medicalDecision());
    expect(await response).toContain("changed");
    expect(state.insurance.lastEligibilityCheck).toBeNull();
  });

  it("keeps vision on its existing local path", async () => {
    const client = new InMemoryOwnedMiddleware();
    const state = createConfirmedPatientState();
    await createCheckInsuranceTool(client).execute(
      { plan: "VSP", coverageType: "routine_vision" },
      options(state),
    );
    expect(client.operations).toEqual([]);
    expect(state.insurance.lastEligibilityCheck?.accepted).toBe(true);
  });

  it("rejects malformed permissions and preserves write and lookup decisions", async () => {
    expect(
      parseInsuranceDecision({ ...medicalDecision(), canRegister: false }),
    ).toBeUndefined();
    const decision = medicalDecision();
    const client = new HttpOwnedMiddleware({
      middlewareBaseUrl: "https://middleware.test",
      fetch: vi.fn(async () =>
        Response.json({
          status: "created",
          patientId: "123",
          name: "Jane Doe",
          dob: "01/01/1980",
          insuranceDecision: decision,
        }),
      ),
    });
    const result = await client.createPatient({
      office: "+17275919997",
      patient: {
        firstName: "Jane",
        lastName: "Doe",
        dob: "01/01/1980",
        street: "1 Main",
        aptSuite: "",
        city: "Test",
        state: "FL",
        zip: "12345",
        sex: "female",
        insurance: "Self Pay",
        phone: "7275551212",
        subscriberName: "Jane Doe",
        subscriberNum: "self pay",
      },
    });
    expect(result).toMatchObject({
      status: "created",
      insuranceDecision: decision,
    });
  });

  it("requires hospital context and passes it into the appointment", () => {
    const state = createConfirmedPatientState();
    state.workflow.visitType = "medical";
    const slot = {
      slotId: "S1",
      provider: "Dr. Bach",
      date: "2026-09-18",
      time: "9:00 AM",
      datetime: "2026-09-18T09:00:00-04:00",
      routing: "all_three",
    };
    storeAvailabilityBookingToken(state, "S1", "opaque");
    const input = {
      selectedSlot: slot,
      patientId: "patient-1",
      appointmentReason: "hospital follow-up",
      referringDoctor: "none",
      now: clock.now(),
    };
    expect(() => bookingRequestBodyForSlot(state, input)).toThrow(
      "which hospital",
    );
    expect(
      bookingRequestBodyForSlot(state, {
        ...input,
        hospitalName: "Test Hospital",
        hospitalDate: "yesterday",
      }),
    ).toMatchObject({
      hospitalName: "Test Hospital",
      hospitalDate: "yesterday",
    });
  });
});

describe("medical insurance write boundaries", () => {
  it.each(["registration", "update"])(
    "keeps acceptance while blocking %s and scheduling when billing setup is missing",
    async (operation) => {
      const decision = medicalDecision({
        canonicalPlan: "Aetna",
        selfPay: false,
        canRegister: false,
        canSchedule: false,
        allowedProviders: [],
        answer: "success: Yes, we accept Aetna.",
      });
      const client = new InMemoryOwnedMiddleware({
        checkInsurance: [decision],
      });
      const state = createConfirmedPatientState();
      state.workflow.visitType = "medical";
      if (operation === "registration") {
        state.identity.activePatient = null;
        state.identity.registration = null;
      }
      expect(
        await createCheckInsuranceTool(client).execute(
          { plan: "Aetna", coverageType: "medical" },
          options(state),
        ),
      ).toBe(decision.answer);
      expect(state.insurance.lastEligibilityCheck?.accepted).toBe(true);
      expect(medicalInsuranceSchedulingBlock(state)).toContain(
        "before scheduling",
      );
      const answer =
        operation === "registration"
          ? await createAddPatientTool(client).execute(
              registrationArgs(),
              options(state),
            )
          : await createUpdateInsuranceTool(client).execute(
              { insuranceMemberId: "TEST123" },
              options(state),
            );
      expect(answer).toContain("billing setup");
      expect(answer).not.toContain("Check insurance again");
      expect(client.requests.createPatient).toHaveLength(0);
      expect(client.requests.updateInsurance).toHaveLength(0);
    },
  );
  it("does not start another update when a recheck completes during the first write", async () => {
    const decision = medicalDecision();
    const pending =
      deferredResult<
        import("../clients/owned-middleware.js").UpdateInsuranceResult
      >();
    const client = new InMemoryOwnedMiddleware({
      checkInsurance: [decision, decision],
      updateInsurance: [pending.promise],
    });
    const state = createConfirmedPatientState();
    const check = createCheckInsuranceTool(client),
      update = createUpdateInsuranceTool(client);
    await check.execute(
      { plan: "Self Pay", coverageType: "medical" },
      options(state),
    );
    const first = update.execute(
      { insuranceMemberId: "self pay" },
      options(state),
    );
    await check.execute(
      { plan: "Self Pay", coverageType: "medical" },
      options(state),
    );
    expect(
      await update.execute({ insuranceMemberId: "self pay" }, options(state)),
    ).toContain("in progress");
    pending.resolve({
      status: "updated",
      newInsurance: "Self Pay",
      routing: "all_three",
      preauthRequired: false,
      insuranceDecision: decision,
    });
    await first;
    expect(client.requests.updateInsurance).toHaveLength(1);
    expect(state.identity.schedulingWritePending).toBe(false);
  });

  it.each(["throw", "missing-decision"])(
    "fences an uncertain %s update across a later recheck",
    async (failure) => {
      const client = new InMemoryOwnedMiddleware({
        checkInsurance: [medicalDecision(), medicalDecision()],
      });
      const write = vi
        .spyOn(client, "updateInsurance")
        .mockImplementation(async () => {
          if (failure === "throw") throw new Error("lost response");
          return {
            status: "updated",
            newInsurance: "Self Pay",
            routing: "all_three",
            preauthRequired: false,
          };
        });
      const state = createConfirmedPatientState();
      const check = createCheckInsuranceTool(client),
        update = createUpdateInsuranceTool(client);
      await check.execute(
        { plan: "Self Pay", coverageType: "medical" },
        options(state),
      );
      expect(
        await update.execute({ insuranceMemberId: "self pay" }, options(state)),
      ).toContain("could not be verified");
      await check.execute(
        { plan: "Self Pay", coverageType: "medical" },
        options(state),
      );
      expect(
        await update.execute({ insuranceMemberId: "self pay" }, options(state)),
      ).toContain("do not repeat");
      expect(write).toHaveBeenCalledTimes(1);
    },
  );

  it("creates HUM02 coverage but reports and retains the authorization hold", async () => {
    const decision = medicalDecision({
      canonicalPlan: "Humana Medicaid HMO",
      carrierCode: "HUM02",
      canSchedule: false,
      outcome: "needs_staff_task",
      requirements: [
        { kind: "prior_authorization", verification: "unverified" },
      ],
      answer: "blocked: Prior authorization is required.",
    });
    const client = new InMemoryOwnedMiddleware({
      checkInsurance: [decision],
      createPatient: [
        {
          status: "created",
          patientId: "patient-new",
          name: "Jane Doe",
          dob: "01/01/1980",
          phone: "7275551212",
          insuranceCarrier: "HUMANA MEDICAID",
          insPlanId: null,
          respPartyId: null,
          routing: "all_three",
          preauthRequired: true,
          insuranceDecision: decision,
        },
      ],
    });
    const state = createConfirmedPatientState();
    state.identity.activePatient = null;
    state.identity.registration = null;
    await createCheckInsuranceTool(client).execute(
      { plan: "Humana Medicaid HMO", coverageType: "medical" },
      options(state),
    );
    const args = registrationArgs();
    const add = createAddPatientTool(client);
    expect(await add.execute(args, options(state))).toContain(
      "Prior authorization is required",
    );
    expect(state.insurance.onFile?.decision?.canSchedule).toBe(false);
    expect(await add.execute(args, options(state))).not.toContain(
      "continue with scheduling",
    );
    expect(client.requests.createPatient).toHaveLength(1);
  });
});

function registrationArgs() {
  return {
    firstName: "Jane",
    lastName: "Doe",
    dob: "01/01/1980",
    phone: "7275551212",
    inboundPhoneConfirmed: null,
    email: null,
    street: "1 Main",
    aptSuite: null,
    city: "Spring Hill",
    state: "FL",
    zip: "34606",
    sex: "female" as const,
    subscriberName: "Jane Doe",
    insuranceMemberId: "TEST123",
    ssnLast4: null,
    newPatientConfirmed: true as const,
    readBack: true as const,
  };
}

describe("medical registration uncertainty", () => {
  it("serializes duplicate creation while the first result is pending", async () => {
    const pending =
      deferredResult<
        import("../clients/owned-middleware.js").CreatePatientResult
      >();
    const client = new InMemoryOwnedMiddleware({
      checkInsurance: [medicalDecision(), medicalDecision()],
      createPatient: [pending.promise],
    });
    const state = createConfirmedPatientState();
    state.identity.activePatient = null;
    const check = createCheckInsuranceTool(client),
      add = createAddPatientTool(client);
    await check.execute(
      { plan: "Self Pay", coverageType: "medical" },
      options(state),
    );
    const first = add.execute(registrationArgs(), options(state));
    await check.execute(
      { plan: "Self Pay", coverageType: "medical" },
      options(state),
    );
    expect(await add.execute(registrationArgs(), options(state))).toContain(
      "in progress",
    );
    pending.resolve({
      status: "error",
      reason: "request_rejected",
      noWrite: true,
    });
    await expect(first).rejects.toThrow();
    expect(client.requests.createPatient).toHaveLength(1);
  });

  it.each(["throw", "wrong-identity"])(
    "prevents another creation after %s despite a recheck",
    async (failure) => {
      const client = new InMemoryOwnedMiddleware({
        checkInsurance: [medicalDecision(), medicalDecision()],
      });
      const write = vi
        .spyOn(client, "createPatient")
        .mockImplementation(async () => {
          if (failure === "throw") throw new Error("lost create response");
          return {
            status: "created",
            patientId: "other",
            name: "Other Person",
            dob: "01/01/1970",
            phone: "7275551212",
            insuranceCarrier: "SELF PAY",
            routing: "all_three",
            preauthRequired: false,
            insPlanId: null,
            respPartyId: null,
            insuranceDecision: medicalDecision(),
          };
        });
      const state = createConfirmedPatientState();
      state.identity.activePatient = null;
      const check = createCheckInsuranceTool(client),
        add = createAddPatientTool(client);
      await check.execute(
        { plan: "Self Pay", coverageType: "medical" },
        options(state),
      );
      expect(await add.execute(registrationArgs(), options(state))).toContain(
        "do not create another chart",
      );
      await check.execute(
        { plan: "Self Pay", coverageType: "medical" },
        options(state),
      );
      expect(await add.execute(registrationArgs(), options(state))).toContain(
        "do not create another chart",
      );
      expect(write).toHaveBeenCalledTimes(1);
    },
  );
});

it("never repeats an accepted answer for a stale office or failed update check", () => {
  const state = createConfirmedPatientState();
  state.workflow.visitType = "medical";
  state.insurance.lastEligibilityCheck = {
    plan: "Self Pay",
    canonicalPlan: "Self Pay",
    coverageType: "medical",
    currentCarrier: "Self Pay",
    accepted: false,
    decision: medicalDecision(),
  };
  expect(medicalInsuranceSchedulingBlock(state)).toContain("Check");
  state.insurance.lastEligibilityCheck.accepted = true;
  state.office.activeKey = "hollywood";
  expect(medicalInsuranceSchedulingBlock(state)).toContain("selected office");
});
