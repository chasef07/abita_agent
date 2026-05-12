import { afterEach, describe, expect, it, vi } from "vitest";
import {
  add_patient,
  add_patient_note,
  appointmentTypeIdSchema,
  book_appt,
  buildCallCenterHandoffHeaders,
  cancel_appt,
  check_insurance,
  get_availability,
  makeCurrentSpeechUninterruptible,
  route_to_spring_hill,
  transfer_call,
  update_insurance,
  verify_patient,
  type CallState,
} from "../tools.js";

type SpeechContext = Parameters<typeof makeCurrentSpeechUninterruptible>[0];
type ToolContext = Parameters<typeof book_appt.execute>[1]["ctx"];

describe("tool interruption handling", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("marks the active speech handle as uninterruptible", () => {
    const speechHandle = { allowInterruptions: true };

    const result = makeCurrentSpeechUninterruptible({
      speechHandle,
    } as SpeechContext);

    expect(result).toBe(true);
    expect(speechHandle.allowInterruptions).toBe(false);
  });

  it("does not throw if the active speech was already interrupted", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const speechHandle = {};
    Object.defineProperty(speechHandle, "allowInterruptions", {
      get: () => true,
      set: () => {
        throw new Error("speech already interrupted");
      },
    });

    const result = makeCurrentSpeechUninterruptible({
      speechHandle,
    } as SpeechContext);

    expect(result).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("marks side-effecting tools as uninterruptible before the side effect", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({ status: "ok", patientId: "patient-2" }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const mutationTools = [
      {
        name: "add_patient",
        run: (ctx: ToolContext) =>
          add_patient.execute(
            {
              firstName: "Jane",
              lastName: "Doe",
              dob: "01/01/1980",
              street: "123 Main St",
              aptSuite: "",
              city: "Spring Hill",
              state: "FL",
              zip: "34609",
              sex: "female",
              insurance: "Aetna",
              subscriberName: "Jane Doe",
              subscriberNum: "ABC123",
            },
            { ctx, toolCallId: "test-add" },
          ),
      },
      {
        name: "update_insurance",
        run: (ctx: ToolContext) =>
          update_insurance.execute(
            {
              insurance: "Aetna",
              subscriberName: "Jane Doe",
              subscriberNum: "ABC123",
            },
            { ctx, toolCallId: "test-update" },
          ),
      },
      {
        name: "cancel_appt",
        run: (ctx: ToolContext) =>
          cancel_appt.execute(
            { appointmentId: 12345 },
            { ctx, toolCallId: "test-cancel" },
          ),
      },
      {
        name: "add_patient_note",
        run: (ctx: ToolContext) =>
          add_patient_note.execute(
            {
              appointmentReason: "blurry vision",
              referringDoctor: "none",
            },
            { ctx, toolCallId: "test-note" },
          ),
      },
      {
        name: "book_appt",
        run: (ctx: ToolContext) =>
          book_appt.execute(
            {
              columnId: 1,
              profileId: 2,
              startDatetime: "2026-04-28T09:00",
              duration: 15,
              appointmentTypeId: 1007,
            },
            { ctx, toolCallId: "test-book" },
          ),
      },
    ];

    for (const mutationTool of mutationTools) {
      const { ctx, speechHandle } = createToolContext();

      await mutationTool.run(ctx);

      expect(speechHandle.allowInterruptions, mutationTool.name).toBe(false);
    }

    expect(fetchMock).toHaveBeenCalledTimes(mutationTools.length);

    const { ctx, speechHandle, state } = createToolContext();
    state.sipRoomName = "";

    await transfer_call.execute({}, { ctx, toolCallId: "test-transfer" });

    expect(speechHandle.allowInterruptions).toBe(false);
    expect(ctx.waitForPlayout).toHaveBeenCalledOnce();
  });

  it("builds call-center handoff SIP headers from the original inbound call", () => {
    const { state } = createToolContext();

    expect(buildCallCenterHandoffHeaders(state, "+16182265883")).toEqual({
      "X-Acuity-Caller-Phone": "+17275551212",
      "X-Acuity-Handoff": "call-center",
      "X-Acuity-LiveKit-Call-Id": "call-123",
      "X-Acuity-Office-Key": "spring-hill",
      "X-Acuity-Transfer-Number": "+16182265883",
      "X-Acuity-Trunk-Phone": "+17275919997",
    });
  });

  it("attaches verified patient identity to booking requests", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({ status: "booked", appointmentId: 12345 }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { ctx } = createToolContext();

    await book_appt.execute(
      {
        columnId: 1,
        profileId: 2,
        startDatetime: "2026-04-28T09:00",
        duration: 15,
        appointmentTypeId: 1007,
      },
      { ctx, toolCallId: "test-book" },
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(requestBody).toMatchObject({
      appointmentTypeId: 1007,
      columnId: 1,
      duration: 15,
      patientId: "patient-1",
      patientName: "Jane Doe",
      profileId: 2,
      startDatetime: "2026-04-28T09:00",
    });
  });

  it("sends patient notes with session patient and office state", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({ status: "saved", noteId: "3135521" }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, state } = createToolContext();
    state.patientId = "17603880";
    state.officeKey = "crystal-river";
    state.amdOfficePhone = "+13523202007";

    await add_patient_note.execute(
      {
        appointmentReason: "blurry vision",
        referringDoctor: "Dr. Smith",
      },
      { ctx, toolCallId: "test-note" },
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://advancedmd-token-management-production.up.railway.app/api/patient/notes",
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      patientId: "17603880",
      note: "Appointment reason: blurry vision\nReferring doctor: Dr. Smith",
      office: "+13523202007",
    });
  });

  it("constrains booking to supported appointment type IDs", () => {
    expect(appointmentTypeIdSchema.safeParse(1007).success).toBe(true);
    expect(appointmentTypeIdSchema.safeParse(1010).success).toBe(true);
    expect(appointmentTypeIdSchema.safeParse(6169).success).toBe(true);
    expect(appointmentTypeIdSchema.safeParse(9999).success).toBe(false);
  });

  it("stores the routine vision routing lane from availability and reuses it for booking", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({ status: "ok" }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, state } = createToolContext();
    state.officeKey = "crystal-river";
    state.amdOfficePhone = "+13523202007";
    state.routing = "all_three";

    await check_insurance.execute(
      { plan: "VSP", coverageType: "routine_vision" },
      { ctx, toolCallId: "test-insurance" },
    );

    await get_availability.execute(
      { date: "2026-04-28", routing: "all_three" },
      { ctx, toolCallId: "test-availability" },
    );

    expect(state.officeKey).toBe("spring-hill");
    expect(state.amdOfficePhone).toBe("+17275919997");
    expect(state.lastAvailabilityRouting).toBe("optical_only");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      date: "2026-04-28",
      office: "+17275919997",
      routing: "optical_only",
    });

    await book_appt.execute(
      {
        columnId: 1600,
        profileId: 1983,
        startDatetime: "2026-04-28T10:00",
        duration: 45,
        appointmentTypeId: 1010,
        routing: "all_three",
      },
      { ctx, toolCallId: "test-book" },
    );

    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({
      appointmentTypeId: 1010,
      columnId: 1600,
      duration: 45,
      patientId: "patient-1",
      profileId: 1983,
      office: "+17275919997",
      routing: "optical_only",
      startDatetime: "2026-04-28T10:00",
    });
  });

  it("routes routine vision verification to Spring Hill after the vision insurance check", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({
        patientId: "patient-vision",
        name: "Jane Doe",
        dob: "01/01/1980",
        insuranceCarrier: "VSP",
        routing: "optical_only",
        allowedProviders: [],
      }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, state } = createToolContext();
    state.officeKey = "crystal-river";
    state.amdOfficePhone = "+13523202007";
    state.patientId = null;

    await check_insurance.execute(
      { plan: "VSP", coverageType: "routine_vision" },
      { ctx, toolCallId: "test-insurance" },
    );

    await verify_patient.execute(
      { firstName: "Jane", lastName: "Doe", dob: "01/01/1980" },
      { ctx, toolCallId: "test-verify" },
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      firstName: "Jane",
      lastName: "Doe",
      dob: "01/01/1980",
      office: "+17275919997",
    });
    expect(state.officeKey).toBe("spring-hill");
    expect(state.checkedInsuranceCoverageType).toBe("routine_vision");
  });

  it("attaches checked routine vision coverage to new patient registration", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({
        status: "created",
        patientId: "patient-2",
        routing: "optical_only",
      }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, state } = createToolContext();
    state.officeKey = "crystal-river";
    state.amdOfficePhone = "+13523202007";
    state.patientId = null;
    state.patientName = null;
    state.checkedInsurancePlan = null;
    state.checkedInsuranceCoverageType = null;

    const insuranceResult = await check_insurance.execute(
      { plan: "Lincoln Finacial", coverageType: "routine_vision" },
      { ctx, toolCallId: "test-insurance" },
    );

    expect(insuranceResult).toMatchObject({
      status: "accepted",
      canonicalPlan: "VSP",
    });

    await add_patient.execute(
      {
        firstName: "Jane",
        lastName: "Doe",
        dob: "01/01/1980",
        street: "123 Main St",
        aptSuite: "",
        city: "Spring Hill",
        state: "FL",
        zip: "34609",
        sex: "female",
        insurance: "Lincoln Finacial",
        subscriberName: "Jane Doe",
        subscriberNum: "ABC123",
      },
      { ctx, toolCallId: "test-add" },
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      coverageType: "routine_vision",
      insurance: "VSP",
      office: "+17275919997",
      subscriberNum: "ABC123",
    });
    expect(state.officeKey).toBe("spring-hill");
    expect(state.routing).toBe("optical_only");
  });

  it("does not run side effects if the speech already became interrupted", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const mutationTools = [
      {
        name: "add_patient",
        run: (ctx: ToolContext) =>
          add_patient.execute(
            {
              firstName: "Jane",
              lastName: "Doe",
              dob: "01/01/1980",
              street: "123 Main St",
              aptSuite: "",
              city: "Spring Hill",
              state: "FL",
              zip: "34609",
              sex: "female",
              insurance: "Aetna",
              subscriberName: "Jane Doe",
              subscriberNum: "ABC123",
            },
            { ctx, toolCallId: "test-add" },
          ),
      },
      {
        name: "update_insurance",
        run: (ctx: ToolContext) =>
          update_insurance.execute(
            {
              insurance: "Aetna",
              subscriberName: "Jane Doe",
              subscriberNum: "ABC123",
            },
            { ctx, toolCallId: "test-update" },
          ),
      },
      {
        name: "cancel_appt",
        run: (ctx: ToolContext) =>
          cancel_appt.execute(
            { appointmentId: 12345 },
            { ctx, toolCallId: "test-cancel" },
          ),
      },
      {
        name: "add_patient_note",
        run: (ctx: ToolContext) =>
          add_patient_note.execute(
            {
              appointmentReason: "blurry vision",
              referringDoctor: "none",
            },
            { ctx, toolCallId: "test-note" },
          ),
      },
      {
        name: "book_appt",
        run: (ctx: ToolContext) =>
          book_appt.execute(
            {
              columnId: 1,
              profileId: 2,
              startDatetime: "2026-04-28T09:00",
              duration: 15,
              appointmentTypeId: 1007,
            },
            { ctx, toolCallId: "test-book" },
          ),
      },
    ];

    for (const mutationTool of mutationTools) {
      const { ctx } = createInterruptedToolContext();
      const result = await mutationTool.run(ctx);

      expect(result, mutationTool.name).toMatch(/interrupted/i);
    }

    const { ctx } = createInterruptedToolContext();
    const transferResult = await transfer_call.execute(
      {},
      { ctx, toolCallId: "test-transfer" },
    );

    expect(transferResult).toMatch(/interrupted/i);
    expect(ctx.waitForPlayout).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it("tells Crystal River callers when Spring Hill accepts insurance Crystal River does not", async () => {
    const { ctx, state } = createToolContext();
    state.officeKey = "crystal-river";
    state.amdOfficePhone = "+13523202007";

    const result = await check_insurance.execute(
      { plan: "Humana PPO" },
      { ctx, toolCallId: "test-check-insurance" },
    );

    expect(result).toMatchObject({
      status: "not_accepted",
      canProceed: false,
      acceptedAtAlternateOffice: "Spring Hill",
      alternateCanonicalPlan: "Humana PPO",
      routeTool: "route_to_spring_hill",
    });
    expect(result.callerMessage).toContain("Spring Hill accepts Humana PPO");
  });

  it("tells Crystal River callers when Spring Hill accepts an added office-specific rejection", async () => {
    const { ctx, state } = createToolContext();
    state.officeKey = "crystal-river";
    state.amdOfficePhone = "+13523202007";

    const result = await check_insurance.execute(
      { plan: "Ambetter" },
      { ctx, toolCallId: "test-check-ambetter" },
    );

    expect(result).toMatchObject({
      status: "not_accepted",
      canProceed: false,
      acceptedAtAlternateOffice: "Spring Hill",
      alternateCanonicalPlan: "Ambetter",
      routeTool: "route_to_spring_hill",
    });
  });

  it("does not route Crystal River callers on plans that still need clarification", async () => {
    const { ctx, state } = createToolContext();
    state.officeKey = "crystal-river";
    state.amdOfficePhone = "+13523202007";

    const result = await check_insurance.execute(
      { plan: "Oscar" },
      { ctx, toolCallId: "test-check-insurance-clarify" },
    );

    expect(result).toMatchObject({
      status: "needs_clarification",
      canProceed: false,
    });
    expect(result).not.toHaveProperty("acceptedAtAlternateOffice");
    expect(result).not.toHaveProperty("alternateCanonicalPlan");
    expect(result).not.toHaveProperty("routeTool");
    expect(result.callerMessage).toContain("can't confirm");
  });

  it("routes the active Crystal River workflow to Spring Hill", async () => {
    const { ctx, state } = createToolContext();
    state.officeKey = "crystal-river";
    state.amdOfficePhone = "+13523202007";

    await route_to_spring_hill.execute(
      {},
      { ctx, toolCallId: "test-route-spring-hill" },
    );

    expect(state.officeKey).toBe("spring-hill");
    expect(state.amdOfficePhone).toBe("+17275919997");
  });
});

