import { ToolError } from "@livekit/agents";
import { describe, expect, it } from "vitest";
import { RHEUMATOLOGY_DEMO_TRUNK_PHONE } from "../customers/abita/profile.js";
import { createSchedulingTools } from "../scheduling/tools.js";
import { createAddPatientTool } from "../tools/add-patient.js";
import { createCheckInsuranceTool } from "../tools/check-insurance.js";
import { createResolvePatientTool } from "../tools/resolve-patient.js";
import {
  confirmedActivePatient,
  createTestCallState,
} from "./support/call-state.js";
import { InMemoryOwnedMiddleware } from "./support/owned-middleware.js";
import { createToolContext } from "./support/tool-context.js";

const registration = {
  firstName: "Jane",
  lastName: "Doe",
  dob: "01/01/1980",
  phone: null,
  inboundPhoneConfirmed: true,
  email: null,
  street: "123 Main St",
  aptSuite: null,
  city: "Saipan",
  state: "MP",
  zip: "96950",
  sex: "female",
  subscriberName: "Jane Doe",
  insuranceMemberId: "self pay",
  ssnLast4: null,
  newPatientConfirmed: true,
  readBack: true,
} as const;

function setup() {
  const state = createTestCallState({
    officeKey: "rheumatology-demo",
    trunkPhone: RHEUMATOLOGY_DEMO_TRUNK_PHONE,
  });
  const middleware = new InMemoryOwnedMiddleware({
    getAvailability: [
      {
        status: "found",
        requestedDate: "2026-09-21",
        actualDate: "2026-09-21",
        searchedFrom: "2026-09-21",
        searchedThrough: "2026-09-21",
        bookingTokenExpiresAt: "2026-09-20T20:15:00Z",
        dateShifted: false,
        shouldRetrySameSearch: false,
        slots: [
          {
            provider: "Dr. Example",
            date: "2026-09-21",
            time: "9:00 AM",
            datetime: "2026-09-21T09:00:00",
            bookingToken: "isla-test-booking",
          },
        ],
      },
    ],
    bookAppointment: [
      {
        status: "booked",
        appointmentId: 456,
        cancellationToken: "cancel-test",
        rescheduleToken: "reschedule-test",
        visitType: "medical",
        providerName: "Dr. Example",
        locationName: "Test clinic",
        appointmentTypeName: "Medical",
        message: null,
      },
    ],
    resolvePatient: [{ status: "error", reason: "invalid_response" }],
    createPatient: [
      {
        status: "created",
        patientId: "patient-new",
        name: "Jane Doe",
        dob: registration.dob,
        phone: state.runtime.callerPhone,
        insuranceCarrier: "self pay",
        insPlanId: null,
        respPartyId: null,
        routing: "all_three",
        preauthRequired: false,
      },
    ],
  });
  const options = {
    ctx: createToolContext(state),
    toolCallId: "isla-registration",
  } as never;
  return { state, middleware, options };
}

const identity = { firstName: "Jane", dob: registration.dob };

