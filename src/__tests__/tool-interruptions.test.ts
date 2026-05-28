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
  book_appt,
  buildCallCenterHandoffHeaders,
  cancel_appt,
  check_insurance,
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
  callerTurnMeaningEvent,
  hashToolArgs,
  activeWorkflowCommandForState,
  inferObviousTurnUnderstanding,
  nextFlowEventId,
  planNextCommand,
  recordAvailabilityCachedSlots,
  recordAvailabilitySearch,
  reduceFlowEvent,
  resumePatientTask,
  startPatientTask,
  type CallFlowState,
  type WorkflowCommand,
} from "../flow/index.js";
import { HOLLYWOOD_OFFICE_PHONE, SWEETWATER_OFFICE_PHONE } from "../offices.js";
import { buildToolsForState } from "../tooling/tool-registry.js";

type SpeechContext = Parameters<typeof makeCurrentSpeechUninterruptible>[0];
type ToolContext = Parameters<typeof book_appt.execute>[1]["ctx"];
type BookingAppointmentKind = "medical" | "routine_vision" | "post_op";

function applyPlannerCommand(
  flow: CallFlowState,
  command: WorkflowCommand,
): void {
  reduceFlowEvent(flow, {
    id: nextFlowEventId("test_planner_command"),
    type: "planner_command_applied",
    source: "planner",
    createdAt: Date.now(),
    command,
  });
}

