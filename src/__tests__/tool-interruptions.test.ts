import { afterEach, describe, expect, it, vi } from "vitest";

const { transferSipParticipantMock } = vi.hoisted(() => ({
  transferSipParticipantMock: vi.fn(),
}));

vi.mock("livekit-server-sdk", () => ({
  SipClient: vi.fn(function SipClientMock() {
    return {
      transferSipParticipant: transferSipParticipantMock,
    };
  }),
  RoomServiceClient: vi.fn(function RoomServiceClientMock() {
    return {
      deleteRoom: vi.fn(),
    };
  }),
}));

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
import { createInitialFlowState } from "../flow/index.js";
import { HOLLYWOOD_OFFICE_PHONE, SWEETWATER_OFFICE_PHONE } from "../offices.js";

type SpeechContext = Parameters<typeof makeCurrentSpeechUninterruptible>[0];
type ToolContext = Parameters<typeof book_appt.execute>[1]["ctx"];

describe("tool interruption handling", () => {
  afterEach(() => {
    transferSipParticipantMock.mockReset();
    delete process.env.SPRING_HILL_HANDOFF_TARGET;
    delete process.env.CRYSTAL_RIVER_HANDOFF_TARGET;
    delete process.env.HOLLYWOOD_HANDOFF_TARGET;
    delete process.env.SWEETWATER_HANDOFF_TARGET;
    delete process.env.DEV_HANDOFF_TARGET;
    delete process.env.TELNYX_VOICE_API_HANDOFF_TARGET;
    delete process.env.OFFICE_HANDOFF_TARGET;
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
        run: (ctx: ToolContext) => {
          seedLastAvailabilitySlot(ctx.session.userData as CallState);
          return book_appt.execute(
            {
              slotId: "A",
              appointmentTypeId: 1007,
            },
            { ctx, toolCallId: "test-book" },
          );
        },
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

    expect(
      buildCallCenterHandoffHeaders(state, "sip:office@sip.telnyx.com"),
    ).toEqual({
      "X-Acuity-Caller-Phone": "+17275551212",
      "X-Acuity-Handoff": "call-center",
      "X-Acuity-Handoff-Target": "sip:office@sip.telnyx.com",
      "X-Acuity-LiveKit-Call-Id": "call-123",
      "X-Acuity-Office-Key": "spring-hill",
      "X-Acuity-Trunk-Phone": "+17275919997",
    });
  });

  it("transfers to a configured Telnyx SIP handoff target without forcing tel", async () => {
    process.env.SPRING_HILL_HANDOFF_TARGET =
      "sip:+16182265883@livekitappacuity.sip.telnyx.com";
    transferSipParticipantMock.mockResolvedValue(undefined);
    const { ctx } = createToolContext();

    const result = await transfer_call.execute(
      {},
      { ctx, toolCallId: "test-transfer" },
    );

    expect(result).toBe("Transfer initiated successfully.");
    expect(transferSipParticipantMock).toHaveBeenCalledWith(
      "room",
      "caller",
      "sip:+16182265883@livekitappacuity.sip.telnyx.com",
      {
        headers: {
          "X-Acuity-Caller-Phone": "+17275551212",
          "X-Acuity-Handoff": "call-center",
          "X-Acuity-Handoff-Target":
            "sip:+16182265883@livekitappacuity.sip.telnyx.com",
          "X-Acuity-LiveKit-Call-Id": "call-123",
          "X-Acuity-Office-Key": "spring-hill",
          "X-Acuity-Trunk-Phone": "+17275919997",
        },
        playDialtone: true,
        ringingTimeout: 20,
      },
    );
  });

  it("keeps Crystal River transfers on the existing phone-number handoff", async () => {
    transferSipParticipantMock.mockResolvedValue(undefined);
    const { ctx, state } = createToolContext();
    state.trunkPhone = "+13523202007";
    state.officeKey = "spring-hill";
    state.amdOfficePhone = "+17275919997";
    state.patientId = "spring-hill-patient";

    await transfer_call.execute({}, { ctx, toolCallId: "test-transfer" });

    expect(transferSipParticipantMock).toHaveBeenCalledWith(
      "room",
      "caller",
      "tel:+13527941244",
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Acuity-Handoff-Target": "tel:+13527941244",
          "X-Acuity-Office-Key": "crystal-river",
          "X-Acuity-Trunk-Phone": "+13523202007",
        }),
      }),
    );
  });

  it("transfers Hollywood and Sweetwater callers to the configured handoff number", async () => {
    transferSipParticipantMock.mockResolvedValue(undefined);

    const cases = [
      ["hollywood", HOLLYWOOD_OFFICE_PHONE],
      ["sweetwater", SWEETWATER_OFFICE_PHONE],
    ] as const;

    for (const [officeKey, officePhone] of cases) {
      const { ctx, state } = createToolContext();
      state.trunkPhone = officePhone;
      state.officeKey = officeKey;
      state.amdOfficePhone = officePhone;

      await transfer_call.execute(
        {},
        { ctx, toolCallId: `test-transfer-${officeKey}` },
      );

      expect(transferSipParticipantMock).toHaveBeenLastCalledWith(
        "room",
        "caller",
        "tel:+16184220360",
        expect.objectContaining({
          headers: expect.objectContaining({
            "X-Acuity-Handoff-Target": "tel:+16184220360",
            "X-Acuity-Office-Key": officeKey,
            "X-Acuity-Trunk-Phone": officePhone,
          }),
        }),
      );
    }

    expect(transferSipParticipantMock).toHaveBeenCalledTimes(2);
  });

  it("attaches verified patient identity to booking requests", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({ status: "booked", appointmentId: 12345 }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { ctx } = createToolContext();
    seedLastAvailabilitySlot(ctx.session.userData as CallState);

    await book_appt.execute(
      {
        slotId: "A",
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
      dob: "01/01/1980",
      profileId: 2,
      startDatetime: "2026-04-28T09:00",
    });
  });

  it("stores booking-token slots and hides raw scheduler IDs from the model", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({
        status: "success",
        outcome: "availability_found",
        slots: [
          {
            provider: "Dr. Austin Bach (Overflow)",
            time: "9:00 AM",
            datetime: "2026-04-28T09:00",
            columnId: 1598,
            profileId: 620,
            duration: 15,
            bookingToken: "signed-token",
          },
        ],
      }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, state } = createToolContext();

    const result = await get_availability.execute(
      { date: "2026-04-28" },
      { ctx, toolCallId: "test-availability" },
    );

    expect(result).toMatchObject({
      slots: [
        {
          slotId: "A",
          provider: "Dr. Bach",
          time: "9:00 AM",
          date: "2026-04-28",
        },
      ],
    });
    expect(
      (result as { slots: Array<Record<string, unknown>> }).slots[0],
    ).not.toHaveProperty("columnId");
    expect(state.lastAvailabilitySlots[0]).toMatchObject({
      slotId: "A",
      bookingToken: "signed-token",
      columnId: 1598,
      profileId: 620,
      duration: 15,
    });
  });

  it("books selected slots with bookingToken instead of raw scheduler IDs", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({ status: "booked", appointmentId: 12345 }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, state } = createToolContext();
    seedLastAvailabilitySlot(state, { bookingToken: "signed-token" });

    await book_appt.execute(
      {
        slotId: "A",
        appointmentTypeId: 1007,
      },
      { ctx, toolCallId: "test-book" },
    );

    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(requestBody).toMatchObject({
      bookingToken: "signed-token",
      appointmentTypeId: 1007,
      patientId: "patient-1",
      patientName: "Jane Doe",
      dob: "01/01/1980",
      routing: "all_three",
    });
    expect(requestBody).not.toHaveProperty("columnId");
    expect(requestBody).not.toHaveProperty("profileId");
    expect(state.lastAvailabilitySlots).toEqual([]);
  });

  it("clears cached slots when a booking token is rejected", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({
        status: "error",
        outcome: "invalid_booking_token",
        message: "Invalid or expired booking token.",
      }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, state } = createToolContext();
    seedLastAvailabilitySlot(state, { bookingToken: "expired-token" });

    const result = await book_appt.execute(
      {
        slotId: "A",
        appointmentTypeId: 1007,
      },
      { ctx, toolCallId: "test-book" },
    );

    expect(result).toMatchObject({
      status: "error",
      outcome: "invalid_booking_token",
    });
    expect(state.lastAvailabilitySlots).toEqual([]);
    expect(state.lastAvailabilityRouting).toBeNull();
  });

  it("clears cached availability when switching the active scheduling office", async () => {
    const { ctx, state } = createToolContext();
    state.officeKey = "crystal-river";
    state.amdOfficePhone = "+13523202007";
    seedLastAvailabilitySlot(state);

    await route_to_spring_hill.execute({}, { ctx, toolCallId: "test-route" });

    expect(state.officeKey).toBe("spring-hill");
    expect(state.lastAvailabilitySlots).toEqual([]);
    expect(state.lastAvailabilityRouting).toBeNull();
  });

  it("forwards stored DOB to age-sensitive middleware requests", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({ status: "ok" }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { ctx } = createToolContext();

    await get_availability.execute(
      { date: "2026-04-28" },
      { ctx, toolCallId: "test-availability" },
    );
    seedLastAvailabilitySlot(ctx.session.userData as CallState);
    await book_appt.execute(
      {
        slotId: "A",
        appointmentTypeId: 1007,
      },
      { ctx, toolCallId: "test-book" },
    );
    await update_insurance.execute(
      {
        insurance: "Aetna",
        subscriberName: "Jane Doe",
        subscriberNum: "ABC123",
      },
      { ctx, toolCallId: "test-update" },
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      date: "2026-04-28",
      dob: "01/01/1980",
      routing: "all_three",
    });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({
      patientId: "patient-1",
      dob: "01/01/1980",
      routing: "all_three",
    });
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toMatchObject({
      patientId: "patient-1",
      dob: "01/01/1980",
      insurance: "Aetna",
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
    expect(state.flowGuardObservations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolName: "get_availability",
          allowed: false,
          reason: "routine_vision_crystal_river_requires_route_to_spring_hill",
          mode: "report_only",
        }),
      ]),
    );

    seedLastAvailabilitySlot(state, {
      columnId: 1600,
      profileId: 1983,
      datetime: "2026-04-28T10:00",
      duration: 45,
      routing: "optical_only",
    });

    await book_appt.execute(
      {
        slotId: "A",
        appointmentTypeId: 1010,
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

  it("keeps routine vision scheduling local for Hollywood and Sweetwater", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({ status: "ok" }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const cases = [
      ["hollywood", HOLLYWOOD_OFFICE_PHONE],
      ["sweetwater", SWEETWATER_OFFICE_PHONE],
    ] as const;

    for (const [officeKey, officePhone] of cases) {
      const { ctx, state } = createToolContext();
      state.officeKey = officeKey;
      state.amdOfficePhone = officePhone;
      state.trunkPhone = officePhone;
      state.checkedInsurancePlan = null;
      state.checkedInsuranceCoverageType = null;

      const insuranceResult = await check_insurance.execute(
        { plan: "VSP", coverageType: "routine_vision" },
        { ctx, toolCallId: `test-insurance-${officeKey}` },
      );

      expect(insuranceResult).toMatchObject({
        status: "accepted",
        canonicalPlan: "VSP",
      });

      await get_availability.execute(
        { date: "2026-04-28" },
        { ctx, toolCallId: `test-availability-${officeKey}` },
      );

      expect(state.officeKey).toBe(officeKey);
      expect(state.amdOfficePhone).toBe(officePhone);
      expect(state.lastAvailabilityRouting).toBe("optical_only");
    }

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      date: "2026-04-28",
      dob: "01/01/1980",
      office: HOLLYWOOD_OFFICE_PHONE,
      routing: "optical_only",
    });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({
      date: "2026-04-28",
      dob: "01/01/1980",
      office: SWEETWATER_OFFICE_PHONE,
      routing: "optical_only",
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

    expect(state.flow).toMatchObject({
      activeFlow: "routing",
      step: "route_office",
      visitType: "routine_vision",
      coverageType: "routine_vision",
      routing: "optical_only",
    });

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
    expect(state.flow).toMatchObject({
      officeKey: "spring-hill",
      patientStatus: "verified",
      visitType: "routine_vision",
      coverageType: "routine_vision",
      routing: "optical_only",
    });
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
    expect(state.flowGuardObservations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolName: "add_patient",
          allowed: true,
          reason: "allowed",
          mode: "report_only",
        }),
      ]),
    );
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
              slotId: "A",
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
    expect(state.flow).toMatchObject({
      activeFlow: "insurance",
      step: "check_insurance",
      officeKey: "crystal-river",
    });
    expect(state.flowGuardObservations).toEqual([
      expect.objectContaining({
        toolName: "check_insurance",
        allowed: false,
        reason: "visit_type_required_before_insurance",
        mode: "report_only",
      }),
    ]);
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
    expect(state.flow).toMatchObject({
      officeKey: "spring-hill",
      activeFlow: "scheduling",
      patientStatus: "matched",
      step: "verify_patient",
    });
  });
});