function createToolContext() {
  const speechHandle = { allowInterruptions: true };
  const state: CallState = {
    officeKey: "spring-hill",
    amdOfficePhone: "+17275919997",
    sipRoomName: "room",
    sipParticipantIdentity: "caller",
    callId: "call-123",
    callerPhone: "+17275551212",
    trunkPhone: "+17275919997",
    patientId: "patient-1",
    patientName: "Jane Doe",
    dob: "01/01/1980",
    insuranceCarrier: "Old Plan",
    insPlanId: "plan-1",
    respPartyId: "resp-1",
    checkedInsurancePlan: "Aetna",
    checkedInsuranceCoverageType: "medical",
    routing: "all_three",
    lastAvailabilityRouting: null,
    allowedProviders: [],
    routingAmbiguous: false,
    preauthRequired: false,
    appointments: [],
    transferred: false,
  };
  const ctx = {
    session: { userData: state },
    speechHandle,
    waitForPlayout: vi.fn(),
  } as unknown as ToolContext;

  return { ctx, speechHandle, state };
}

function createInterruptedToolContext() {
  const { state } = createToolContext();
  const speechHandle = {};
  Object.defineProperty(speechHandle, "allowInterruptions", {
    get: () => true,
    set: () => {
      throw new Error("speech already interrupted");
    },
  });
  const ctx = {
    session: { userData: state },
    speechHandle,
    waitForPlayout: vi.fn(),
  } as unknown as ToolContext;

  return { ctx, speechHandle, state };
}
