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
  confirm_appt,
  get_availability,
  lookup_knowledge,
  makeCurrentSpeechUninterruptible,
  record_turn_understanding,
  route_to_spring_hill,
  transfer_call,
  update_insurance,
  verify_patient,
  type CallState,
} from "../tools.js";
import {
  createPatientContext,
  createPendingBookingAction,
  createPendingSideEffectAction,
  createInitialFlowState,
  hashToolArgs,
  recordAvailabilityCachedSlots,
  recordAvailabilitySearch,
  resumePatientTask,
  startPatientTask,
} from "../flow/index.js";
import { HOLLYWOOD_OFFICE_PHONE, SWEETWATER_OFFICE_PHONE } from "../offices.js";
import { buildToolsForState } from "../tooling/tool-registry.js";

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

  it("requires main-agent turn understanding before guarded tools on a new user turn", async () => {
    const { ctx, state } = createToolContext();
    state.latestUserTranscript = "I need to move my appointment next week";
    state.turnUnderstandingAppliedForTranscript = null;

    const appointmentLookupBlocked = await confirm_appt.execute(
      {},
      { ctx, toolCallId: "test-confirm-appt" },
    );
    expect(appointmentLookupBlocked).toMatchObject({
      outcome: "not_allowed",
      facts: {
        reason: "turn_understanding_required",
        toolName: "confirm_appt",
      },
    });

    const faqBlocked = await lookup_knowledge.execute(
      { question: "office hours" },
      { ctx, toolCallId: "test-lookup" },
    );
    expect(faqBlocked).toMatchObject({
      outcome: "not_allowed",
      facts: {
        reason: "turn_understanding_required",
        toolName: "lookup_knowledge",
      },
    });

    const blocked = await verify_patient.execute(
      {
        firstName: "Jane",
        lastName: "Doe",
        dob: "01/01/1980",
      },
      { ctx, toolCallId: "test-verify" },
    );

    expect(blocked).toMatchObject({
      outcome: "not_allowed",
      facts: {
        reason: "turn_understanding_required",
        toolName: "verify_patient",
      },
    });

    const recorded = await record_turn_understanding.execute(
      {
        goal: "manage_existing_appointment",
        appointmentAction: "reschedule",
        patient: {
          patientMentioned: "caller",
          relationshipToCaller: "self",
        },
        scheduling: {
          preferredWindow: "next week",
        },
        interruption: "none",
        confidence: 0.9,
        evidence: ["move my appointment", "next week"],
      },
      { ctx, toolCallId: "test-understanding" },
    );

    expect(recorded).toMatchObject({
      status: "recorded",
      goal: "manage_existing_appointment",
      appointmentAction: "reschedule",
      activeIntent: "existing_appointment_reschedule",
    });
    expect(state.turnUnderstandingAppliedForTranscript).toBe(
      "I need to move my appointment next week",
    );
    expect(state.flow.schedulingGoal).toMatchObject({
      appointmentAction: "reschedule",
      preferredWindow: "next week",
    });
  });

  it("blocks appointment lookup for a preloaded patient until identity is confirmed", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { ctx, state } = createToolContext();
    state.flow.patientStatus = "matched";
    state.flow.patients[state.flow.activePatientRef!].status = "matched";

    const result = await confirm_appt.execute(
      {},
      { ctx, toolCallId: "test-confirm-appt-unverified" },
    );

    expect(result).toMatchObject({
      outcome: "not_allowed",
      nextStep: "verify_patient",
      facts: { reason: "appointment_lookup_requires_verified_patient" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not require turn understanding when the flow harness is disabled", async () => {
    const { ctx, state } = createToolContext();
    state.flowHarnessEnabled = false;
    state.latestUserTranscript = "what are your office hours?";
    state.turnUnderstandingAppliedForTranscript = null;

    const result = await lookup_knowledge.execute(
      { question: "office hours" },
      { ctx, toolCallId: "test-lookup-disabled-harness" },
    );

    expect(result).not.toMatchObject({
      outcome: "not_allowed",
      facts: {
        reason: "turn_understanding_required",
      },
    });
    expect(String(result)).toContain("Abita Eye Group");
  });

  it("returns targeted knowledge sections instead of the full office markdown", async () => {
    const { ctx, state } = createToolContext();
    state.flowHarnessEnabled = false;

    const result = await lookup_knowledge.execute(
      { question: "what are your office hours?" },
      { ctx, toolCallId: "test-targeted-knowledge" },
    );

    const text = String(result);
    expect(text).toContain("Knowledge source: KNOWLEDGE_SPRINGHILL.md");
    expect(text).toContain("Hours:");
    expect(text).not.toContain("## Urgency Screening");
    expect(text).not.toContain("## What to Bring");
  });

  it("keeps scope facts for contact lens knowledge questions", async () => {
    const { ctx, state } = createToolContext();
    state.flowHarnessEnabled = false;

    const result = await lookup_knowledge.execute(
      { question: "do you do contact lens prescriptions?" },
      { ctx, toolCallId: "test-contact-lens-knowledge" },
    );

    const text = String(result);
    expect(text).toContain("## Scope of Services");
    expect(text).toContain("contact lens prescriptions");
    expect(text).toContain("## Optical / Glasses");
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
        run: (ctx: ToolContext) => {
          const params = {
            firstName: "Jane",
            lastName: "Doe",
            dob: "01/01/1980",
            street: "123 Main St",
            aptSuite: "",
            city: "Spring Hill",
            state: "FL",
            zip: "34609",
            sex: "female" as const,
            insurance: "Aetna",
            subscriberName: "Jane Doe",
            subscriberNum: "ABC123",
          };
          seedPendingSideEffectAction(
            ctx.session.userData as CallState,
            "add_patient",
            params,
          );
          return add_patient.execute(params, { ctx, toolCallId: "test-add" });
        },
      },
      {
        name: "update_insurance",
        run: (ctx: ToolContext) => {
          const params = {
            insurance: "Aetna",
            subscriberName: "Jane Doe",
            subscriberNum: "ABC123",
          };
          seedPendingSideEffectAction(
            ctx.session.userData as CallState,
            "update_insurance",
            params,
          );
          return update_insurance.execute(params, {
            ctx,
            toolCallId: "test-update",
          });
        },
      },
      {
        name: "cancel_appt",
        run: (ctx: ToolContext) => {
          seedPendingSideEffectAction(
            ctx.session.userData as CallState,
            "cancel_appt",
            { appointmentId: 12345 },
          );
          return cancel_appt.execute(
            { appointmentId: 12345 },
            { ctx, toolCallId: "test-cancel" },
          );
        },
      },
      {
        name: "add_patient_note",
        run: (ctx: ToolContext) => {
          seedSuccessfulBooking(ctx.session.userData as CallState);
          return add_patient_note.execute(
            {
              appointmentReason: "blurry vision",
              referringDoctor: "none",
            },
            { ctx, toolCallId: "test-note" },
          );
        },
      },
      {
        name: "book_appt",
        run: (ctx: ToolContext) => {
          const state = ctx.session.userData as CallState;
          seedLastAvailabilitySlot(state);
          seedPendingBookingAction(state);
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
    seedPendingSideEffectAction(state, "transfer_call");

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
    const { ctx, state } = createToolContext();
    seedPendingSideEffectAction(state, "transfer_call");

    const result = await transfer_call.execute(
      {},
      { ctx, toolCallId: "test-transfer" },
    );

    expect(result).toMatchObject({
      outcome: "success",
      nextStep: "handoff",
      speak: "Transfer initiated successfully.",
    });
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

  it("allows a transfer retry after the SIP transfer call fails", async () => {
    transferSipParticipantMock
      .mockRejectedValueOnce(new Error("sip transfer failed"))
      .mockResolvedValueOnce(undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const { ctx, state } = createToolContext();
    seedPendingSideEffectAction(state, "transfer_call");

    const first = await transfer_call.execute(
      {},
      { ctx, toolCallId: "test-transfer-first" },
    );
    expect(state.transferred).toBe(false);
    seedPendingSideEffectAction(state, "transfer_call");
    const second = await transfer_call.execute(
      {},
      { ctx, toolCallId: "test-transfer-second" },
    );

    expect(first).toMatchObject({
      outcome: "error",
      nextStep: "handoff",
      speak: "Could not transfer the call. Please try again.",
      facts: { reason: "transfer_failed" },
    });
    expect(second).toMatchObject({
      outcome: "success",
      nextStep: "handoff",
      speak: "Transfer initiated successfully.",
    });
    expect(state.transferred).toBe(true);
    expect(transferSipParticipantMock).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledOnce();
  });

  it("keeps parallel transfer calls to one SIP transfer", async () => {
    let resolveTransfer!: () => void;
    transferSipParticipantMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveTransfer = resolve;
        }),
    );
    const { ctx, state } = createToolContext();

    const first = transfer_call.execute(
      {},
      { ctx, toolCallId: "test-transfer-first" },
    );
    expect(state.transferInFlight).toBe(true);

    const duplicate = await transfer_call.execute(
      {},
      { ctx, toolCallId: "test-transfer-duplicate" },
    );

    expect(duplicate).toMatchObject({
      outcome: "success",
      facts: { reason: "transfer_already_started" },
    });
    expect(transferSipParticipantMock).toHaveBeenCalledOnce();

    resolveTransfer();
    await expect(first).resolves.toMatchObject({
      outcome: "success",
      nextStep: "handoff",
    });
    expect(state.transferred).toBe(true);
    expect(state.transferInFlight).toBe(false);
  });

  it("returns a safe no-op if transfer is called after transfer already started", async () => {
    transferSipParticipantMock.mockResolvedValue(undefined);
    const { ctx, state } = createToolContext();
    state.transferred = true;

    const result = await transfer_call.execute(
      {},
      { ctx, toolCallId: "test-transfer-duplicate" },
    );

    expect(result).toMatchObject({
      outcome: "success",
      nextStep: "answer",
      facts: { reason: "transfer_already_started" },
    });
    expect(transferSipParticipantMock).not.toHaveBeenCalled();
  });

  it("keeps Crystal River transfers on the existing phone-number handoff", async () => {
    transferSipParticipantMock.mockResolvedValue(undefined);
    const { ctx, state } = createToolContext();
    state.trunkPhone = "+13523202007";
    state.officeKey = "spring-hill";
    state.amdOfficePhone = "+17275919997";
    state.patientId = "spring-hill-patient";
    seedPendingSideEffectAction(state, "transfer_call");

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
      seedPendingSideEffectAction(state, "transfer_call");

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
    const state = ctx.session.userData as CallState;
    seedLastAvailabilitySlot(state);
    seedPendingBookingAction(state);

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
    expect(result).not.toHaveProperty("middlewareResult");
    expect(state.lastAvailabilitySlots[0]).toMatchObject({
      slotId: "A",
      bookingToken: "signed-token",
      columnId: 1598,
      profileId: 620,
      duration: 15,
    });
    expect(state.flow.step).toBe("confirm_booking");
  });

  it("returns cached availability instead of repeating an identical satisfied search", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, state } = createToolContext();
    state.flow.visitType = "medical";
    state.flow.routing = "all_three";
    seedLastAvailabilitySlot(state);
    recordAvailabilitySearch(state.flow, {
      officeKey: "spring-hill",
      visitType: "medical",
      coverageType: "medical",
      routing: "all_three",
      date: "2026-04-28",
    });
    recordAvailabilityCachedSlots(state.flow, [{ slotId: "A" }]);

    const result = await get_availability.execute(
      { date: "2026-04-28", routing: "all_three" },
      { ctx, toolCallId: "test-duplicate-availability" },
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      outcome: "not_allowed",
      nextStep: "confirm_booking",
      facts: {
        reason: "availability_duplicate_search_signature",
        cachedSlots: [{ slotId: "A" }],
      },
    });
    expect(state.flowGuardObservations).toEqual([
      expect.objectContaining({
        toolName: "get_availability",
        allowed: false,
        reason: "availability_duplicate_search_signature",
      }),
    ]);
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
    seedPendingBookingAction(state);

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

  it("blocks booking before a confirmed pending booking action exists", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, state, speechHandle } = createToolContext();
    seedLastAvailabilitySlot(state);

    const result = await book_appt.execute(
      {
        slotId: "A",
        appointmentTypeId: 1007,
      },
      { ctx, toolCallId: "test-book-policy" },
    );

    expect(speechHandle.allowInterruptions).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      outcome: "not_allowed",
      nextStep: "confirm_booking",
      facts: { reason: "booking_requires_pending_action" },
    });
  });

  it("uses legacy direct booking when the flow harness is disabled", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({ status: "booked", appointmentId: 12345 }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, state } = createToolContext();
    state.flowHarnessEnabled = false;
    seedLastAvailabilitySlot(state, { bookingToken: "signed-token" });

    const result = await book_appt.execute(
      {
        slotId: "A",
        appointmentTypeId: 1007,
      },
      { ctx, toolCallId: "test-book-disabled-harness" },
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ status: "booked", appointmentId: 12345 });
    expect(state.flow.pendingActions).toContainEqual(
      expect.objectContaining({
        type: "book_appt",
        consumed: true,
      }),
    );
  });

  it("clears legacy availability for successful non-booked status variants", async () => {
    const successResults = [
      { status: "ok" },
      { status: "success", appointmentId: 12345 },
    ];

    for (const [index, apiResult] of successResults.entries()) {
      const fetchMock = vi.fn().mockImplementation(async () => ({
        ok: true,
        json: async () => apiResult,
        text: async () => "",
      }));
      vi.stubGlobal("fetch", fetchMock);

      const { ctx, state } = createToolContext();
      state.flowHarnessEnabled = false;
      seedLastAvailabilitySlot(state, {
        bookingToken: `signed-token-${index}`,
      });

      const result = await book_appt.execute(
        {
          slotId: "A",
          appointmentTypeId: 1007,
        },
        { ctx, toolCallId: `test-book-legacy-success-${index}` },
      );
      const duplicate = await book_appt.execute(
        {
          slotId: "A",
          appointmentTypeId: 1007,
        },
        { ctx, toolCallId: `test-book-legacy-duplicate-${index}` },
      );

      expect(result).toMatchObject(apiResult);
      expect(duplicate).toMatchObject({
        outcome: "not_allowed",
        facts: { reason: "booking_requires_recent_availability" },
      });
      expect(state.lastAvailabilitySlots).toEqual([]);
      expect(fetchMock).toHaveBeenCalledOnce();
      vi.unstubAllGlobals();
    }
  });

  it("blocks booking when the pending booking action is not confirmed", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, state } = createToolContext();
    seedLastAvailabilitySlot(state);
    seedPendingBookingAction(state, { confirmed: false });

    const result = await book_appt.execute(
      {
        slotId: "A",
        appointmentTypeId: 1007,
      },
      { ctx, toolCallId: "test-book-unconfirmed" },
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      outcome: "not_allowed",
      nextStep: "confirm_booking",
      facts: { reason: "booking_confirmation_required" },
    });
  });

  it("creates a pending booking action inside book_appt after state confirmation", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({ status: "booked", appointmentId: 12345 }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, state } = createToolContext();
    seedLastAvailabilitySlot(state);
    markBookingConfirmedInState(state, "A");

    await book_appt.execute(
      {
        slotId: "A",
        appointmentTypeId: 1007,
      },
      { ctx, toolCallId: "test-book" },
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(state.flow.pendingActions[0]).toMatchObject({
      type: "book_appt",
      confirmed: true,
      consumed: true,
      confirmationTurnId: "test-book",
    });
  });

  it("returns a safe no-op for duplicate booking after success consumed the action", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({ status: "booked", appointmentId: 12345 }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, state } = createToolContext();
    seedLastAvailabilitySlot(state);
    markBookingConfirmedInState(state, "A");
    await book_appt.execute(
      {
        slotId: "A",
        appointmentTypeId: 1007,
      },
      { ctx, toolCallId: "test-book" },
    );

    const duplicate = await book_appt.execute(
      {
        slotId: "A",
        appointmentTypeId: 1007,
      },
      { ctx, toolCallId: "test-book-duplicate" },
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(duplicate).toMatchObject({
      outcome: "success",
      nextStep: "answer",
      facts: {
        reason: "booking_action_already_consumed",
        pendingActionId: "pending_book_1",
      },
    });
  });

  it("uses the resumed active patient when booking after a patient-task switch", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({ status: "booked", appointmentId: 23456 }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, state } = createToolContext();
    state.flow.patients["patient:child"] = createPatientContext({
      ref: "patient:child",
      status: "verified",
      patientId: "patient-2",
      patientName: "Emily Doe",
      dob: "02/03/2012",
    });
    const callerTask = startPatientTask(state.flow, {
      kind: "schedule",
      step: "get_availability",
      patientRef: "caller",
      createdAt: 100,
    });
    const childTask = startPatientTask(state.flow, {
      kind: "schedule",
      step: "confirm_booking",
      patientRef: "patient:child",
      createdAt: 200,
    });
    resumePatientTask(state.flow, { patientRef: "caller" });
    expect(state.flow.currentTask?.id).toBe(callerTask.id);
    resumePatientTask(state.flow, { patientRef: "patient:child" });
    expect(state.flow.currentTask?.id).toBe(childTask.id);

    seedLastAvailabilitySlot(state);
    recordAvailabilitySearch(state.flow, {
      officeKey: "spring-hill",
      visitType: "medical",
      routing: "all_three",
      date: "2026-04-28",
    });
    recordAvailabilityCachedSlots(state.flow, [{ slotId: "A" }]);
    seedPendingBookingAction(state);

    await book_appt.execute(
      {
        slotId: "A",
        appointmentTypeId: 1007,
      },
      { ctx, toolCallId: "test-book-child" },
    );

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      patientId: "patient-2",
      patientName: "Emily Doe",
      dob: "02/03/2012",
    });
    expect(state.patientId).toBe("patient-2");
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
    seedPendingBookingAction(state);

    const result = await book_appt.execute(
      {
        slotId: "A",
        appointmentTypeId: 1007,
      },
      { ctx, toolCallId: "test-book" },
    );

    expect(result).toMatchObject({
      outcome: "error",
      nextStep: "get_availability",
      facts: {
        reason: "slot_unavailable",
        slotId: "A",
      },
    });
    expect(state.lastAvailabilitySlots).toEqual([]);
    expect(state.lastAvailabilityRouting).toBeNull();
  });

  it("rejects an unavailable booked slot and keeps cached alternatives", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({
        status: "error",
        outcome: "slot_unavailable",
        message: "Slot is no longer available.",
      }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, state } = createToolContext();
    state.lastAvailabilityRouting = "all_three";
    state.lastAvailabilitySlots = [
      {
        slotId: "A",
        spoken: "2026-04-28 9:00 AM with Dr. Licht",
        provider: "Dr. Licht",
        date: "2026-04-28",
        time: "9:00 AM",
        datetime: "2026-04-28T09:00",
        columnId: 1,
        profileId: 2,
        duration: 15,
        routing: "all_three",
      },
      {
        slotId: "B",
        spoken: "2026-04-28 10:00 AM with Dr. Bach",
        provider: "Dr. Bach",
        date: "2026-04-28",
        time: "10:00 AM",
        datetime: "2026-04-28T10:00",
        columnId: 3,
        profileId: 4,
        duration: 15,
        routing: "all_three",
      },
    ];
    recordAvailabilitySearch(state.flow, {
      officeKey: "spring-hill",
      visitType: "medical",
      routing: "all_three",
      date: "2026-04-28",
    });
    recordAvailabilityCachedSlots(state.flow, [
      { slotId: "A" },
      { slotId: "B" },
    ]);
    seedPendingBookingAction(state);

    const result = await book_appt.execute(
      {
        slotId: "A",
        appointmentTypeId: 1007,
      },
      { ctx, toolCallId: "test-book" },
    );

    expect(result).toMatchObject({
      outcome: "error",
      nextStep: "confirm_booking",
      facts: {
        reason: "slot_unavailable",
        slotId: "A",
        cachedSlots: [expect.objectContaining({ slotId: "B" })],
      },
    });
    expect(state.lastAvailabilitySlots).toEqual([
      expect.objectContaining({ slotId: "B" }),
    ]);
    expect(state.flow.pendingActions[0]).toMatchObject({
      type: "book_appt",
      slotInvalidated: true,
      lastBookingErrorClass: "slot_unavailable",
    });
  });

  it("invalidates the booking lane on invalid appointment type errors", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({
        status: "error",
        outcome: "invalid_appointment_type",
        message: "Invalid appointment type for this slot.",
      }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, state } = createToolContext();
    seedLastAvailabilitySlot(state);
    recordAvailabilitySearch(state.flow, {
      officeKey: "spring-hill",
      visitType: "medical",
      routing: "all_three",
      date: "2026-04-28",
    });
    recordAvailabilityCachedSlots(state.flow, [{ slotId: "A" }]);
    seedPendingBookingAction(state);

    const result = await book_appt.execute(
      {
        slotId: "A",
        appointmentTypeId: 1007,
      },
      { ctx, toolCallId: "test-book" },
    );

    expect(result).toMatchObject({
      outcome: "error",
      nextStep: "get_availability",
      facts: {
        reason: "invalid_appointment_type",
        slotId: "A",
      },
    });
    expect(state.lastAvailabilitySlots).toEqual([]);
    expect(state.flow.availabilitySearches[0]).toMatchObject({
      status: "invalidated",
      lastInvalidationReason: "appointment_type_invalid",
    });
  });

  it("clears cached availability when switching the active scheduling office", async () => {
    const { ctx, state } = createToolContext();
    state.officeKey = "crystal-river";
    state.amdOfficePhone = "+13523202007";
    seedLastAvailabilitySlot(state);
    seedPendingSideEffectAction(state, "route_to_spring_hill");

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
    const state = ctx.session.userData as CallState;
    seedLastAvailabilitySlot(state);
    seedPendingBookingAction(state);
    await book_appt.execute(
      {
        slotId: "A",
        appointmentTypeId: 1007,
      },
      { ctx, toolCallId: "test-book" },
    );
    const updateParams = {
      insurance: "Aetna",
      subscriberName: "Jane Doe",
      subscriberNum: "ABC123",
    };
    seedPendingSideEffectAction(state, "update_insurance", updateParams);
    await update_insurance.execute(updateParams, {
      ctx,
      toolCallId: "test-update",
    });

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
    state.flow.patients[state.flow.activePatientRef!].patientId = "17603880";
    seedSuccessfulBooking(state);
    state.flow.schedulingGoal = {
      status: "booked",
      patientRef: state.flow.activePatientRef,
      appointmentAction: "schedule",
      visitReason: "blurry vision",
      noteDraft: {
        appointmentReason: "blurry vision",
        referringDoctor: "Dr. Smith",
      },
      updatedAt: Date.now(),
    };

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

  it("blocks ungrounded patient note details when the flow harness is enabled", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, state } = createToolContext();
    state.patientId = "17603880";
    state.flow.patients[state.flow.activePatientRef!].patientId = "17603880";
    seedSuccessfulBooking(state);
    state.flow.schedulingGoal = {
      status: "booked",
      patientRef: state.flow.activePatientRef,
      appointmentAction: "schedule",
      visitReason: "itchy eye",
      noteDraft: {
        appointmentReason: "itchy eye",
      },
      updatedAt: Date.now(),
    };

    const result = await add_patient_note.execute(
      {
        appointmentReason: "itchy eye",
        referringDoctor: "Dr. Tickle My Cock",
      },
      { ctx, toolCallId: "test-ungrounded-note" },
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      outcome: "not_allowed",
      nextStep: "collect_visit_reason",
      facts: { reason: "note_requires_grounded_details" },
    });
  });

  it("blocks patient notes until a booking succeeded for the active patient", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, state, speechHandle } = createToolContext();
    state.patientId = "17603880";
    state.flow.patients[state.flow.activePatientRef!].patientId = "17603880";

    const result = await add_patient_note.execute(
      {
        appointmentReason: "blurry vision",
        referringDoctor: "Dr. Smith",
      },
      { ctx, toolCallId: "test-note-before-booking" },
    );

    expect(speechHandle.allowInterruptions).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      outcome: "not_allowed",
      nextStep: "book",
      facts: { reason: "note_requires_successful_booking" },
    });
  });

  it("allows notes after a successful legacy booking when the flow harness is disabled", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => ({
        ok: true,
        json: async () => ({ status: "booked", appointmentId: 12345 }),
        text: async () => "",
      }))
      .mockImplementationOnce(async () => ({
        ok: true,
        json: async () => ({ status: "saved", noteId: "note-1" }),
        text: async () => "",
      }));
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, state } = createToolContext();
    state.flowHarnessEnabled = false;
    state.patientId = "17603880";
    state.flow.patients[state.flow.activePatientRef!].patientId = "17603880";
    seedLastAvailabilitySlot(state);

    await book_appt.execute(
      { slotId: "A", appointmentTypeId: 1007 },
      { ctx, toolCallId: "test-legacy-book" },
    );
    const noteResult = await add_patient_note.execute(
      {
        appointmentReason: "blurry vision",
        referringDoctor: "none",
      },
      { ctx, toolCallId: "test-note-after-legacy-booking" },
    );

    expect(noteResult).toMatchObject({
      outcome: "success",
      nextStep: "answer",
      facts: {
        result: { status: "saved", noteId: "note-1" },
      },
    });
    expect(state.flow.pendingActions).toContainEqual(
      expect.objectContaining({
        type: "book_appt",
        consumed: true,
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
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

    const insuranceResult = await check_insurance.execute(
      { plan: "VSP", coverageType: "routine_vision" },
      { ctx, toolCallId: "test-insurance" },
    );

    expect(insuranceResult).toMatchObject({
      outcome: "route_required",
      nextStep: "route_office",
      routeTool: "route_to_spring_hill",
    });
    await route_to_spring_hill.execute(
      {},
      { ctx, toolCallId: "test-route-spring-hill" },
    );

    await get_availability.execute(
      { date: "2026-04-28" },
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
    seedLastAvailabilitySlot(state, {
      columnId: 1600,
      profileId: 1983,
      datetime: "2026-04-28T10:00",
      duration: 45,
      routing: "optical_only",
    });
    seedPendingBookingAction(state, { appointmentTypeId: 1010 });

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
    state.flow.patientStatus = "unknown";
    state.flow.patients.caller.status = "unknown";
    state.flow.patients.caller.patientId = undefined;

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

  it("keeps same-patient verification from invalidating current availability", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({
        patientId: "patient-1",
        name: "Jane Doe",
        dob: "01/01/1980",
        insuranceCarrier: "Aetna",
        routing: "all_three",
        allowedProviders: [],
      }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, state } = createToolContext();
    seedLastAvailabilitySlot(state);
    recordAvailabilitySearch(state.flow, {
      officeKey: "spring-hill",
      visitType: "medical",
      routing: "all_three",
      date: "2026-04-28",
    });
    recordAvailabilityCachedSlots(state.flow, [{ slotId: "A" }]);
    seedPendingBookingAction(state);

    await verify_patient.execute(
      { firstName: "Jane", lastName: "Doe", dob: "01/01/1980" },
      { ctx, toolCallId: "test-verify" },
    );

    expect(state.flow.activePatientRef).toBe("caller");
    expect(state.lastAvailabilitySlots).toHaveLength(1);
    expect(state.flow.availabilitySearches[0]).toMatchObject({
      status: "satisfied",
    });
    expect(state.flow.pendingActions[0]).toMatchObject({
      type: "book_appt",
      slotInvalidated: false,
    });
    expect(state.flow.pendingActions[0].invalidated).not.toBe(true);
  });

  it("switches patients on spelled correction and invalidates stale downstream actions", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({
        patientId: "patient-2",
        name: "Emily Danehe",
        dob: "02/03/2012",
        insuranceCarrier: "Aetna",
        routing: "all_three",
        allowedProviders: [],
      }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, state } = createToolContext();
    seedLastAvailabilitySlot(state);
    recordAvailabilitySearch(state.flow, {
      officeKey: "spring-hill",
      visitType: "medical",
      routing: "all_three",
      date: "2026-04-28",
    });
    recordAvailabilityCachedSlots(state.flow, [{ slotId: "A" }]);
    seedPendingBookingAction(state);
    seedPendingSideEffectAction(state, "update_insurance", {
      insurance: "Aetna",
      subscriberName: "Jane Doe",
      subscriberNum: "ABC123",
    });

    await verify_patient.execute(
      {
        firstName: "Emily",
        lastName: "Danehe",
        dob: "02/03/2012",
        nameSource: "caller_spelled",
      },
      { ctx, toolCallId: "test-verify" },
    );

    const verifyBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(verifyBody).toMatchObject({
      firstName: "Emily",
      lastName: "Danehe",
      dob: "02/03/2012",
      office: "+17275919997",
    });
    expect(verifyBody).not.toHaveProperty("nameSource");
    expect(state.patientId).toBe("patient-2");
    expect(state.patientName).toBe("Emily Danehe");
    expect(state.flow.activePatientRef).toMatch(/^candidate:/);
    expect(state.flow.patients.caller).toMatchObject({
      patientId: "patient-1",
    });
    expect(state.flow.patients[state.flow.activePatientRef!]).toMatchObject({
      patientId: "patient-2",
      status: "verified",
      firstName: {
        value: "Emily",
        source: "caller_spelled",
        confirmed: true,
      },
      lastName: {
        value: "Danehe",
        source: "caller_spelled",
        confirmed: true,
      },
    });
    expect(state.lastAvailabilitySlots).toEqual([]);
    expect(state.flow.availabilitySearches[0]).toMatchObject({
      status: "invalidated",
      lastInvalidationReason: "patient_changed",
    });
    expect(state.flow.pendingActions).toEqual([
      expect.objectContaining({
        type: "book_appt",
        invalidated: true,
        slotInvalidated: true,
        invalidationReason: "patient_changed",
      }),
      expect.objectContaining({
        type: "update_insurance",
        invalidated: true,
        invalidationReason: "patient_changed",
      }),
    ]);
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
    state.flow.patientStatus = "unknown";
    state.flow.patients.caller.status = "unknown";
    state.flow.patients.caller.patientId = undefined;
    state.flow.patients.caller.firstName = undefined;
    state.flow.patients.caller.lastName = undefined;
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

    const addPatientParams = {
      firstName: "Jane",
      lastName: "Doe",
      dob: "01/01/1980",
      street: "123 Main St",
      aptSuite: "",
      city: "Spring Hill",
      state: "FL",
      zip: "34609",
      sex: "female" as const,
      insurance: "Lincoln Finacial",
      subscriberName: "Jane Doe",
      subscriberNum: "ABC123",
    };
    seedPendingSideEffectAction(state, "add_patient", addPatientParams);
    await add_patient.execute(addPatientParams, {
      ctx,
      toolCallId: "test-add",
    });

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

  it("returns the raw middleware payload when add_patient succeeds", async () => {
    const middlewareResult = {
      status: "created",
      patientId: "patient-2",
      name: "Doe, Jane",
      dob: "01/01/1980",
      phone: "+17275551212",
      insuranceCarrier: "VSP",
      insPlanId: null,
      respPartyId: null,
      routing: "optical_only",
      allowedProviders: [],
      routingAmbiguous: false,
      appointments: [],
      insuranceAdded: false,
      insuranceMessage: "Insurance was not attached by middleware",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => middlewareResult,
        text: async () => "",
      })),
    );

    const { ctx, state } = createToolContext();
    const params = {
      firstName: "Jane",
      lastName: "Doe",
      dob: "01/01/1980",
      street: "123 Main St",
      aptSuite: "",
      city: "Spring Hill",
      state: "FL",
      zip: "34609",
      sex: "female" as const,
      insurance: "VSP",
      subscriberName: "Jane Doe",
      subscriberNum: "ABC123",
    };
    seedPendingSideEffectAction(state, "add_patient", params);

    const result = await add_patient.execute(params, {
      ctx,
      toolCallId: "test-add-raw-result",
    });

    expect(result).toMatchObject({
      status: "created",
      insuranceAdded: false,
      insuranceMessage: "Insurance was not attached by middleware",
      outcome: "success",
      middlewareResult: {
        insuranceAdded: false,
        insuranceMessage: "Insurance was not attached by middleware",
      },
    });
  });

  it("blocks cancellation before the appointment is loaded into state", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, state, speechHandle } = createToolContext();
    state.flow.pendingConfirmation = undefined;

    const result = await cancel_appt.execute(
      { appointmentId: 12345 },
      { ctx, toolCallId: "test-cancel-policy" },
    );

    expect(speechHandle.allowInterruptions).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      outcome: "not_allowed",
      nextStep: "confirm_cancel",
      facts: { reason: "cancel_requires_loaded_appointment" },
    });
  });

  it("creates and consumes a pending cancellation action from the final tool call", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({ status: "cancelled" }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, state } = createToolContext();
    seedLoadedAppointment(state, 12345);

    const cancelResult = await cancel_appt.execute(
      { appointmentId: 12345 },
      { ctx, toolCallId: "test-cancel" },
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(cancelResult).toMatchObject({
      outcome: "success",
      nextStep: "answer",
      facts: { appointmentId: 12345 },
    });
    expect(state.flow.pendingActions[0]).toMatchObject({
      type: "cancel_appt",
      appointmentId: 12345,
      confirmed: true,
      consumed: true,
    });
    expect(state.appointments).toEqual([]);
    expect(
      state.flow.patients[state.flow.activePatientRef!].appointments,
    ).toEqual([]);

    const duplicate = await cancel_appt.execute(
      { appointmentId: 12345 },
      { ctx, toolCallId: "test-cancel-duplicate" },
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(duplicate).toMatchObject({
      outcome: "success",
      nextStep: "answer",
      facts: {
        reason: "side_effect_action_already_consumed",
        toolName: "cancel_appt",
        pendingActionId: "pending_cancel_appt_1",
      },
    });
  });

  it("does not treat a not-found cancellation response as success", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({ status: "not_found" }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, state } = createToolContext();
    seedLoadedAppointment(state, 12345);

    const result = await cancel_appt.execute(
      { appointmentId: 12345 },
      { ctx, toolCallId: "test-cancel-not-found" },
    );

    expect(result).toMatchObject({
      outcome: "not_found",
      nextStep: "confirm_cancel",
      facts: {
        reason: "appointment_not_found",
        appointmentId: 12345,
      },
    });
    expect(state.appointments).toHaveLength(1);
    expect(state.flow.pendingActions[0]).toMatchObject({
      type: "cancel_appt",
      consumed: false,
    });
  });

  it("keeps conflicting raw middleware status nested when cancellation is normalized as success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          status: "error",
          message: "appointment already cancelled",
        }),
        text: async () => "",
      })),
    );

    const { ctx, state } = createToolContext();
    seedLoadedAppointment(state, 12345);

    const result = await cancel_appt.execute(
      { appointmentId: 12345 },
      { ctx, toolCallId: "test-cancel-already-cancelled" },
    );

    expect(result).toMatchObject({
      outcome: "success",
      facts: {
        reason: "appointment_already_cancelled",
        appointmentId: 12345,
      },
      middlewareResult: {
        status: "error",
        message: "appointment already cancelled",
      },
    });
    expect(result).not.toHaveProperty("status");
  });

  it("returns to a suspended scheduling task after successful cancellation", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({ status: "cancelled" }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, state } = createToolContext();
    const scheduleTask = startPatientTask(state.flow, {
      kind: "schedule",
      step: "get_availability",
      patientRef: "caller",
      createdAt: 100,
    });
    startPatientTask(state.flow, {
      kind: "appointment_management",
      step: "confirm_cancel",
      patientRef: "caller",
      returnTo: scheduleTask.id,
      createdAt: 200,
    });
    seedLoadedAppointment(state, 12345);

    const result = await cancel_appt.execute(
      { appointmentId: 12345 },
      { ctx, toolCallId: "test-cancel" },
    );

    expect(result).toMatchObject({
      outcome: "success",
      nextStep: "get_availability",
      facts: {
        appointmentId: 12345,
        resumedTaskId: scheduleTask.id,
      },
    });
    expect(state.flow.currentTask?.id).toBe(scheduleTask.id);
    expect(state.flow.activeFlow).toBe("scheduling");
  });

  it("creates and consumes a pending transfer action from the final tool call", async () => {
    transferSipParticipantMock.mockResolvedValue(undefined);
    const { ctx, state, speechHandle } = createToolContext();

    const result = await transfer_call.execute(
      {},
      { ctx, toolCallId: "test-transfer-policy" },
    );

    expect(speechHandle.allowInterruptions).toBe(false);
    expect(transferSipParticipantMock).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      outcome: "success",
      nextStep: "handoff",
      speak: "Transfer initiated successfully.",
    });
    expect(state.flow.pendingActions[0]).toMatchObject({
      type: "transfer_call",
      confirmed: true,
      consumed: true,
    });
  });

  it("does not run side effects if the speech already became interrupted", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const mutationTools = [
      {
        name: "add_patient",
        run: (ctx: ToolContext) => {
          const params = {
            firstName: "Jane",
            lastName: "Doe",
            dob: "01/01/1980",
            street: "123 Main St",
            aptSuite: "",
            city: "Spring Hill",
            state: "FL",
            zip: "34609",
            sex: "female" as const,
            insurance: "Aetna",
            subscriberName: "Jane Doe",
            subscriberNum: "ABC123",
          };
          seedPendingSideEffectAction(
            ctx.session.userData as CallState,
            "add_patient",
            params,
          );
          return add_patient.execute(params, { ctx, toolCallId: "test-add" });
        },
      },
      {
        name: "update_insurance",
        run: (ctx: ToolContext) => {
          const params = {
            insurance: "Aetna",
            subscriberName: "Jane Doe",
            subscriberNum: "ABC123",
          };
          seedPendingSideEffectAction(
            ctx.session.userData as CallState,
            "update_insurance",
            params,
          );
          return update_insurance.execute(params, {
            ctx,
            toolCallId: "test-update",
          });
        },
      },
      {
        name: "cancel_appt",
        run: (ctx: ToolContext) => {
          seedPendingSideEffectAction(
            ctx.session.userData as CallState,
            "cancel_appt",
            { appointmentId: 12345 },
          );
          return cancel_appt.execute(
            { appointmentId: 12345 },
            { ctx, toolCallId: "test-cancel" },
          );
        },
      },
      {
        name: "add_patient_note",
        run: (ctx: ToolContext) => {
          seedSuccessfulBooking(ctx.session.userData as CallState);
          return add_patient_note.execute(
            {
              appointmentReason: "blurry vision",
              referringDoctor: "none",
            },
            { ctx, toolCallId: "test-note" },
          );
        },
      },
      {
        name: "book_appt",
        run: (ctx: ToolContext) => {
          const state = ctx.session.userData as CallState;
          seedLastAvailabilitySlot(state);
          seedPendingBookingAction(state);
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
      const { ctx } = createInterruptedToolContext();
      const result = await mutationTool.run(ctx);

      expectInterruptedOutcome(result, mutationTool.name);
    }

    const { ctx, state } = createInterruptedToolContext();
    seedPendingSideEffectAction(state, "transfer_call");
    const transferResult = await transfer_call.execute(
      {},
      { ctx, toolCallId: "test-transfer" },
    );

    expect(transferResult).toMatchObject({
      outcome: "not_allowed",
      nextStep: "handoff",
      facts: { reason: "speech_interrupted" },
    });
    expect(ctx.waitForPlayout).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it("does not store confirmed pending actions when speech is already interrupted", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const addParams = {
      firstName: "Jane",
      lastName: "Doe",
      dob: "01/01/1980",
      street: "123 Main St",
      aptSuite: "",
      city: "Spring Hill",
      state: "FL",
      zip: "34609",
      sex: "female" as const,
      insurance: "Aetna",
      subscriberName: "Jane Doe",
      subscriberNum: "ABC123",
    };
    const updateParams = {
      insurance: "Aetna",
      subscriberName: "Jane Doe",
      subscriberNum: "ABC123",
    };

    const cases = [
      {
        name: "add_patient",
        run: (ctx: ToolContext) =>
          add_patient.execute(addParams, { ctx, toolCallId: "test-add" }),
      },
      {
        name: "update_insurance",
        run: (ctx: ToolContext) =>
          update_insurance.execute(updateParams, {
            ctx,
            toolCallId: "test-update",
          }),
      },
      {
        name: "cancel_appt",
        setup: (state: CallState) => seedLoadedAppointment(state, 12345),
        run: (ctx: ToolContext) =>
          cancel_appt.execute(
            { appointmentId: 12345 },
            { ctx, toolCallId: "test-cancel" },
          ),
      },
      {
        name: "route_to_spring_hill",
        run: (ctx: ToolContext) =>
          route_to_spring_hill.execute({}, { ctx, toolCallId: "test-route" }),
      },
      {
        name: "transfer_call",
        run: (ctx: ToolContext) =>
          transfer_call.execute({}, { ctx, toolCallId: "test-transfer" }),
      },
      {
        name: "book_appt",
        setup: (state: CallState) => {
          seedLastAvailabilitySlot(state);
          markBookingConfirmedInState(state);
        },
        run: (ctx: ToolContext) =>
          book_appt.execute(
            { slotId: "A", appointmentTypeId: 1007 },
            { ctx, toolCallId: "test-book" },
          ),
      },
    ];

    for (const testCase of cases) {
      const { ctx, state } = createInterruptedToolContext();
      testCase.setup?.(state);

      const result = await testCase.run(ctx);

      expectInterruptedOutcome(result, testCase.name);
      expect(state.flow.pendingActions, testCase.name).toEqual([]);
      expect(state.transferInFlight, testCase.name).not.toBe(true);
    }

    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it("tells Crystal River callers when Spring Hill accepts insurance Crystal River does not", async () => {
    const { ctx, state } = createToolContext();
    state.officeKey = "crystal-river";
    state.amdOfficePhone = "+13523202007";

    const result = await check_insurance.execute(
      { plan: "Humana PPO", coverageType: "medical" },
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
      activeFlow: "routing",
      step: "route_office",
      officeKey: "crystal-river",
    });
    expect(buildToolsForState(state).visibleToolNames).toContain(
      "route_to_spring_hill",
    );
    expect(state.flowGuardObservations).toEqual([
      expect.objectContaining({
        toolName: "check_insurance",
        allowed: true,
        reason: "allowed",
        mode: "report_only",
      }),
    ]);
  });

  it("tells Crystal River callers when Spring Hill accepts an added office-specific rejection", async () => {
    const { ctx, state } = createToolContext();
    state.officeKey = "crystal-river";
    state.amdOfficePhone = "+13523202007";

    const result = await check_insurance.execute(
      { plan: "Ambetter", coverageType: "medical" },
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
      { plan: "Oscar", coverageType: "medical" },
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
    state.flow.patientStatus = "matched";
    state.flow.patients[state.flow.activePatientRef!].status = "matched";
    seedPendingSideEffectAction(state, "route_to_spring_hill");

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
      patientName: "Jane Doe",
      dob: "01/01/1980",
      routing: "all_three",
      coverageType: "medical",
    }),
    flowHarnessEnabled: true,
    flowGuardObservations: [],
    preCallLookup: {
      status: "verified",
      durationMs: 12,
    },
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
    transferInFlight: false,
  };
  const ctx = {
    session: { userData: state },
    speechHandle,
    waitForPlayout: vi.fn(),
  } as unknown as ToolContext;
  state.flow.patientStatus = "verified";
  state.flow.patients[state.flow.activePatientRef!].status = "verified";
  state.flow.visitType = "medical";

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

function markBookingConfirmedInState(state: CallState, slotId = "A") {
  state.flow.schedulingGoal = {
    ...(state.flow.schedulingGoal ?? {
      status: "confirming_booking",
      updatedAt: Date.now(),
    }),
    status: "confirming_booking",
    patientRef: state.flow.activePatientRef,
    appointmentAction: "schedule",
    selectedSlotId: slotId,
    bookingConfirmed: true,
    updatedAt: Date.now(),
  };
}

function seedPendingBookingAction(
  state: CallState,
  overrides: {
    appointmentTypeId?: number;
    confirmed?: boolean;
  } = {},
) {
  const slot = state.lastAvailabilitySlots[0];
  if (!slot) throw new Error("seed a slot before creating a booking action");

  return createPendingBookingAction(state.flow, {
    slotHash: slot.slotId,
    appointmentTypeId: overrides.appointmentTypeId ?? 1007,
    officeKey: state.officeKey,
    routing: slot.routing ?? state.lastAvailabilityRouting,
    spokenSummary: slot.spoken,
    confirmed: overrides.confirmed ?? true,
    createdTurnId: "test-create-booking-action",
    confirmationTurnId:
      overrides.confirmed === false ? undefined : "test-confirm-booking",
  });
}

function seedSuccessfulBooking(state: CallState) {
  seedLastAvailabilitySlot(state);
  const action = seedPendingBookingAction(state);
  action.consumed = true;
  return action;
}

function seedPendingSideEffectAction(
  state: CallState,
  action:
    | "add_patient"
    | "cancel_appt"
    | "update_insurance"
    | "route_to_spring_hill"
    | "transfer_call",
  args: Record<string, unknown> = {},
) {
  const actionType =
    action === "route_to_spring_hill" ? "route_office" : action;
  if (action === "cancel_appt") {
    state.flow.pendingConfirmation = {
      type: "cancel",
      payload: { appointmentId: args.appointmentId },
    };
    if (typeof args.appointmentId === "number") {
      seedLoadedAppointment(state, args.appointmentId);
    }
  }

  return createPendingSideEffectAction(state.flow, {
    type: actionType,
    argsHash: hashToolArgs(args),
    spokenSummary: `confirmed ${action}`,
    patientRef: state.flow.activePatientRef,
    appointmentId:
      typeof args.appointmentId === "number" ? args.appointmentId : undefined,
    requiredFieldsComplete: action === "add_patient",
    confirmed: true,
    createdTurnId: `test-create-${action}`,
    confirmationTurnId: `test-confirm-${action}`,
  });
}

function seedLoadedAppointment(state: CallState, appointmentId = 12345) {
  const appointment = {
    id: appointmentId,
    date: "2026-06-01",
    time: "9:00 AM",
    provider: "Dr. Bach",
    type: "Follow-up",
    facility: "Spring Hill",
    confirmed: true,
  };
  state.appointments = [
    ...state.appointments.filter((item) => item.id !== appointmentId),
    appointment,
  ];
  const activePatient = state.flow.patients[state.flow.activePatientRef!];
  activePatient.appointments = [
    ...activePatient.appointments.filter((item) => item.id !== appointmentId),
    appointment,
  ];
}

function expectInterruptedOutcome(result: unknown, toolName: string) {
  if (typeof result === "string") {
    expect(result, toolName).toMatch(/interrupted/i);
    return;
  }

  expect(result, toolName).toMatchObject({
    outcome: "not_allowed",
    facts: { reason: "speech_interrupted" },
  });
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