function createToolContext() {
  const speechHandle = { allowInterruptions: true };
  const state: CallState = {
    flow: createInitialFlowState({
      officeKey: "spring-hill",
      patientId: "patient-1",
      routing: "all_three",
      coverageType: "medical",
    }),
    flowGuardObservations: [],
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
    lastAvailabilitySlots: [],
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

function seedLastAvailabilitySlot(
  state: CallState,
  overrides: Partial<CallState["lastAvailabilitySlots"][number]> = {},
) {
  const routing = overrides.routing ?? "all_three";
  state.lastAvailabilityRouting = routing;
  state.lastAvailabilitySlots = [
    {
      slotId: overrides.slotId ?? "A",
      spoken: overrides.spoken ?? "2026-04-28 9:00 AM with Dr. Licht",
      provider: overrides.provider ?? "Dr. Licht",
      date: overrides.date ?? "2026-04-28",
      time: overrides.time ?? "9:00 AM",
      datetime: overrides.datetime ?? "2026-04-28T09:00",
      columnId: overrides.columnId ?? 1,
      profileId: overrides.profileId ?? 2,
      duration: overrides.duration ?? 15,
      routing,
      ...(overrides.bookingToken
        ? { bookingToken: overrides.bookingToken }
        : {}),
    },
  ];
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