describe("Isla first-registration recovery", () => {
  it("recovers from an invalid lookup through confirmation, insurance and real creation receipt", async () => {
    const { state, middleware, options } = setup();
    const reply = await createResolvePatientTool(middleware).execute(
      identity,
      options,
    );
    expect(reply).toContain("does not mean the patient is new");
    expect(reply).toContain("first registration");
    expect(reply).toContain("add_patient");
    expect(reply).not.toContain("Connect the caller");
    expect(state.identity.activePatient).toBeNull();
    expect(state.identity.unregisteredPatientReceipt).toBeNull();
    expect(
      await createAddPatientTool(middleware).execute(registration, options),
    ).toContain("confirm accepted");
    expect(middleware.requests.createPatient).toHaveLength(0);
    await createCheckInsuranceTool(middleware).execute(
      { plan: "self pay", coverageType: "medical" },
      options,
    );
    expect(
      await createAddPatientTool(middleware).execute(registration, options),
    ).toContain("I created a patient chart for Jane Doe");
    expect(state.identity.activePatient).toMatchObject({
      kind: "created",
      patientId: "patient-new",
    });
    expect(middleware.requests.createPatient).toHaveLength(1);
    const scheduling = createSchedulingTools(middleware, {
      now: () => new Date("2026-09-20T20:00:00Z"),
    });
    const availability = await scheduling.list_available_appointments.execute(
      { startDate: "2026-09-21", visitType: "medical" },
      options,
    );
    expect(availability).toContain("S1");
    await scheduling.book_appointment.execute(
      {
        appointmentSlotRef: "S1",
        appointmentReason: "checkup",
        referringDoctor: "none",
        hospitalName: null,
        hospitalDate: null,
        readBack: true,
      },
      options,
    );
    expect(middleware.requests.bookAppointment).toHaveLength(1);
    expect(middleware.requests.bookAppointment[0]).toMatchObject({
      booking: {
        bookingToken: "isla-test-booking",
        patientId: "patient-new",
        patientStatus: "new",
        appointmentReason: "checkup",
      },
    });
    expect(state.identity.activePatient?.appointments).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 456 })]),
    );
    expect(middleware.operations.map(({ name }) => name)).toEqual([
      "resolvePatient",
      "createPatient",
      "getAvailability",
      "bookAppointment",
    ]);
  });

  it("does not register from lookup failure alone even with accepted insurance", async () => {
    const { state, middleware, options } = setup();
    await createResolvePatientTool(middleware).execute(identity, options);
    await createCheckInsuranceTool(middleware).execute(
      { plan: "self pay", coverageType: "medical" },
      options,
    );
    expect(
      await createAddPatientTool(middleware).execute(
        { ...registration, newPatientConfirmed: null },
        options,
      ),
    ).toContain("ever registered");
    expect(middleware.requests.createPatient).toHaveLength(0);
    expect(state.identity.activePatient).toBeNull();
  });

  it("keeps production lookup failures as tool errors", async () => {
    const { middleware } = setup();
    const options = {
      ctx: createToolContext(createTestCallState()),
      toolCallId: "production",
    } as never;
    await expect(
      createResolvePatientTool(middleware).execute(identity, options),
    ).rejects.toThrow(ToolError);
    expect(middleware.requests.createPatient).toHaveLength(0);
  });

  it("preserves the active-chart protection", async () => {
    const { state, middleware, options } = setup();
    state.identity.activePatient = confirmedActivePatient();
    expect(
      await createAddPatientTool(middleware).execute(registration, options),
    ).toContain("already active");
    expect(middleware.requests.createPatient).toHaveLength(0);
  });

  it("does not turn multiple matches into new-patient advice", async () => {
    const { options } = setup();
    const middleware = new InMemoryOwnedMiddleware({
      resolvePatient: [{ status: "multiple_matches", matches: [] }],
    });
    const reply = await createResolvePatientTool(middleware).execute(
      identity,
      options,
    );
    expect(reply).toContain("More than one patient matches");
    expect(reply).not.toContain("add_patient");
  });
});

describe("Isla registration insurance language", () => {
  it("uses a registration-only description when constructed for Isla", () => {
    const middleware = new InMemoryOwnedMiddleware();
    const isla = createCheckInsuranceTool(middleware, "rheumatology-demo");
    expect(isla.description).toContain("sandbox registration");
    expect(isla.description).toContain("not evidence of Isla participation");
    expect(isla.description).not.toMatch(/Transfer|create a normal staff task/);
    expect(createCheckInsuranceTool(middleware).description).toContain(
      "Check whether the active office accepts a plan",
    );
  });

  it("returns neutral registration eligibility instead of claiming participation", async () => {
    const { state, middleware, options } = setup();
    const reply = await createCheckInsuranceTool(middleware).execute(
      { plan: "Humana Medicare", coverageType: "medical" },
      options,
    );
    expect(reply).toContain("Registration can continue");
    expect(reply).toContain("not evidence of Isla participation");
    expect(reply).not.toMatch(/we take|we accept|connect|transfer/i);
    expect(state.insurance.lastEligibilityCheck).toMatchObject({
      accepted: true,
      coverageType: "medical",
    });
  });

  it.each(["Humana Medicaid", "Unknown Example Plan"])(
    "does not misrepresent a blocked plan (%s) or offer unavailable handoff",
    async (plan) => {
      const { state, middleware, options } = setup();
      const reply = await createCheckInsuranceTool(middleware).execute(
        { plan, coverageType: "medical" },
        options,
      );
      expect(reply).toContain(
        "Registration is not supported with the supplied plan on this line",
      );
      expect(reply).toContain("not an Isla coverage or participation decision");
      expect(reply).not.toMatch(
        /don't accept|do not accept|transfer|staff task|connect/i,
      );
      expect(state.insurance.lastEligibilityCheck?.accepted).toBe(false);
      expect(
        await createAddPatientTool(middleware).execute(registration, options),
      ).toContain("confirm accepted");
      expect(middleware.requests.createPatient).toHaveLength(0);
    },
  );
});