function bookingArgs(
  slotId = "A",
  appointmentKind: BookingAppointmentKind = "medical",
) {
  return {
    slotId,
    appointmentKind,
    appointmentReason: "blurry vision",
    referringDoctor: "none",
  };
}

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

  it("lets safe tools run before turn understanding on a new user turn", async () => {
    const { ctx, state } = createToolContext();
    state.latestUserTranscript = "I need to move my appointment next week";
    state.turnUnderstandingAppliedForTranscript = null;

    const faqResult = await lookup_knowledge.execute(
      { question: "office hours" },
      { ctx, toolCallId: "test-lookup" },
    );
    expect(faqResult).toContain("Knowledge source:");

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
      nextAction: "verify_patient",
      action: "call_tool",
      tool: "verify_patient",
      args: { firstName: "Jane", lastName: "Doe", dob: "01/01/1980" },
      instruction:
        "Call verify_patient with the patient's first name to load appointments. Caller phone is loaded from state.",
    });
    expect(recorded).not.toHaveProperty("turnState");
    expect(recorded).not.toHaveProperty("controllerDecision");
    expect(recorded).not.toHaveProperty("resolvedMetaDecision");
    expect(recorded).not.toHaveProperty("activeFlow");
    expect(state.turnUnderstandingAppliedForTranscript).toBe(
      "I need to move my appointment next week",
    );
    expect(state.flow.schedulingGoal).toMatchObject({
      appointmentAction: "reschedule",
      preferredWindow: "next week",
    });
  });

  it("allows knowledge lookup when the reschedule task-plan frontier prefers availability", async () => {
    const { ctx, state } = createToolContext();
    seedLoadedAppointment(state, 12345);
    state.latestUserTranscript =
      "Move my Dr. Bach appointment to Monday at 1 PM";
    state.turnUnderstandingAppliedForTranscript = null;

    const recorded = await record_turn_understanding.execute(
      {
        goal: "manage_existing_appointment",
        appointmentAction: "reschedule",
        patient: {
          patientMentioned: "caller",
          relationshipToCaller: "self",
        },
        scheduling: {
          preferredWindow: "Monday at 1 PM",
        },
        interruption: "none",
        confidence: 0.94,
        evidence: ["Dr. Bach", "Monday at 1 PM"],
      },
      { ctx, toolCallId: "test-understanding-reschedule-availability" },
    );

    expect(recorded).toMatchObject({
      phase: "searching_replacement",
      tool: "get_availability",
      suggestedTool: "get_availability",
    });

    const lookupResult = await lookup_knowledge.execute(
      { question: "availability with Dr. Bach Monday at 1 PM" },
      { ctx, toolCallId: "test-stale-lookup" },
    );

    expect(lookupResult).toContain("Knowledge source:");
  });

  it("returns a compact command packet with exact booking args", async () => {
    const { ctx, state } = createToolContext();
    state.latestUserTranscript = "Yes, book it.";
    state.turnUnderstandingAppliedForTranscript = null;
    state.flow.activeIntent = "new_appointment";
    state.flow.activeFlow = "scheduling";
    state.flow.step = "confirm_booking";
    state.flow.visitType = "medical";
    state.flow.coverageType = "medical";
    state.flow.schedulingGoal = {
      patientRef: "caller",
      status: "confirming_booking",
      appointmentAction: "schedule",
      visitReason: "double vision",
      noteDraft: {
        appointmentReason: "double vision",
        referringDoctor: "none",
      },
      visitType: "medical",
      preferredWindow: "tomorrow",
      selectedSlotId: "C",
      updatedAt: Date.now(),
    };

    const recorded = await record_turn_understanding.execute(
      {
        goal: "schedule",
        appointmentAction: null,
        scheduling: {
          selectedSlotId: "C",
          bookingConfirmed: true,
        },
        interruption: "none",
        confidence: 0.95,
        evidence: ["Yes, book it"],
      },
      { ctx, toolCallId: "test-understanding-book" },
    );

    expect(recorded).toMatchObject({
      status: "recorded",
      task: "scheduling",
      phase: "booking",
      nextAction: "book_appt",
      action: "call_tool",
      tool: "book_appt",
      suggestedTool: "book_appt",
      args: {
        slotId: "C",
        appointmentKind: "medical",
        appointmentReason: "double vision",
        referringDoctor: "none",
      },
      instruction: "Call book_appt now.",
    });
  });

  it("asks only for the referring doctor when booking is confirmed and the reason is known", async () => {
    const { ctx, state } = createToolContext();
    state.latestUserTranscript = "Yes, book it.";
    state.turnUnderstandingAppliedForTranscript = null;
    state.flow.activeIntent = "new_appointment";
    state.flow.activeFlow = "scheduling";
    state.flow.step = "confirm_booking";
    state.flow.visitType = "medical";
    state.flow.coverageType = "medical";
    state.flow.schedulingGoal = {
      patientRef: "caller",
      status: "confirming_booking",
      appointmentAction: "schedule",
      visitReason: "post-op",
      visitType: "medical",
      preferredWindow: "next week",
      selectedSlotId: "B",
      updatedAt: Date.now(),
    };

    const recorded = await record_turn_understanding.execute(
      {
        goal: "schedule",
        appointmentAction: null,
        scheduling: {
          selectedSlotId: "B",
          bookingConfirmed: true,
        },
        interruption: "none",
        confidence: 0.95,
        evidence: ["Yes, book it"],
      },
      { ctx, toolCallId: "test-understanding-missing-referrer" },
    );

    expect(recorded).toMatchObject({
      status: "recorded",
      task: "scheduling",
      phase: "collecting_booking_note",
      nextAction: "ask",
      action: "ask",
      missingFacts: ["referringDoctor"],
      instruction:
        "Ask who referred them, or whether there is no referring doctor. Do not ask for surgery details; the appointment reason is already known.",
    });
    expect(recorded).not.toMatchObject({
      tool: "book_appt",
    });
  });

  it("uses caller phone from state when resolving by first name", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({
        status: "verified",
        patientId: "patient-1",
        name: "Jane Doe",
        dob: "01/01/1980",
        phone: "+17275551212",
        appointments: [],
      }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { ctx } = createToolContext();

    const result = await verify_patient.execute(
      { firstName: "Jane" },
      { ctx, toolCallId: "test-verify-first-name-phone" },
    );

    expect(result).toMatchObject({
      status: "verified",
      patient: {
        id: "patient-1",
      },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      firstName: "Jane",
      phone: "+17275551212",
    });
  });

  it("uses last name and DOB without caller phone for caregiver fallback lookup", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({
        status: "verified",
        patientId: "patient-child",
        name: "Child Doe",
        dob: "01/01/2014",
        phone: "+17275550000",
        appointments: [],
      }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { ctx } = createToolContext();

    const result = await verify_patient.execute(
      { lastName: "Doe", dob: "01/01/2014" },
      { ctx, toolCallId: "test-verify-caregiver-fallback" },
    );

    expect(result).toMatchObject({
      status: "verified",
      patient: {
        id: "patient-child",
      },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(requestBody).toMatchObject({
      lastName: "Doe",
      dob: "01/01/2014",
    });
    expect(requestBody).not.toHaveProperty("phone");
    expect(requestBody).not.toHaveProperty("firstName");
  });

  it("does not ask for the same last name and DOB again after full identity misses", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({
        status: "not_found",
        message: "No patient found matching the provided information",
      }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { ctx } = createToolContext();

    const result = await verify_patient.execute(
      { firstName: "Jane", lastName: "Doe", dob: "01/01/1980" },
      { ctx, toolCallId: "test-verify-full-identity-not-found" },
    );

    expect(result).toMatchObject({
      status: "not_found",
      next: "ask_spelled_name_or_register",
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty(
      "phone",
    );
  });

  it("does not re-verify or mutate identity after pre-call confirmation", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { ctx, state } = createToolContext();
    state.flow.preCall = {
      status: "single_match_confirmed",
      source: "phone_lookup",
      callerPhone: "+17275551212",
      candidates: [
        {
          ref: "caller",
          firstName: "Jane",
          lastName: "Doe",
          dob: "01/01/1980",
          patientId: "patient-1",
          relationshipToCaller: "self",
          appointments: [],
          appointmentsStatus: "found",
        },
      ],
      selectedCandidateRef: "caller",
      identityPromotion: "first_name_confirmed",
    };
    state.flow.patients["candidate:bad"] = createPatientContext({
      ref: "candidate:bad",
      status: "candidate",
    });
    state.flow.activePatientRef = "candidate:bad";

    const result = await verify_patient.execute(
      { firstName: "Jane", lastName: "Gomez", dob: "01/15/1965" },
      { ctx, toolCallId: "test-precall-already-confirmed" },
    );

    expect(result).toMatchObject({
      outcome: "success",
      facts: { reason: "verify_patient_pre_call_already_confirmed" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.flow.activePatientRef).toBe("caller");
    expect(state.flow.patients.caller).toMatchObject({
      status: "verified",
      patientId: "patient-1",
    });
    expect(state.flowGuardObservations.at(-1)).toMatchObject({
      toolName: "verify_patient",
      allowed: false,
      reason: "verify_patient_pre_call_already_confirmed",
    });
  });

  it("confirms a pending single pre-call caller instead of re-verifying the same patient", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { ctx, state } = createToolContext();
    seedPendingSinglePreCallCaller(state);
    state.flow.patients["candidate:bad"] = createPatientContext({
      ref: "candidate:bad",
      status: "candidate",
      patientName: "Linda Dow",
    });
    state.flow.activePatientRef = "candidate:bad";
    state.flow.patientStatus = "candidate";
    state.flow.step = "verify_patient";

    const result = await verify_patient.execute(
      { firstName: "Linda", lastName: "Dow" },
      { ctx, toolCallId: "test-precall-pending-confirmed-by-verify-args" },
    );

    expect(result).toMatchObject({
      outcome: "success",
      facts: { reason: "verify_patient_pre_call_already_confirmed" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.flow.preCall).toMatchObject({
      status: "single_match_confirmed",
      selectedCandidateRef: "caller",
      identityPromotion: "first_name_confirmed",
    });
    expect(state.flow.activePatientRef).toBe("caller");
    expect(state.flow.patients.caller).toMatchObject({
      status: "verified",
      patientId: "17603706",
    });
  });

  it("allows normal verification when same first-name args conflict with the pre-call caller", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({
        status: "not_found",
        message: "No patient found matching the provided information",
      }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { ctx, state } = createToolContext();
    seedPendingSinglePreCallCaller(state);

    const result = await verify_patient.execute(
      { firstName: "Linda", lastName: "Smith" },
      { ctx, toolCallId: "test-precall-same-first-conflicting-last" },
    );

    expect(result).toMatchObject({
      status: "not_found",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(state.flow.preCall?.status).toBe(
      "single_match_pending_confirmation",
    );
    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(requestBody).toMatchObject({
      firstName: "Linda",
      lastName: "Smith",
      phone: "+12018031225",
    });
  });

  it("returns sanitized appointment lookup payload while storing cancel tokens internally", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({
        status: "verified",
        patientId: "patient-1",
        appointmentsStatus: "found",
        appointments: [
          {
            id: 12345,
            date: "Monday, June 1, 2026",
            time: "9:00 AM",
            provider: "Dr. Bach",
            type: "Follow-up",
            facility: "Spring Hill",
            confirmed: true,
            cancelToken: "cancel-token-12345",
          },
        ],
      }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, state } = createToolContext();

    const result = await verify_patient.execute(
      { firstName: "Jane", lastName: "Doe", dob: "01/01/1980" },
      { ctx, toolCallId: "test-verify-with-appointments-tokens" },
    );

    expect(state.appointmentCancelTokens).toEqual({
      "12345": "cancel-token-12345",
    });
    expect(state.appointments[0]).not.toHaveProperty("cancelToken");
    expect(result).toMatchObject({
      status: "verified",
      appointments: {
        status: "found",
        items: [expect.objectContaining({ id: 12345 })],
      },
    });
    expect(JSON.stringify(result)).not.toContain("cancel-token-12345");
    expect(JSON.stringify(result)).not.toContain("cancelToken");
  });

  it("stores appointments from patient resolve when appointment planner asks for lookup", async () => {
    const fetchMock = vi.fn().mockImplementationOnce(async () => ({
      ok: true,
      json: async () => ({
        status: "verified",
        patientId: "patient-2",
        name: "TEST,CHASE",
        dob: "04/07/2000",
        phone: "(954) 609-7250",
        appointmentsStatus: "found",
        appointments: [
          {
            id: 12345,
            date: "Tuesday, June 2, 2026",
            time: "1:30 PM",
            provider: "Dr. Licht",
            type: "Crystal River Established Patient",
            facility: "Crystal River",
            confirmed: true,
            cancelToken: "cancel-token-12345",
          },
        ],
      }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, state } = createToolContext();
    resetToUnverifiedAppointmentTask(state, "cancel my appointment");

    await record_turn_understanding.execute(
      {
        goal: "manage_existing_appointment",
        appointmentAction: "cancel",
        patient: {
          patientMentioned: "caller",
          relationshipToCaller: "self",
        },
        interruption: "none",
        confidence: 0.9,
        evidence: ["cancel my appointment"],
      },
      { ctx, toolCallId: "test-understanding-cancel" },
    );

    const result = (await verify_patient.execute(
      { firstName: "Chase", lastName: "Test", dob: "04/07/2000" },
      { ctx, toolCallId: "test-verify-auto-lookup" },
    )) as Record<string, unknown>;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      "/api/patient/resolve",
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      firstName: "Chase",
      lastName: "Test",
      dob: "04/07/2000",
    });
    expect(result).toMatchObject({
      status: "verified",
      appointments: {
        status: "found",
        items: [expect.objectContaining({ id: 12345 })],
      },
    });
    expect(result.planner).toMatchObject({
      task: "appointment_cancel",
      nextAction: "confirm",
    });
    expect(result.planner).not.toMatchObject({
      tool: "verify_patient",
      args: {},
    });
    expect(state.appointments).toContainEqual(
      expect.objectContaining({ id: 12345 }),
    );
    expect(state.appointmentCancelTokens).toMatchObject({
      "12345": "cancel-token-12345",
    });
  });

  it("records no-appointment lookup results so the planner does not ask for appointment refresh again", async () => {
    const fetchMock = vi.fn().mockImplementationOnce(async () => ({
      ok: true,
      json: async () => ({
        status: "verified",
        patientId: "patient-2",
        name: "TEST,CHASE",
        dob: "04/07/2000",
        phone: "(954) 609-7250",
        appointmentsStatus: "none",
        appointments: [],
        message: "No appointments found for this patient",
      }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, state } = createToolContext();
    resetToUnverifiedAppointmentTask(state, "cancel my appointment");

    await record_turn_understanding.execute(
      {
        goal: "manage_existing_appointment",
        appointmentAction: "cancel",
        patient: {
          patientMentioned: "caller",
          relationshipToCaller: "self",
        },
        interruption: "none",
        confidence: 0.9,
        evidence: ["cancel my appointment"],
      },
      { ctx, toolCallId: "test-understanding-cancel-empty" },
    );

    const result = (await verify_patient.execute(
      { firstName: "Chase", lastName: "Test", dob: "04/07/2000" },
      { ctx, toolCallId: "test-verify-auto-empty-lookup" },
    )) as Record<string, unknown>;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: "verified",
      appointments: {
        status: "none",
        items: [],
      },
    });
    expect(result.planner).toMatchObject({
      task: "appointment_cancel",
      phase: "complete",
      nextAction: "respond",
      missingFacts: [],
    });
    expect(result.planner).not.toMatchObject({
      tool: "verify_patient",
      args: {},
    });
    expect(activeWorkflowCommandForState(state.flow)).toMatchObject({
      taskKind: "appointment_cancel",
      phase: "complete",
      nextAction: "respond",
      missingFacts: [],
    });
    expect(state.appointments).toEqual([]);
  });

  it("does not require manual turn-understanding for knowledge lookup", async () => {
    const { ctx, state } = createToolContext();
    state.latestUserTranscript = "what are your office hours?";
    state.turnUnderstandingAppliedForTranscript = null;

    const result = await lookup_knowledge.execute(
      { question: "office hours" },
      { ctx, toolCallId: "test-lookup-harness" },
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
    const { ctx } = createToolContext();

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
    const { ctx } = createToolContext();

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
          return book_appt.execute(bookingArgs(), {
            ctx,
            toolCallId: "test-book",
          });
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

  it("does not retry transfer_call after the SIP transfer call fails", async () => {
    transferSipParticipantMock.mockRejectedValueOnce(
      new Error("sip transfer failed"),
    );
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
    const second = await transfer_call.execute(
      {},
      { ctx, toolCallId: "test-transfer-second" },
    );

    expect(first).toMatchObject({
      outcome: "error",
      nextStep: "handoff",
      speak: "Could not transfer the call. Do not call transfer_call again.",
      facts: { reason: "transfer_failed" },
      retryable: false,
    });
    expect(second).toMatchObject({
      outcome: "not_allowed",
      nextStep: "answer",
      facts: { reason: "transfer_already_attempted" },
      retryable: false,
    });
    expect(state.transferred).toBe(false);
    expect(transferSipParticipantMock).toHaveBeenCalledOnce();
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
    seedPendingSideEffectAction(state, "transfer_call");

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

    await book_appt.execute(bookingArgs(), { ctx, toolCallId: "test-book" });

    expect(fetchMock).toHaveBeenCalledOnce();
    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(requestBody).toMatchObject({
      bookingToken: "signed-token",
      visitCategory: "medical",
      visitKind: "medical",
      patientStatus: "established",
      patientId: "patient-1",
      patientName: "Jane Doe",
      dob: "01/01/1980",
      appointmentReason: "blurry vision",
      referringDoctor: "none",
    });
    expect(requestBody).not.toHaveProperty("appointmentTypeId");
    expect(requestBody).not.toHaveProperty("columnId");
    expect(requestBody).not.toHaveProperty("profileId");
    expect(requestBody).not.toHaveProperty("office");
  });

  it("stores partial booking results with appointment IDs as booked appointments", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({
        status: "partial",
        appointmentId: 12345,
        providerName: "Dr. D. Noel",
        locationName: "Spring Hill",
        appointmentTypeName: "Established Adult Medical (Follow Up)",
        noteStatus: "failed",
      }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, state } = createToolContext();
    seedLastAvailabilitySlot(state, {
      provider: "Dr. Noel",
      date: "2026-05-26",
      time: "10:00 AM",
      datetime: "2026-05-26T10:00",
    });
    seedPendingBookingAction(state);

    const result = await book_appt.execute(bookingArgs(), {
      ctx,
      toolCallId: "test-book-partial",
    });

    expect(result).toMatchObject({
      status: "partial",
      appointmentId: 12345,
    });
    expect(state.flow.pendingActions[0]).toMatchObject({
      type: "book_appt",
      consumed: true,
    });
    expect(state.appointments).toContainEqual({
      id: 12345,
      date: "2026-05-26",
      time: "10:00 AM",
      provider: "Dr. Noel",
      type: "Established Adult Medical (Follow Up)",
      facility: "Spring Hill",
      confirmed: true,
    });
    expect(
      state.flow.patients[state.flow.activePatientRef!].appointments,
    ).toContainEqual(expect.objectContaining({ id: 12345 }));
  });

  it("stores booking-token slots and hides raw scheduler IDs from the model", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({
        status: "success",
        outcome: "availability_found",
        dateShifted: true,
        slots: [
          {
            provider: "Dr. Austin Bach (Overflow)",
            time: "9:00 AM",
            datetime: "2026-04-28T09:00",
            columnId: 1598,
            profileId: 620,
            duration: 15,
            requiresForce: true,
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
      result: "slots_found",
      reply: "I found April 28 at 9:00 AM with Dr. Bach. Does that work?",
      next: "offer_slot",
      slotId: "A",
      slots: [
        {
          slotId: "A",
          reply: "April 28 at 9:00 AM with Dr. Bach",
          provider: "Dr. Bach",
          time: "9:00 AM",
          date: "2026-04-28",
        },
      ],
    });
    const modelSlot = (result as { slots: Array<Record<string, unknown>> })
      .slots[0];
    expect(modelSlot).not.toHaveProperty("bookingToken");
    expect(modelSlot).not.toHaveProperty("columnId");
    expect(modelSlot).not.toHaveProperty("profileId");
    expect(modelSlot).not.toHaveProperty("duration");
    expect(modelSlot).not.toHaveProperty("requiresForce");
    expect(modelSlot).not.toHaveProperty("datetime");
    expect(modelSlot).not.toHaveProperty("dateShifted");
    expect(modelSlot).not.toHaveProperty("timeWindow");
    expect(modelSlot).not.toHaveProperty("bookable");
    expect(result).not.toHaveProperty("say");
    expect(result).not.toHaveProperty("selectedSlotId");
    expect(result).not.toHaveProperty("dateShifted");
    expect(result).not.toHaveProperty("actualDate");
    expect(result).not.toHaveProperty("status");
    expect(result).not.toHaveProperty("outcome");
    expect(result).not.toHaveProperty("availabilityFound");
    expect(result).not.toHaveProperty("search");
    expect(result).not.toHaveProperty("preference");
    expect(result).not.toHaveProperty("recommendedSlot");
    expect(result).not.toHaveProperty("booking");
    expect(result).not.toHaveProperty("planner");
    expect(result).not.toHaveProperty("middlewareResult");
    expect(JSON.stringify(result)).not.toContain("signed-token");
    expect(state.lastAvailabilitySlots[0]).toMatchObject({
      slotId: "A",
      bookingToken: "signed-token",
      columnId: 1598,
      profileId: 620,
      duration: 15,
    });
    expect(state.flow.step).toBe("confirm_booking");
  });

  it("labels availability slots chronologically even when middleware returns them out of order", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({
        status: "success",
        outcome: "availability_found",
        availabilityFound: true,
        requestedDate: "2026-06-01",
        actualDate: "2026-06-01",
        slots: [
          {
            provider: "Dr. Austin Bach",
            time: "9:45 AM",
            datetime: "2026-06-01T09:45",
            columnId: 1307,
            profileId: 620,
            duration: 15,
            bookingToken: "later-token",
          },
          {
            provider: "Dr. Austin Bach",
            time: "8:45 AM",
            datetime: "2026-06-01T08:45",
            columnId: 682,
            profileId: 620,
            duration: 15,
            bookingToken: "earlier-token",
          },
        ],
      }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, state } = createToolContext();

    const result = await get_availability.execute(
      { date: "2026-06-01" },
      { ctx, toolCallId: "test-availability-sorted" },
    );

    expect(result).toMatchObject({
      slotId: "A",
      reply: "I found June 1 at 8:45 AM with Dr. Bach. Does that work?",
      slots: [
        { slotId: "A", time: "8:45 AM" },
        { slotId: "B", time: "9:45 AM" },
      ],
    });
    expect(state.lastAvailabilitySlots).toEqual([
      expect.objectContaining({ slotId: "A", time: "8:45 AM" }),
      expect.objectContaining({ slotId: "B", time: "9:45 AM" }),
    ]);
  });

  it("summarizes and groups availability around the caller's preferred time window", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({
        status: "success",
        outcome: "availability_found",
        availabilityFound: true,
        requestedDate: "2026-06-01",
        actualDate: "2026-06-03",
        searchedFrom: "2026-06-01",
        searchedThrough: "2026-06-03",
        slots: [
          {
            provider: "Dr. J. Licht",
            time: "9:00 AM",
            datetime: "2026-06-03T09:00",
            columnId: 1593,
            profileId: 2064,
            duration: 30,
            bookingToken: "morning-token",
          },
          {
            provider: "Dr. J. Licht",
            time: "2:30 PM",
            datetime: "2026-06-03T14:30",
            columnId: 1593,
            profileId: 2064,
            duration: 30,
            bookingToken: "afternoon-token",
          },
          {
            provider: "Dr. J. Licht",
            time: "4:00 PM",
            datetime: "2026-06-03T16:00",
            columnId: 1593,
            profileId: 2064,
            duration: 30,
            bookingToken: "late-token",
          },
        ],
      }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, state } = createToolContext();
    state.flow.schedulingGoal = {
      patientRef: "caller",
      status: "ready_for_availability",
      appointmentAction: "schedule",
      preferredWindow: "afternoon",
    };

    const result = await get_availability.execute(
      { date: "2026-06-01" },
      { ctx, toolCallId: "test-availability-afternoon" },
    );

    expect(result).toMatchObject({
      result: "slots_found",
      reply:
        "I do not see anything on June 1, but I found June 3 at 2:30 PM with Dr. Licht. Does that work? If not, I can offer another option.",
      next: "offer_slot",
      searched: "2026-06-01 through 2026-06-03",
      nextSearchDate: "2026-06-04",
      slotId: "B",
      slots: [
        {
          slotId: "A",
          reply: "June 3 at 9:00 AM with Dr. Licht",
        },
        {
          slotId: "B",
          reply: "June 3 at 2:30 PM with Dr. Licht",
        },
        {
          slotId: "C",
          reply: "June 3 at 4:00 PM with Dr. Licht",
        },
      ],
    });
    expect(result).not.toHaveProperty("say");
    expect(result).not.toHaveProperty("foundDate");
    expect(result).not.toHaveProperty("selectedSlotId");
    expect(result).not.toHaveProperty("availabilitySummary");
    expect(result).not.toHaveProperty("searchedRange");
    expect(result).not.toHaveProperty("matchingSlots");
    expect(result).not.toHaveProperty("otherSlots");
    expect(result).not.toHaveProperty("recommendedSlotId");
    expect(result).not.toHaveProperty("recommendedSlot");
    expect(result).not.toHaveProperty("preference");
    expect(result).not.toHaveProperty("booking");
    expect(result).not.toHaveProperty("planner");
    expect(state.lastAvailabilitySlots).toHaveLength(3);
    expect(state.lastAvailabilitySlots[1]).toMatchObject({
      slotId: "B",
      bookingToken: "afternoon-token",
    });
  });

  it("does not treat late morning as late-day availability", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({
        status: "success",
        outcome: "availability_found",
        availabilityFound: true,
        requestedDate: "2026-06-01",
        actualDate: "2026-06-03",
        searchedFrom: "2026-06-01",
        searchedThrough: "2026-06-03",
        slots: [
          {
            provider: "Dr. J. Licht",
            time: "10:30 AM",
            datetime: "2026-06-03T10:30",
            columnId: 1593,
            profileId: 2064,
            duration: 30,
            bookingToken: "late-morning-token",
          },
          {
            provider: "Dr. J. Licht",
            time: "4:30 PM",
            datetime: "2026-06-03T16:30",
            columnId: 1593,
            profileId: 2064,
            duration: 30,
            bookingToken: "late-day-token",
          },
        ],
      }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, state } = createToolContext();
    state.flow.schedulingGoal = {
      patientRef: "caller",
      status: "ready_for_availability",
      appointmentAction: "schedule",
      preferredWindow: "late morning",
    };

    const result = await get_availability.execute(
      { date: "2026-06-01" },
      { ctx, toolCallId: "test-availability-late-morning" },
    );

    expect(result).toMatchObject({
      result: "slots_found",
      slotId: "A",
    });
  });

  it("treats after 3 as afternoon or late-day availability", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({
        status: "success",
        outcome: "availability_found",
        availabilityFound: true,
        requestedDate: "2026-06-01",
        actualDate: "2026-06-03",
        searchedFrom: "2026-06-01",
        searchedThrough: "2026-06-03",
        slots: [
          {
            provider: "Dr. J. Licht",
            time: "2:30 PM",
            datetime: "2026-06-03T14:30",
            columnId: 1593,
            profileId: 2064,
            duration: 30,
            bookingToken: "too-early-token",
          },
          {
            provider: "Dr. J. Licht",
            time: "3:30 PM",
            datetime: "2026-06-03T15:30",
            columnId: 1593,
            profileId: 2064,
            duration: 30,
            bookingToken: "after-three-token",
          },
          {
            provider: "Dr. J. Licht",
            time: "4:30 PM",
            datetime: "2026-06-03T16:30",
            columnId: 1593,
            profileId: 2064,
            duration: 30,
            bookingToken: "late-token",
          },
        ],
      }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, state } = createToolContext();
    state.flow.schedulingGoal = {
      patientRef: "caller",
      status: "ready_for_availability",
      appointmentAction: "schedule",
      preferredWindow: "after 3",
    };

    const result = await get_availability.execute(
      { date: "2026-06-01" },
      { ctx, toolCallId: "test-availability-after-three" },
    );

    expect(result).toMatchObject({
      result: "slots_found",
      slotId: "B",
      reply:
        "I do not see anything on June 1, but I found June 3 at 3:30 PM with Dr. Licht. Does that work? If not, I can offer another option.",
    });
  });

  it("summarizes exhausted no-availability windows for the model", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({
        status: "success",
        outcome: "no_availability",
        availabilityFound: false,
        requestedDate: "2026-06-01",
        shouldRetrySameSearch: false,
        nextAction: "ask_for_different_preferences",
        searchedFrom: "2026-06-01",
        searchedThrough: "2026-06-15",
        slots: [],
      }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { ctx } = createToolContext();

    const result = await get_availability.execute(
      { date: "2026-06-01" },
      { ctx, toolCallId: "test-availability-none" },
    );

    expect(result).toMatchObject({
      result: "no_slots_found",
      reply:
        "I do not see openings from June 1 through June 15. Would you like me to check June 16, or try a different day or time?",
      next: "ask_new_date_or_time",
      searched: "2026-06-01 through 2026-06-15",
      nextSearchDate: "2026-06-16",
      slots: [],
    });
    expect(result).not.toHaveProperty("say");
    expect(result).not.toHaveProperty("availabilitySummary");
    expect(result).not.toHaveProperty("searchedRange");
    expect(result).not.toHaveProperty("nextRecommendedSearchDate");
    expect(result).not.toHaveProperty("status");
    expect(result).not.toHaveProperty("outcome");
    expect(result).not.toHaveProperty("availabilityFound");
    expect(result).not.toHaveProperty("search");
    expect(result).not.toHaveProperty("booking");
    expect(result).not.toHaveProperty("planner");
  });

  it("handles no-availability middleware responses without a slots array", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({
        status: "success",
        outcome: "no_availability",
        availabilityFound: false,
        requestedDate: "2026-06-01",
        searchedFrom: "2026-06-01",
        searchedThrough: "2026-06-15",
        shouldRetrySameSearch: false,
      }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, state } = createToolContext();
    seedLastAvailabilitySlot(state);

    const result = await get_availability.execute(
      { date: "2026-06-01" },
      { ctx, toolCallId: "test-availability-none-without-slots" },
    );

    expect(result).toMatchObject({
      result: "no_slots_found",
      reply:
        "I do not see openings from June 1 through June 15. Would you like me to check June 16, or try a different day or time?",
      next: "ask_new_date_or_time",
      searched: "2026-06-01 through 2026-06-15",
      nextSearchDate: "2026-06-16",
      slots: [],
    });
    expect(state.lastAvailabilitySlots).toEqual([]);
  });

  it("allows availability when visit type context is missing", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({
        status: "success",
        outcome: "availability_found",
        slots: [
          {
            provider: "Dr. Austin Bach",
            time: "10:00 AM",
            datetime: "2026-04-28T10:00",
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
    state.flow.visitType = undefined;
    state.flow.coverageType = undefined;

    const result = await get_availability.execute(
      { date: "2026-04-28" },
      { ctx, toolCallId: "test-availability-missing-visit-type" },
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      result: "slots_found",
      slots: [{ slotId: "A", time: "10:00 AM" }],
    });
    expect(state.flow.visitType).toBe("medical");
    expect(state.flow.coverageType).toBe("medical");
    expect(state.flowGuardObservations).toEqual([
      expect.objectContaining({
        toolName: "get_availability",
        allowed: true,
        reason: "allowed",
      }),
    ]);
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
      { date: "2026-04-28" },
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

    await book_appt.execute(bookingArgs(), { ctx, toolCallId: "test-book" });

    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(requestBody).toMatchObject({
      bookingToken: "signed-token",
      visitCategory: "medical",
      visitKind: "medical",
      patientStatus: "established",
      patientId: "patient-1",
      patientName: "Jane Doe",
      dob: "01/01/1980",
      routing: "all_three",
    });
    expect(requestBody).not.toHaveProperty("appointmentTypeId");
    expect(requestBody).not.toHaveProperty("columnId");
    expect(requestBody).not.toHaveProperty("profileId");
    expect(requestBody).not.toHaveProperty("office");
    expect(state.lastAvailabilitySlots).toEqual([]);
  });

  it("blocks booking when the flow harness is disabled", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({ status: "booked", appointmentId: 12345 }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, state } = createToolContext();
    state.flowHarnessEnabled = false;
    seedLastAvailabilitySlot(state, { bookingToken: "signed-token" });
    seedPendingBookingAction(state);

    const result = await book_appt.execute(bookingArgs(), {
      ctx,
      toolCallId: "test-book-harness-disabled",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      outcome: "not_allowed",
      nextStep: "handoff",
      facts: { reason: "booking_requires_flow_harness" },
      retryable: false,
    });
  });

  it("books confirmed pre-call patients without verify_patient", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({ status: "booked", appointmentId: 12345 }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, state } = createToolContext();
    state.patientId = null;
    state.patientName = null;
    state.dob = null;
    state.flow = createInitialFlowState({
      officeKey: "spring-hill",
      patientId: "precall-patient",
      patientName: "Linda Dow",
      dob: "05/14/1958",
      routing: "all_three",
      coverageType: "medical",
      preCall: {
        status: "single_match_confirmed",
        source: "phone_lookup",
        callerPhone: "+17275551212",
        candidates: [
          {
            ref: "caller",
            firstName: "Linda",
            lastName: "Dow",
            dob: "05/14/1958",
            patientId: "precall-patient",
            relationshipToCaller: "self",
            appointments: [],
            appointmentsStatus: "none",
          },
        ],
        selectedCandidateRef: "caller",
        identityPromotion: "first_name_confirmed",
      },
    });
    state.flow.visitType = "medical";
    state.flow.step = "book";
    seedLastAvailabilitySlot(state, { bookingToken: "signed-token" });
    seedPendingBookingAction(state);

    const result = await book_appt.execute(bookingArgs(), {
      ctx,
      toolCallId: "test-book-precall",
    });

    expect(result).toMatchObject({ status: "booked", appointmentId: 12345 });
    expect(fetchMock).toHaveBeenCalledOnce();
    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(requestBody).toMatchObject({
      bookingToken: "signed-token",
      patientId: "precall-patient",
      patientName: "Linda Dow",
      dob: "05/14/1958",
    });
    expect(state.flow.patients.caller).toMatchObject({
      status: "verified",
      patientId: "precall-patient",
    });
  });

  it("books an earlier offered slot after a later availability search", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => ({
        ok: true,
        json: async () => ({
          status: "success",
          outcome: "availability_found",
          availabilityFound: true,
          requestedDate: "2026-06-01",
          actualDate: "2026-06-01",
          slots: [
            {
              provider: "Dr. J. Licht",
              time: "9:00 AM",
              datetime: "2026-06-01T09:00",
              columnId: 1593,
              profileId: 2064,
              duration: 30,
              bookingToken: "first-token",
            },
          ],
        }),
        text: async () => "",
      }))
      .mockImplementationOnce(async () => ({
        ok: true,
        json: async () => ({
          status: "success",
          outcome: "availability_found",
          availabilityFound: true,
          requestedDate: "2026-06-08",
          actualDate: "2026-06-08",
          slots: [
            {
              provider: "Dr. J. Licht",
              time: "10:00 AM",
              datetime: "2026-06-08T10:00",
              columnId: 1593,
              profileId: 2064,
              duration: 30,
              bookingToken: "second-token",
            },
          ],
        }),
        text: async () => "",
      }))
      .mockImplementationOnce(async () => ({
        ok: true,
        json: async () => ({ status: "booked", appointmentId: 12345 }),
        text: async () => "",
      }));
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, state } = createToolContext();

    const first = await get_availability.execute(
      { date: "2026-06-01" },
      { ctx, toolCallId: "test-availability-first" },
    );
    const second = await get_availability.execute(
      { date: "2026-06-08" },
      { ctx, toolCallId: "test-availability-second" },
    );

    expect(first).toMatchObject({ slotId: "A" });
    expect(second).toMatchObject({ slotId: "B" });
    expect(state.lastAvailabilitySlots).toEqual([
      expect.objectContaining({ slotId: "B", bookingToken: "second-token" }),
    ]);
    expect(state.bookableAvailabilitySlots).toEqual([
      expect.objectContaining({ slotId: "A", bookingToken: "first-token" }),
      expect.objectContaining({ slotId: "B", bookingToken: "second-token" }),
    ]);
    expect(state.flow.availabilitySearches[0].cachedSlots).toEqual([
      expect.objectContaining({ slotHash: "A" }),
      expect.objectContaining({ slotHash: "B" }),
    ]);

    markBookingConfirmedInState(state, "A");
    const result = await book_appt.execute(bookingArgs("A"), {
      ctx,
      toolCallId: "test-book-first-slot",
    });

    expect(result).toMatchObject({ status: "booked", appointmentId: 12345 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const requestBody = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(requestBody).toMatchObject({
      bookingToken: "first-token",
      patientId: "patient-1",
    });
    expect(state.bookableAvailabilitySlots).toEqual([
      expect.objectContaining({ slotId: "B", bookingToken: "second-token" }),
    ]);
  });

  it("books cached slots without requiring reducer-created confirmation state", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({ status: "booked", appointmentId: 12345 }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, state, speechHandle } = createToolContext();
    seedLastAvailabilitySlot(state);

    const result = await book_appt.execute(bookingArgs(), {
      ctx,
      toolCallId: "test-book-policy",
    });

    expect(speechHandle.allowInterruptions).toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ status: "booked", appointmentId: 12345 });
    expect(state.flow.pendingActions[0]).toMatchObject({
      type: "book_appt",
      slotHash: "A",
      confirmed: true,
      consumed: true,
    });
  });

  it("blocks booking cached slots that are missing a signed booking token", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, state } = createToolContext();
    seedLastAvailabilitySlot(state, { bookingToken: null });
    seedPendingBookingAction(state);

    const result = await book_appt.execute(bookingArgs(), {
      ctx,
      toolCallId: "test-book-missing-token",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      outcome: "not_allowed",
      nextStep: "get_availability",
      facts: {
        reason: "booking_requires_booking_token",
        slotId: "A",
      },
    });
    expect(state.lastAvailabilitySlots).toEqual([]);
    expect(state.lastAvailabilityRouting).toBeNull();
  });

  it("promotes unconfirmed pending booking actions when book_appt is called", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({ status: "booked", appointmentId: 12345 }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, state } = createToolContext();
    seedLastAvailabilitySlot(state);
    seedPendingBookingAction(state, { confirmed: false });

    const result = await book_appt.execute(bookingArgs(), {
      ctx,
      toolCallId: "test-book-unconfirmed",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ status: "booked", appointmentId: 12345 });
    expect(state.flow.pendingActions[0]).toMatchObject({
      type: "book_appt",
      confirmed: true,
      consumed: true,
    });
  });

  it("books the requested cached slot even when older pending state points at another slot", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({ status: "booked", appointmentId: 12345 }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, state } = createToolContext();
    seedLastAvailabilitySlot(state, {
      slotId: "A",
      spoken: "2026-06-01 9:45 AM with Dr. Bach",
      provider: "Dr. Bach",
      date: "2026-06-01",
      time: "9:45 AM",
      datetime: "2026-06-01T09:45",
      bookingToken: "a-token",
    });
    state.lastAvailabilitySlots.push({
      ...state.lastAvailabilitySlots[0],
      slotId: "G",
      spoken: "2026-06-01 11:15 AM with Dr. Bach",
      time: "11:15 AM",
      datetime: "2026-06-01T11:15",
      bookingToken: "g-token",
    });
    state.bookableAvailabilitySlots = [...state.lastAvailabilitySlots];
    seedPendingBookingAction(state);

    const result = await book_appt.execute(bookingArgs("G"), {
      ctx,
      toolCallId: "test-book-selected-cached-slot",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ status: "booked", appointmentId: 12345 });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      bookingToken: "g-token",
    });
    expect(state.flow.pendingActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "book_appt",
          slotHash: "A",
          confirmed: true,
          consumed: false,
        }),
        expect.objectContaining({
          type: "book_appt",
          slotHash: "G",
          confirmed: true,
          consumed: true,
        }),
      ]),
    );
  });

  it("uses reducer-created pending booking actions after state confirmation", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({ status: "booked", appointmentId: 12345 }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, state } = createToolContext();
    seedLastAvailabilitySlot(state);
    markBookingConfirmedInState(state, "A");

    const result = await book_appt.execute(bookingArgs(), {
      ctx,
      toolCallId: "test-book",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ status: "booked", appointmentId: 12345 });
    expect(state.flow.pendingActions[0]).toMatchObject({
      type: "book_appt",
      confirmed: true,
      consumed: true,
    });
  });

  it("books when reducer confirmation refers to the offered slot naturally", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({ status: "booked", appointmentId: 12345 }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, state } = createToolContext();
    seedLastAvailabilitySlot(state, {
      slotId: "C",
      spoken: "2026-05-26 8:30 AM with Dr. Bach",
      provider: "Dr. Bach",
      date: "2026-05-26",
      time: "8:30 AM",
      datetime: "2026-05-26T08:30",
    });
    markBookingConfirmedInState(state, "2026-05-26_08:30_bach");

    const result = await book_appt.execute(
      bookingArgs("2026-05-26_08:30_bach"),
      {
        ctx,
        toolCallId: "test-book-natural-slot",
      },
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ status: "booked", appointmentId: 12345 });
    expect(state.flow.schedulingGoal?.selectedSlotId).toBe("C");
    expect(state.flow.pendingActions[0]).toMatchObject({
      type: "book_appt",
      slotHash: "C",
      confirmed: true,
      consumed: true,
    });
  });

  it("does not reject booking when the live context has a shorter post-op reason", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({ status: "booked", appointmentId: 12345 }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, state } = createToolContext();
    seedLastAvailabilitySlot(state, {
      slotId: "B",
      spoken: "2026-06-02 2:00 PM with Dr. Licht",
      provider: "Dr. Licht",
      date: "2026-06-02",
      time: "2:00 PM",
      datetime: "2026-06-02T14:00",
    });
    seedPendingBookingAction(state);
    state.flow.schedulingGoal = {
      patientRef: state.flow.activePatientRef,
      status: "confirming_booking",
      appointmentAction: "schedule",
      visitReason: "Post-op.",
      selectedSlotId: "B",
      bookingConfirmed: true,
      updatedAt: Date.now(),
    };
    markBookingConfirmedInState(state, "B");

    const result = await book_appt.execute(
      {
        slotId: "B",
        appointmentKind: "post_op",
        appointmentReason: "post-op follow-up for dry eye surgery",
        referringDoctor: "Dr. Licht",
      },
      {
        ctx,
        toolCallId: "test-book-post-op-expanded-reason",
      },
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ status: "booked", appointmentId: 12345 });
    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(requestBody).toMatchObject({
      appointmentReason: "post-op follow-up for dry eye surgery",
      referringDoctor: "Dr. Licht",
    });
  });

  it("books a broad post-op reason with no referring doctor", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({ status: "booked", appointmentId: 12345 }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, state } = createToolContext();
    seedLastAvailabilitySlot(state, {
      slotId: "B",
      spoken: "2026-06-02 2:00 PM with Dr. Licht",
      provider: "Dr. Licht",
      date: "2026-06-02",
      time: "2:00 PM",
      datetime: "2026-06-02T14:00",
    });
    seedPendingBookingAction(state);
    state.flow.schedulingGoal = {
      patientRef: state.flow.activePatientRef,
      status: "confirming_booking",
      appointmentAction: "schedule",
      visitReason: "Post-op.",
      selectedSlotId: "B",
      bookingConfirmed: true,
      updatedAt: Date.now(),
    };

    const result = await book_appt.execute(
      {
        slotId: "B",
        appointmentKind: "post_op",
        appointmentReason: "post-op follow-up",
        referringDoctor: "none",
      },
      {
        ctx,
        toolCallId: "test-book-post-op-no-referrer",
      },
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ status: "booked", appointmentId: 12345 });
    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(requestBody).toMatchObject({
      appointmentReason: "post-op follow-up",
      referringDoctor: "none",
    });
  });

  it("books a confirmed post-op slot after the reducer records no referring doctor", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({ status: "booked", appointmentId: 12345 }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, state } = createToolContext();
    seedLastAvailabilitySlot(state, {
      slotId: "B",
      spoken: "2026-06-02 2:00 PM with Dr. Licht",
      provider: "Dr. Licht",
      date: "2026-06-02",
      time: "2:00 PM",
      datetime: "2026-06-02T14:00",
    });
    state.flow.schedulingGoal = {
      patientRef: state.flow.activePatientRef,
      status: "confirming_booking",
      appointmentAction: "schedule",
      visitReason: "post-op visit",
      selectedSlotId: "B",
      bookingConfirmed: true,
      noteDraft: {
        appointmentReason: "post-op visit",
        referringDoctor: "none",
      },
      updatedAt: Date.now(),
    };
    markBookingConfirmedInState(state, "B");

    const result = await book_appt.execute(
      {
        slotId: "B",
        appointmentKind: "post_op",
        appointmentReason: "post-op visit",
        referringDoctor: "none",
      },
      {
        ctx,
        toolCallId: "test-book-reducer-no-referrer",
      },
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ status: "booked", appointmentId: 12345 });
    expect(state.flow.pendingActions[0]).toMatchObject({
      type: "book_appt",
      slotHash: "B",
      confirmed: true,
      consumed: true,
    });
  });

  it("asks only for referring doctor when book_appt is missing it", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, state } = createToolContext();
    seedLastAvailabilitySlot(state);
    markBookingConfirmedInState(state, "A");
    state.flow.schedulingGoal = {
      patientRef: state.flow.activePatientRef,
      status: "confirming_booking",
      appointmentAction: "schedule",
      visitReason: "post-op follow-up",
      selectedSlotId: "A",
      bookingConfirmed: true,
      updatedAt: Date.now(),
    };

    const result = await book_appt.execute(
      {
        slotId: "A",
        appointmentKind: "post_op",
        appointmentReason: "post-op follow-up",
        referringDoctor: "",
      },
      {
        ctx,
        toolCallId: "test-book-missing-referrer",
      },
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      outcome: "needs_clarification",
      nextStep: "collect_visit_reason",
      speak:
        "Ask who referred them, or whether there is no referring doctor. Do not ask for surgery details; the appointment reason is already known.",
      facts: {
        reason: "booking_note_metadata_missing",
        missingFacts: ["referringDoctor"],
      },
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
    await book_appt.execute(bookingArgs(), { ctx, toolCallId: "test-book" });

    const duplicate = await book_appt.execute(bookingArgs(), {
      ctx,
      toolCallId: "test-book-duplicate",
    });

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

  it("reuses cached alternatives for an immediate reschedule after booking", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => ({
        ok: true,
        json: async () => ({ status: "booked", appointmentId: 11111 }),
        text: async () => "",
      }))
      .mockImplementationOnce(async () => ({
        ok: true,
        json: async () => ({ status: "booked", appointmentId: 22222 }),
        text: async () => "",
      }));
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, state } = createToolContext();
    state.flow.routing = "bach_licht";
    state.lastAvailabilityRouting = "bach_licht";
    state.lastAvailabilitySlots = [
      {
        slotId: "A",
        spoken: "2026-06-02 1:30 PM with Dr. Licht",
        provider: "Dr. Licht",
        date: "2026-06-02",
        time: "1:30 PM",
        datetime: "2026-06-02T13:30",
        columnId: 1593,
        profileId: 2064,
        duration: 30,
        routing: "bach_licht",
        bookingToken: "signed-token-a",
      },
      {
        slotId: "D",
        spoken: "2026-06-02 3:00 PM with Dr. Licht",
        provider: "Dr. Licht",
        date: "2026-06-02",
        time: "3:00 PM",
        datetime: "2026-06-02T15:00",
        columnId: 1593,
        profileId: 2064,
        duration: 30,
        routing: "bach_licht",
        bookingToken: "signed-token-d",
      },
    ];
    recordAvailabilitySearch(state.flow, {
      officeKey: "spring-hill",
      visitType: "medical",
      routing: "bach_licht",
      date: "2026-06-01",
    });
    recordAvailabilityCachedSlots(state.flow, [
      { slotId: "A", datetime: "2026-06-02T13:30" },
      { slotId: "D", datetime: "2026-06-02T15:00" },
    ]);
    markBookingConfirmedInState(state, "A");

    await book_appt.execute(bookingArgs("A", "post_op"), {
      ctx,
      toolCallId: "test-book-original",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(state.lastAvailabilitySlots).toEqual([
      expect.objectContaining({ slotId: "D" }),
    ]);
    expect(state.flow.availabilitySearches[0]).toMatchObject({
      status: "satisfied",
      cachedSlots: [expect.objectContaining({ slotHash: "D" })],
    });
    markBookingConfirmedInState(state, "D");

    const replacement = await book_appt.execute(
      {
        slotId: "D",
        appointmentKind: "post_op",
        appointmentReason: "post-op follow-up",
        referringDoctor: "Dr. Licht",
      },
      {
        ctx,
        toolCallId: "test-book-replacement-from-cache",
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(replacement).toMatchObject({
      status: "booked",
      appointmentId: 22222,
    });
    const secondRequestBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(secondRequestBody).toMatchObject({
      bookingToken: "signed-token-d",
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

    await book_appt.execute(bookingArgs(), {
      ctx,
      toolCallId: "test-book-child",
    });

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

    const result = await book_appt.execute(bookingArgs(), {
      ctx,
      toolCallId: "test-book",
    });

    expect(result).toMatchObject({
      status: "error",
      outcome: "invalid_booking_token",
      message: "Invalid or expired booking token.",
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
        bookingToken: "signed-token-a",
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
        bookingToken: "signed-token-b",
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

    const result = await book_appt.execute(bookingArgs(), {
      ctx,
      toolCallId: "test-book",
    });

    expect(result).toMatchObject({
      status: "error",
      outcome: "slot_unavailable",
      message: "Slot is no longer available.",
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

    const result = await book_appt.execute(bookingArgs(), {
      ctx,
      toolCallId: "test-book",
    });

    expect(result).toMatchObject({
      status: "error",
      outcome: "invalid_appointment_type",
      message: "Invalid appointment type for this slot.",
    });
    expect(state.lastAvailabilitySlots).toEqual([]);
    expect(state.flow.availabilitySearches[0]).toMatchObject({
      status: "invalidated",
      lastInvalidationReason: "appointment_type_invalid",
    });
  });

  it("asks for missing details when middleware cannot resolve appointment type", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({
        status: "error",
        outcome: "appointment_type_unresolved",
        missing: ["dob"],
        message: "Verify the patient's DOB before booking.",
      }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, state } = createToolContext();
    seedLastAvailabilitySlot(state);
    seedPendingBookingAction(state);

    const result = await book_appt.execute(bookingArgs(), {
      ctx,
      toolCallId: "test-book-unresolved-type",
    });

    expect(result).toMatchObject({
      status: "error",
      outcome: "appointment_type_unresolved",
      missing: ["dob"],
      message: "Verify the patient's DOB before booking.",
    });
    expect(state.flow.step).toBe("verify_patient");
    expect(state.lastAvailabilitySlots).toHaveLength(1);
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
    await book_appt.execute(bookingArgs(), { ctx, toolCallId: "test-book" });
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

  it("uses state-owned routing for availability when stale model args include routing", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({
        status: "success",
        outcome: "no_availability",
        availabilityFound: false,
        slots: [],
      }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, state } = createToolContext();
    state.routing = "all_three";
    state.flow.routing = "all_three";

    const staleArgs = {
      date: "2026-04-28",
      routing: "optical_only",
    } as unknown as Parameters<typeof get_availability.execute>[0];
    await get_availability.execute(staleArgs, {
      ctx,
      toolCallId: "test-availability-state-routing",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(requestBody).toMatchObject({
      date: "2026-04-28",
      dob: "01/01/1980",
      routing: "all_three",
    });
    expect(requestBody.routing).not.toBe("optical_only");
    expect(state.lastAvailabilityRouting).toBe("all_three");
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
        referringDoctor: "Dr. Smith",
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

  it("allows notes after a successful booking", async () => {
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
    state.patientId = "17603880";
    state.flow.patients[state.flow.activePatientRef!].patientId = "17603880";
    seedLastAvailabilitySlot(state);
    seedPendingBookingAction(state);

    await book_appt.execute(bookingArgs(), {
      ctx,
      toolCallId: "test-book-before-note",
    });
    const noteResult = await add_patient_note.execute(
      {
        appointmentReason: "blurry vision",
        referringDoctor: "none",
      },
      { ctx, toolCallId: "test-note-after-booking" },
    );

    expect(noteResult).toMatchObject({
      status: "saved",
      noteId: "note-1",
    });
    expect(state.flow.pendingActions).toContainEqual(
      expect.objectContaining({
        type: "book_appt",
        consumed: true,
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("sends appointment kind intent instead of raw appointment type IDs", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({ status: "booked", appointmentId: 12345 }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, state } = createToolContext();
    seedLastAvailabilitySlot(state);
    seedPendingBookingAction(state);

    await book_appt.execute(bookingArgs("A", "post_op"), {
      ctx,
      toolCallId: "test-book-post-op",
    });

    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(requestBody).toMatchObject({
      bookingToken: "signed-token",
      visitCategory: "medical",
      visitKind: "post_op",
      isPostOp: true,
      patientStatus: "established",
    });
    expect(requestBody).not.toHaveProperty("appointmentTypeId");
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
    seedPendingSideEffectAction(state, "route_to_spring_hill");
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
      bookingToken: "routine-vision-token",
      columnId: 1600,
      profileId: 1983,
      datetime: "2026-04-28T10:00",
      duration: 45,
      routing: "optical_only",
    });
    seedPendingBookingAction(state);

    await book_appt.execute(bookingArgs("A", "routine_vision"), {
      ctx,
      toolCallId: "test-book",
    });

    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({
      bookingToken: "routine-vision-token",
      visitCategory: "routine_vision",
      visitKind: "routine_vision",
      patientStatus: "established",
      patientId: "patient-1",
      routing: "optical_only",
    });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).not.toHaveProperty(
      "appointmentTypeId",
    );
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).not.toHaveProperty(
      "office",
    );
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
    expect(verifyBody).not.toHaveProperty("relationshipToCaller");
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
        source: "tool_result",
        confirmed: true,
      },
      lastName: {
        value: "Danehe",
        source: "tool_result",
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
    });
    expect(result).not.toHaveProperty("outcome");
    expect(result).not.toHaveProperty("middlewareResult");
  });

  it("accepts a direct registration readback confirmation before add_patient", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        status: "created",
        patientId: "patient-2",
        name: "Doe, Jane",
        dob: "01/01/1980",
        routing: "bach_only",
        allowedProviders: ["Dr. Bach"],
        appointments: [],
      }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, state } = createToolContext();
    resetToNewPatientRegistration(state, "Yes, it is.");
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
      insurance: "Humana Healthy Horizons",
      subscriberName: "Jane Doe",
      subscriberNum: "ABC123",
    };

    const result = await add_patient.execute(params, {
      ctx,
      toolCallId: "test-add-readback-confirmed",
    });

    expect(result).toMatchObject({
      status: "created",
      patientId: "patient-2",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      insurance: "Humana Healthy Horizons",
      phone: "+17275551212",
      subscriberNum: "ABC123",
    });
    expect(state.flowGuardObservations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolName: "add_patient",
          allowed: true,
          reason: "allowed",
        }),
      ]),
    );
    expect(state.flow.pendingActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "add_patient",
          confirmed: true,
          consumed: true,
        }),
      ]),
    );
  });

  it("still blocks add_patient when yes did not confirm a registration readback", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, state } = createToolContext();
    resetToNewPatientRegistration(state, "Yes, I have one.");
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
      insurance: "Humana Healthy Horizons",
      subscriberName: "Jane Doe",
      subscriberNum: "ABC123",
    };

    const result = await add_patient.execute(params, {
      ctx,
      toolCallId: "test-add-unconfirmed",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      outcome: "not_allowed",
      nextStep: "collect_registration",
      facts: {
        reason: "side_effect_confirmation_required",
        confirmationRecorded: "pending",
      },
    });
    expect(state.flow.pendingActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "add_patient",
          confirmed: false,
          consumed: false,
        }),
      ]),
    );
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

  it("records pending cancellation confirmation when a loaded appointment needs readback", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, state } = createToolContext();
    seedLoadedAppointment(state, 12345);

    const result = await cancel_appt.execute(
      { appointmentId: 12345 },
      { ctx, toolCallId: "test-cancel-confirmation-request" },
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      outcome: "not_allowed",
      nextStep: "confirm_cancel",
      facts: {
        reason: "cancel_confirmation_not_tracked",
        confirmationRecorded: "pending",
      },
    });
    expect(state.flow.pendingConfirmation).toMatchObject({
      type: "cancel",
      payload: { appointmentId: 12345 },
    });
    expect(state.flow.pendingActions).toContainEqual(
      expect.objectContaining({
        type: "cancel_appt",
        appointmentId: 12345,
        confirmed: false,
        consumed: false,
      }),
    );
  });

  it("refreshes a missing cancel token for a loaded appointment before cancelling", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => ({
        ok: true,
        json: async () => ({
          status: "verified",
          patientId: "patient-1",
          appointmentsStatus: "found",
          appointments: [
            {
              id: 12345,
              date: "2026-06-01",
              time: "9:00 AM",
              provider: "Dr. Bach",
              type: "Follow-up",
              facility: "Spring Hill",
              confirmed: true,
              cancelToken: "fresh-cancel-token",
            },
          ],
        }),
        text: async () => "",
      }))
      .mockImplementationOnce(async () => ({
        ok: true,
        json: async () => ({ status: "cancelled" }),
        text: async () => "",
      }));
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, state } = createToolContext();
    seedLoadedAppointment(state, 12345, null);
    seedConfirmedCancelAction(state, 12345);

    const result = await cancel_appt.execute(
      { appointmentId: 12345 },
      { ctx, toolCallId: "test-cancel-missing-token" },
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      patientId: "patient-1",
    });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({
      appointmentId: 12345,
      patientId: "patient-1",
      cancelToken: "fresh-cancel-token",
    });
    expect(result).toMatchObject({
      status: "cancelled",
    });
    expect(state.appointments).toEqual([]);
    expect(state.appointmentCancelTokens).not.toHaveProperty("12345");
  });

  it("cancels confirmed pre-call patients without re-verifying", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({ status: "cancelled" }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, state } = createToolContext();
    state.patientId = null;
    state.patientName = null;
    state.dob = null;
    state.flow = createInitialFlowState({
      officeKey: "spring-hill",
      patientId: "precall-patient",
      patientName: "Linda Dow",
      dob: "05/14/1958",
      routing: "all_three",
      coverageType: "medical",
      appointments: [],
      appointmentsStatus: "none",
      preCall: {
        status: "single_match_confirmed",
        source: "phone_lookup",
        callerPhone: "+17275551212",
        candidates: [
          {
            ref: "caller",
            firstName: "Linda",
            lastName: "Dow",
            dob: "05/14/1958",
            patientId: "precall-patient",
            relationshipToCaller: "self",
            appointments: [],
            appointmentsStatus: "none",
          },
        ],
        selectedCandidateRef: "caller",
        identityPromotion: "first_name_confirmed",
      },
    });
    state.flow.visitType = "medical";
    state.flow.step = "confirm_cancel";
    seedLoadedAppointment(state, 12345);
    seedConfirmedCancelAction(state, 12345);

    const result = await cancel_appt.execute(
      { appointmentId: 12345 },
      { ctx, toolCallId: "test-cancel-precall" },
    );

    expect(result).toMatchObject({ status: "cancelled" });
    expect(fetchMock).toHaveBeenCalledOnce();
    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(requestBody).toMatchObject({
      appointmentId: 12345,
      patientId: "precall-patient",
      cancelToken: "cancel-token-12345",
    });
    expect(state.flow.patients.caller).toMatchObject({
      status: "verified",
      patientId: "precall-patient",
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
    seedConfirmedCancelAction(state, 12345);

    const cancelResult = await cancel_appt.execute(
      { appointmentId: 12345 },
      { ctx, toolCallId: "test-cancel" },
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(requestBody).toMatchObject({
      appointmentId: 12345,
      patientId: "patient-1",
      cancelToken: "cancel-token-12345",
    });
    expect(requestBody).not.toHaveProperty("office");
    expect(cancelResult).toMatchObject({
      status: "cancelled",
    });
    expect(state.flow.pendingActions[0]).toMatchObject({
      type: "cancel_appt",
      appointmentId: 12345,
      confirmed: true,
      consumed: true,
    });
    expect(state.appointments).toEqual([]);
    expect(state.appointmentCancelTokens).not.toHaveProperty("12345");
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
    seedConfirmedCancelAction(state, 12345);

    const result = await cancel_appt.execute(
      { appointmentId: 12345 },
      { ctx, toolCallId: "test-cancel-not-found" },
    );

    expect(result).toMatchObject({
      status: "not_found",
    });
    expect(state.appointments).toHaveLength(1);
    expect(state.appointmentCancelTokens).toMatchObject({
      "12345": "cancel-token-12345",
    });
    expect(state.flow.pendingActions[0]).toMatchObject({
      type: "cancel_appt",
      consumed: false,
    });
  });

  it("maps invalid cancel-token responses to reload-and-confirm guidance", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      json: async () => ({
        status: "error",
        message:
          "Invalid or expired cancel token. Please load appointments again and choose the appointment to cancel.",
      }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, state } = createToolContext();
    seedLoadedAppointment(state, 12345);
    seedConfirmedCancelAction(state, 12345);

    const result = await cancel_appt.execute(
      { appointmentId: 12345 },
      { ctx, toolCallId: "test-cancel-invalid-token" },
    );

    expect(result).toMatchObject({
      status: "error",
      message:
        "Invalid or expired cancel token. Please load appointments again and choose the appointment to cancel.",
    });
    expect(state.appointments).toHaveLength(1);
  });

  it("returns already-cancelled middleware payload directly while updating state as resolved", async () => {
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
    seedConfirmedCancelAction(state, 12345);

    const result = await cancel_appt.execute(
      { appointmentId: 12345 },
      { ctx, toolCallId: "test-cancel-already-cancelled" },
    );

    expect(result).toMatchObject({
      status: "error",
      message: "appointment already cancelled",
    });
    expect(result).not.toHaveProperty("middlewareResult");
    expect(state.appointments).toEqual([]);
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
    seedConfirmedCancelAction(state, 12345);

    const result = await cancel_appt.execute(
      { appointmentId: 12345 },
      { ctx, toolCallId: "test-cancel" },
    );

    expect(result).toMatchObject({
      status: "cancelled",
    });
    expect(state.flow.currentTask?.id).toBe(scheduleTask.id);
    expect(state.flow.activeFlow).toBe("scheduling");
  });

  it("submits reschedule as replacement booking followed by old cancellation", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => ({
        ok: true,
        json: async () => ({
          status: "booked",
          appointmentId: 67890,
          providerName: "Dr. J. Licht",
          locationName: "Spring Hill",
          appointmentTypeName: "Follow-up",
        }),
        text: async () => "",
      }))
      .mockImplementationOnce(async () => ({
        ok: true,
        json: async () => ({ status: "cancelled" }),
        text: async () => "",
      }));
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, state } = createToolContext();
    seedLoadedAppointment(state, 12345);
    seedLastAvailabilitySlot(state, { bookingToken: "replacement-token" });
    state.flow.activeIntent = "existing_appointment_reschedule";
    state.flow.activeFlow = "appointment_management";
    state.flow.visitType = "medical";
    state.flow.coverageType = "medical";
    state.flow.schedulingGoal = {
      patientRef: "caller",
      status: "confirming_booking",
      appointmentAction: "reschedule",
      preferredWindow: "Monday at 1 PM",
      selectedSlotId: "A",
      bookingConfirmed: true,
      noteDraft: {
        appointmentReason: "pressure follow-up",
        referringDoctor: "none",
      },
      evidence: ["Dr. Bach", "Monday at 1 PM"],
      updatedAt: Date.now(),
    };
    recordAvailabilitySearch(state.flow, {
      patientRef: "caller",
      officeKey: "spring-hill",
      visitType: "medical",
      coverageType: "medical",
      routing: "all_three",
      date: "2026-04-28",
    });
    recordAvailabilityCachedSlots(state.flow, [{ slotId: "A" }]);
    seedPendingBookingAction(state);
    applyPlannerCommand(state.flow, planNextCommand(state.flow));

    const bookingResult = await book_appt.execute(
      {
        slotId: "A",
        appointmentKind: "medical",
        appointmentReason: "pressure follow-up",
        referringDoctor: "none",
      },
      { ctx, toolCallId: "test-book-replacement" },
    );

    expect(bookingResult).toMatchObject({
      status: "booked",
      planner: {
        nextAction: "cancel_appt",
        tool: "cancel_appt",
        args: { appointmentId: 12345 },
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      bookingToken: "replacement-token",
      patientId: "patient-1",
      appointmentReason: "pressure follow-up",
      referringDoctor: "none",
    });
    expect(state.flow.pendingActions).toContainEqual(
      expect.objectContaining({
        type: "book_appt",
        slotHash: "A",
        confirmed: true,
        consumed: true,
      }),
    );
    const activePlan = state.flow.taskPlans?.[state.flow.activeTaskPlanId!];
    expect(activePlan).toMatchObject({
      kind: "appointment_reschedule",
      replacementBookedAppointmentId: 67890,
      oldCancelled: false,
    });

    const cancelResult = await cancel_appt.execute(
      { appointmentId: 12345 },
      { ctx, toolCallId: "test-cancel-old-appointment" },
    );

    expect(cancelResult).toMatchObject({
      status: "cancelled",
      planner: {
        action: "complete",
        phase: "complete",
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({
      appointmentId: 12345,
      patientId: "patient-1",
      cancelToken: "cancel-token-12345",
    });
    expect(state.flow.pendingActions).toContainEqual(
      expect.objectContaining({
        type: "cancel_appt",
        appointmentId: 12345,
        confirmed: true,
        consumed: true,
      }),
    );
    expect(state.appointments.map((appointment) => appointment.id)).toEqual([
      67890,
    ]);
  });

  it("starts transfer without a separate confirmation step", async () => {
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
    expect(state.flow.pendingConfirmation).toBeUndefined();
  });

  it("consumes reducer-recorded transfer intent when the tool succeeds", async () => {
    transferSipParticipantMock.mockResolvedValue(undefined);
    const { ctx, state } = createToolContext();

    const understanding = inferObviousTurnUnderstanding(
      state.flow,
      "Representative.",
    );
    expect(understanding).toMatchObject({
      goal: "transfer_request",
    });
    if (!understanding) throw new Error("expected transfer intent");

    reduceFlowEvent(
      state.flow,
      callerTurnMeaningEvent({
        transcript: "Representative.",
        understanding,
        flow: state.flow,
      }),
    );

    const result = await transfer_call.execute(
      {},
      { ctx, toolCallId: "test-transfer-intent" },
    );

    expect(transferSipParticipantMock).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      outcome: "success",
      nextStep: "handoff",
    });
    expect(state.flow.pendingActions[0]).toMatchObject({
      type: "transfer_call",
      confirmed: true,
      consumed: true,
    });
  });

  it("consumes reducer-confirmed pending transfer actions", async () => {
    transferSipParticipantMock.mockResolvedValue(undefined);
    const { ctx, state, speechHandle } = createToolContext();
    seedPendingSideEffectAction(state, "transfer_call");

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
          return book_appt.execute(bookingArgs(), {
            ctx,
            toolCallId: "test-book",
          });
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
          book_appt.execute(bookingArgs(), { ctx, toolCallId: "test-book" }),
      },
    ];

    for (const testCase of cases) {
      const { ctx, state } = createInterruptedToolContext();
      testCase.setup?.(state);

      const result = await testCase.run(ctx);

      expectInterruptedOutcome(result, testCase.name);
      if (testCase.name === "book_appt") {
        expect(state.flow.pendingActions, testCase.name).toContainEqual(
          expect.objectContaining({
            type: "book_appt",
            confirmed: true,
            consumed: false,
          }),
        );
      } else {
        expect(state.flow.pendingActions, testCase.name).toEqual([]);
      }
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
      appointmentsStatus: null,
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
    bookableAvailabilitySlots: [],
    availabilitySlotSequence: 0,
    allowedProviders: [],
    routingAmbiguous: false,
    preauthRequired: false,
    appointmentsStatus: null,
    appointments: [],
    appointmentCancelTokens: {},
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

function seedPendingSinglePreCallCaller(state: CallState) {
  state.officeKey = "hollywood";
  state.amdOfficePhone = HOLLYWOOD_OFFICE_PHONE;
  state.trunkPhone = HOLLYWOOD_OFFICE_PHONE;
  state.callerPhone = "+12018031225";
  state.patientId = "17603706";
  state.patientName = "DOW,LINDA J";
  state.dob = "05/14/1958";
  state.insuranceCarrier = "FLORIDA MEDICARE";
  state.checkedInsurancePlan = "FLORIDA MEDICARE";
  state.routing = "bach_only";
  state.appointments = [];
  state.appointmentsStatus = "none";
  state.flow = createInitialFlowState({
    officeKey: "hollywood",
    patientId: "17603706",
    patientName: "DOW,LINDA J",
    dob: "05/14/1958",
    callerPhone: "+12018031225",
    appointments: [],
    appointmentsStatus: "none",
    routing: "bach_only",
    preCall: {
      status: "single_match_pending_confirmation",
      source: "phone_lookup",
      callerPhone: "+12018031225",
      candidates: [
        {
          ref: "caller",
          firstName: "LINDA",
          lastName: "DOW",
          dob: "05/14/1958",
          patientId: "17603706",
          relationshipToCaller: "self",
          appointments: [],
          appointmentsStatus: "none",
        },
      ],
      selectedCandidateRef: "caller",
      appointmentLoadStatus: "none",
      identityPromotion: "none",
    },
  });
  state.flow.step = "verify_patient";
}

type AvailabilitySlotOverrides = Omit<
  Partial<CallState["lastAvailabilitySlots"][number]>,
  "bookingToken"
> & {
  bookingToken?: string | null;
};

function seedLastAvailabilitySlot(
  state: CallState,
  overrides: AvailabilitySlotOverrides = {},
) {
  const routing = overrides.routing ?? "all_three";
  const bookingToken =
    overrides.bookingToken === null
      ? undefined
      : (overrides.bookingToken ?? "signed-token");
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
      ...(bookingToken ? { bookingToken } : {}),
    },
  ];
}

