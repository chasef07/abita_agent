import { llm } from "@livekit/agents";
import { initializeLogger } from "../../node_modules/@livekit/agents/src/log.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExistingAppointmentTask } from "../tasks/ExistingAppointmentTask.js";
import { IdentifyPatientTask } from "../tasks/IdentifyPatientTask.js";
import {
  add_patient,
  buildWorkingStateSummary,
  book_appt,
  cancel_appt,
  confirm_appt,
  createInitialCallState,
  get_availability,
  verify_patient,
  type CallState,
  type CallerAppointment,
} from "../tools.js";

initializeLogger({ pretty: false, level: "error" });

function createCtx(state: CallState) {
  return {
    session: { userData: state },
    waitForPlayout: vi.fn(async () => {}),
    speechHandle: { allowInterruptions: true },
  } as any;
}

function appointment(
  overrides: Partial<CallerAppointment> = {},
): CallerAppointment {
  return {
    id: 1,
    date: "2026-04-24",
    time: "10:00 AM",
    provider: "Dr. Noel",
    type: "Follow-up",
    facility: "Spring Hill",
    confirmed: true,
    ...overrides,
  };
}

describe("phase 1 state and tool guards", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps registration closed after the first verify_patient miss", async () => {
    const state = createInitialCallState({
      officeKey: "spring-hill",
      officePhone: "+17275919997",
      amdOfficePhone: "+17275919997",
      sipRoomName: "room",
      sipParticipantIdentity: "sip",
      callerPhone: "+18135551234",
    });
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ message: "no match" }), { status: 200 }),
    );

    await (verify_patient as any).execute(
      {
        firstName: "Maria",
        lastName: "Santos",
        dob: "03/05/1982",
      },
      { ctx: createCtx(state) },
    );

    expect(state.workflow.verificationStatus).toBe("no_match");
    expect(state.workflow.verificationAttempts).toBe(1);
    expect(state.workflow.registrationAllowed).toBe(false);
  });

  it("allows registration after repeated full-detail verify misses", async () => {
    const state = createInitialCallState({
      officeKey: "spring-hill",
      officePhone: "+17275919997",
      amdOfficePhone: "+17275919997",
      sipRoomName: "room",
      sipParticipantIdentity: "sip",
      callerPhone: "+18135551234",
    });
    vi.mocked(fetch).mockImplementation(
      async () =>
        new Response(JSON.stringify({ message: "no match" }), { status: 200 }),
    );

    await (verify_patient as any).execute(
      {
        firstName: "Maria",
        lastName: "Santos",
        dob: "03/05/1982",
      },
      { ctx: createCtx(state) },
    );
    await (verify_patient as any).execute(
      {
        firstName: "Maria",
        lastName: "Santos",
        dob: "03/05/1982",
      },
      { ctx: createCtx(state) },
    );

    expect(state.workflow.verificationStatus).toBe("no_match");
    expect(state.workflow.verificationAttempts).toBe(2);
    expect(state.workflow.registrationAllowed).toBe(true);
  });

  it("blocks add_patient when an existing patient is already identified", async () => {
    const state = createInitialCallState({
      officeKey: "spring-hill",
      officePhone: "+17275919997",
      amdOfficePhone: "+17275919997",
      sipRoomName: "room",
      sipParticipantIdentity: "sip",
      callerPhone: "+18135551234",
      phoneLookup: {
        status: "verified",
        patientId: "P123",
        name: "Maria Santos",
        dob: "03/05/1982",
        phone: "+18135551234",
        insuranceCarrier: "Florida Blue",
        insPlanId: "IP1",
        respPartyId: "RP1",
        routing: "accepted",
        allowedProviders: [],
        routingAmbiguous: false,
        appointments: [],
      },
    });

    const result = await (add_patient as any).execute(
      {
        firstName: "Maria",
        lastName: "Santos",
        dob: "03/05/1982",
        email: "maria@example.org",
        street: "100 Main Street",
        aptSuite: "",
        city: "Spring Hill",
        state: "FL",
        zip: "34609",
        sex: "female",
        insurance: "Florida Blue",
        subscriberName: "Maria Santos",
        subscriberNum: "12345",
      },
      { ctx: createCtx(state) },
    );

    expect(result).toContain("already identified");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("clears the active patient context before allowing switched-patient registration", async () => {
    const state = createInitialCallState({
      officeKey: "spring-hill",
      officePhone: "+17275919997",
      amdOfficePhone: "+17275919997",
      sipRoomName: "room",
      sipParticipantIdentity: "sip",
      callerPhone: "+18135551234",
      phoneLookup: {
        status: "verified",
        patientId: "P123",
        name: "Maria Santos",
        dob: "03/05/1982",
        phone: "+18135551234",
        insuranceCarrier: "Florida Blue",
        insPlanId: "IP1",
        respPartyId: "RP1",
        routing: "accepted",
        allowedProviders: ["Dr. Noel"],
        routingAmbiguous: false,
        appointments: [appointment()],
      },
    });

    const task = new IdentifyPatientTask(new llm.ChatContext(), state);

    await (task as any)._tools.allow_registration.execute(
      { reason: "caller said this is for a new patient" },
      {
        ctx: {
          ...createCtx(state),
          userData: state,
        },
      },
    );

    expect(state.identity.patientId).toBeNull();
    expect(state.identity.patientName).toBeNull();
    expect(state.identity.switchedPatientThisCall).toBe(true);
    expect(state.workflow.registrationAllowed).toBe(true);
    expect(state.insurance.checkedInsurancePlan).toBeNull();
    expect(state.scheduling.appointments).toHaveLength(0);
  });

  it("rejects duplicate same-date availability lookups", async () => {
    const state = createInitialCallState({
      officeKey: "spring-hill",
      officePhone: "+17275919997",
      amdOfficePhone: "+17275919997",
      sipRoomName: "room",
      sipParticipantIdentity: "sip",
      callerPhone: "+18135551234",
      phoneLookup: {
        status: "verified",
        patientId: "P123",
        name: "Maria Santos",
        dob: "03/05/1982",
        phone: "+18135551234",
        insuranceCarrier: "Florida Blue",
        insPlanId: "IP1",
        respPartyId: "RP1",
        routing: "accepted",
        allowedProviders: [],
        routingAmbiguous: false,
        appointments: [],
      },
    });
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify([]), { status: 200 }),
    );
    state.scheduling.reasonForVisit = "blurry vision";

    await (get_availability as any).execute(
      { date: "2026-04-24" },
      { ctx: createCtx(state) },
    );
    const second = await (get_availability as any).execute(
      { date: "2026-04-24" },
      { ctx: createCtx(state) },
    );

    expect(second).toContain("already checked");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("requires a visit reason before checking availability", async () => {
    const state = createInitialCallState({
      officeKey: "spring-hill",
      officePhone: "+17275919997",
      amdOfficePhone: "+17275919997",
      sipRoomName: "room",
      sipParticipantIdentity: "sip",
      callerPhone: "+18135551234",
      phoneLookup: {
        status: "verified",
        patientId: "P123",
        name: "Maria Santos",
        dob: "03/05/1982",
        phone: "+18135551234",
        insuranceCarrier: "Florida Blue",
        insPlanId: "IP1",
        respPartyId: "RP1",
        routing: "accepted",
        allowedProviders: [],
        routingAmbiguous: false,
        appointments: [],
      },
    });

    const result = await (get_availability as any).execute(
      { date: "2026-04-24" },
      { ctx: createCtx(state) },
    );

    expect(result).toContain("reason for the visit is required");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("persists appointments from confirm_appt", async () => {
    const state = createInitialCallState({
      officeKey: "spring-hill",
      officePhone: "+17275919997",
      amdOfficePhone: "+17275919997",
      sipRoomName: "room",
      sipParticipantIdentity: "sip",
      callerPhone: "+18135551234",
      phoneLookup: {
        status: "verified",
        patientId: "P123",
        name: "Maria Santos",
        dob: "03/05/1982",
        phone: "+18135551234",
        insuranceCarrier: "Florida Blue",
        insPlanId: "IP1",
        respPartyId: "RP1",
        routing: "accepted",
        allowedProviders: [],
        routingAmbiguous: false,
        appointments: [],
      },
    });
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify([appointment()]), { status: 200 }),
    );

    await (confirm_appt as any).execute({}, { ctx: createCtx(state) });

    expect(state.scheduling.appointments).toHaveLength(1);
    expect(state.scheduling.appointments[0]?.id).toBe(1);
    expect(state.scheduling.appointmentsSource).toBe("confirm_appt");
    expect(state.scheduling.appointmentsLoadedAt).not.toBeNull();
  });

  it("refreshes appointments after a patient is verified during an appointment-change flow", async () => {
    const state = createInitialCallState({
      officeKey: "spring-hill",
      officePhone: "+17275919997",
      amdOfficePhone: "+17275919997",
      sipRoomName: "room",
      sipParticipantIdentity: "sip",
      callerPhone: "+18135551234",
    });
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/verify-patient")) {
        return new Response(
          JSON.stringify({
            patientId: "P123",
            name: "Maria Santos",
            dob: "03/05/1982",
            insuranceCarrier: "Florida Blue",
            insPlanId: "IP1",
            respPartyId: "RP1",
            routing: "accepted",
            allowedProviders: [],
            routingAmbiguous: false,
            appointments: [],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/api/patient/appointments")) {
        return new Response(JSON.stringify([appointment()]), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await (verify_patient as any).execute(
      {
        firstName: "Maria",
        lastName: "Santos",
        dob: "03/05/1982",
      },
      { ctx: createCtx(state) },
    );

    expect(state.scheduling.appointments).toHaveLength(0);

    const task = new ExistingAppointmentTask(
      new llm.ChatContext(),
      state,
      "confirm",
    );

    await (task as any)._tools.load_existing_appointments.execute(
      {},
      {
        ctx: {
          ...createCtx(state),
          userData: state,
        },
      },
    );

    expect(state.scheduling.appointments).toHaveLength(1);
    expect(state.scheduling.appointmentsSource).toBe("confirm_appt");
  });

  it("blocks booking the same slot twice in one call", async () => {
    const state = createInitialCallState({
      officeKey: "spring-hill",
      officePhone: "+17275919997",
      amdOfficePhone: "+17275919997",
      sipRoomName: "room",
      sipParticipantIdentity: "sip",
      callerPhone: "+18135551234",
      phoneLookup: {
        status: "verified",
        patientId: "P123",
        name: "Maria Santos",
        dob: "03/05/1982",
        phone: "+18135551234",
        insuranceCarrier: "Florida Blue",
        insPlanId: "IP1",
        respPartyId: "RP1",
        routing: "accepted",
        allowedProviders: [],
        routingAmbiguous: false,
        appointments: [],
      },
    });
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ status: "booked" }), { status: 200 }),
    );

    const params = {
      columnId: 11,
      profileId: 22,
      startDatetime: "2026-04-24T10:00",
      duration: 30,
      appointmentTypeId: 1007,
    };

    await (book_appt as any).execute(params, { ctx: createCtx(state) });
    const second = await (book_appt as any).execute(params, {
      ctx: createCtx(state),
    });

    expect(second).toContain("already booked");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects booking a slot not found in the latest availability results", async () => {
    const state = createInitialCallState({
      officeKey: "spring-hill",
      officePhone: "+17275919997",
      amdOfficePhone: "+17275919997",
      sipRoomName: "room",
      sipParticipantIdentity: "sip",
      callerPhone: "+18135551234",
      phoneLookup: {
        status: "verified",
        patientId: "P123",
        name: "Maria Santos",
        dob: "03/05/1982",
        phone: "+18135551234",
        insuranceCarrier: "Florida Blue",
        insPlanId: "IP1",
        respPartyId: "RP1",
        routing: "accepted",
        allowedProviders: [],
        routingAmbiguous: false,
        appointments: [],
      },
    });
    state.scheduling.lastAvailabilityRaw = [
      {
        startDatetime: "2026-04-24T09:00",
        columnId: 11,
        profileId: 22,
        duration: 30,
        appointmentTypeId: 1007,
      },
    ];

    const result = await (book_appt as any).execute(
      {
        columnId: 11,
        profileId: 22,
        startDatetime: "2026-04-24T10:00",
        duration: 30,
        appointmentTypeId: 1007,
      },
      { ctx: createCtx(state) },
    );

    expect(result).toContain("not in the most recent availability results");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("requires a known appointment before cancelling", async () => {
    const state = createInitialCallState({
      officeKey: "spring-hill",
      officePhone: "+17275919997",
      amdOfficePhone: "+17275919997",
      sipRoomName: "room",
      sipParticipantIdentity: "sip",
      callerPhone: "+18135551234",
      phoneLookup: {
        status: "verified",
        patientId: "P123",
        name: "Maria Santos",
        dob: "03/05/1982",
        phone: "+18135551234",
        insuranceCarrier: "Florida Blue",
        insPlanId: "IP1",
        respPartyId: "RP1",
        routing: "accepted",
        allowedProviders: [],
        routingAmbiguous: false,
        appointments: [],
      },
    });

    const result = await (cancel_appt as any).execute(
      { appointmentId: 999 },
      { ctx: createCtx(state) },
    );

    expect(result).toContain("not currently loaded");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("tracks phone lookup as a match without treating it as caller-confirmed identity", () => {
    const state = createInitialCallState({
      officeKey: "spring-hill",
      officePhone: "+17275919997",
      amdOfficePhone: "+17275919997",
      sipRoomName: "room",
      sipParticipantIdentity: "sip",
      callerPhone: "+18135551234",
      phoneLookup: {
        status: "verified",
        patientId: "P123",
        name: "Maria Santos",
        dob: "03/05/1982",
        phone: "+18135551234",
        insuranceCarrier: "Florida Blue",
        insPlanId: "IP1",
        respPartyId: "RP1",
        routing: "accepted",
        allowedProviders: [],
        routingAmbiguous: false,
        appointments: [appointment()],
      },
    });

    expect(state.identity.lookupMatchStatus).toBe("single_match");
    expect(state.identity.originalLookupPatientId).toBe("P123");
    expect(state.identity.callerConfirmedPatient).toBe(false);
    expect(state.identity.activePatientMatchesLookup).toBe(true);
    expect(state.scheduling.appointmentsSource).toBe("phone_lookup");
    expect(buildWorkingStateSummary(state, "identify")).toContain(
      "caller confirmed patient: no",
    );
  });
});