function markBookingConfirmedInState(state: CallState, slotId = "A") {
  const existing = state.flow.schedulingGoal;
  const appointmentReason =
    existing?.noteDraft?.appointmentReason ??
    existing?.visitReason ??
    "blurry vision";
  const referringDoctor = existing?.noteDraft?.referringDoctor ?? "none";
  const confirmedSlotId =
    (state.bookableAvailabilitySlots ?? state.lastAvailabilitySlots).find(
      (slot) => slot.slotId === slotId,
    )?.slotId ??
    (state.lastAvailabilitySlots.length === 1
      ? state.lastAvailabilitySlots[0].slotId
      : slotId);
  state.flow.routing =
    state.flow.routing ??
    state.lastAvailabilityRouting ??
    state.lastAvailabilitySlots[0]?.routing ??
    "all_three";
  reduceFlowEvent(
    state.flow,
    callerTurnMeaningEvent({
      transcript: "yes",
      flow: state.flow,
      source: "deterministic_understanding",
      understanding: {
        goal: "schedule",
        appointmentAction: null,
        scheduling: {
          selectedSlotId: confirmedSlotId,
          bookingConfirmed: true,
          note: {
            appointmentReason,
            referringDoctor,
          },
        },
        interruption: "none",
        confidence: 0.95,
        evidence: ["yes"],
      },
    }),
  );
  state.flow.schedulingGoal = {
    ...(state.flow.schedulingGoal ?? {
      status: "confirming_booking",
      updatedAt: Date.now(),
    }),
    status: "confirming_booking",
    patientRef: state.flow.activePatientRef,
    appointmentAction: "schedule",
    visitReason: state.flow.schedulingGoal?.visitReason ?? appointmentReason,
    noteDraft: state.flow.schedulingGoal?.noteDraft ?? {
      appointmentReason,
      referringDoctor,
    },
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
    ...(overrides.appointmentTypeId !== undefined
      ? { appointmentTypeId: overrides.appointmentTypeId }
      : {}),
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

function seedConfirmedCancelAction(state: CallState, appointmentId = 12345) {
  return createPendingSideEffectAction(state.flow, {
    type: "cancel_appt",
    argsHash: hashToolArgs({ appointmentId }),
    spokenSummary: `confirmed cancel_appt`,
    patientRef: state.flow.activePatientRef,
    appointmentId,
    confirmed: true,
    createdTurnId: "test-create-cancel_appt",
    confirmationTurnId: "test-confirm-cancel_appt",
  });
}

function seedLoadedAppointment(
  state: CallState,
  appointmentId = 12345,
  cancelToken: string | null = `cancel-token-${appointmentId}`,
) {
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
  state.appointmentsStatus = "found";
  const activePatient = state.flow.patients[state.flow.activePatientRef!];
  activePatient.appointments = [
    ...activePatient.appointments.filter((item) => item.id !== appointmentId),
    appointment,
  ];
  activePatient.appointmentsStatus = "found";
  state.appointmentCancelTokens ??= {};
  if (cancelToken) {
    state.appointmentCancelTokens[String(appointmentId)] = cancelToken;
  } else {
    delete state.appointmentCancelTokens[String(appointmentId)];
  }
}

function resetToUnverifiedAppointmentTask(
  state: CallState,
  transcript: string,
) {
  state.flow = createInitialFlowState({
    officeKey: "spring-hill",
  });
  state.patientId = null;
  state.patientName = null;
  state.dob = null;
  state.appointments = [];
  state.appointmentsStatus = null;
  state.appointmentCancelTokens = {};
  state.latestUserTranscript = transcript;
  state.turnUnderstandingAppliedForTranscript = null;
}

function resetToNewPatientRegistration(state: CallState, transcript: string) {
  state.flow = createInitialFlowState({
    officeKey: "spring-hill",
  });
  state.flow.activeFlow = "scheduling";
  state.flow.activeIntent = "new_patient_registration";
  state.flow.step = "collect_registration";
  state.flow.patientStatus = "new";
  state.flow.visitType = "medical";
  state.flow.coverageType = "medical";
  state.flow.patients.caller.status = "new";
  state.flow.patients.caller.patientId = undefined;
  state.patientId = null;
  state.patientName = null;
  state.dob = null;
  state.insuranceCarrier = null;
  state.insPlanId = null;
  state.respPartyId = null;
  state.checkedInsurancePlan = "Humana Healthy Horizons";
  state.checkedInsuranceCoverageType = "medical";
  state.routing = null;
  state.allowedProviders = [];
  state.appointments = [];
  state.appointmentsStatus = null;
  state.appointmentCancelTokens = {};
  state.latestUserTranscript = transcript;
  state.turnUnderstandingAppliedForTranscript = null;
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
