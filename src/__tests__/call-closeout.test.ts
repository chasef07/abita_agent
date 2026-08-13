import {
  ChatContext,
  createSessionReport,
  type AgentSession,
  type JobContext,
} from "@livekit/agents";
import { describe, expect, it, vi } from "vitest";
import {
  HttpCallPortal,
  InMemoryCallPortal,
  attachCallCloseout,
  attachStartupCallCloseout,
  createLiveKitCallCloseoutEventAdapter,
  type CallCloseoutCapture,
  type CallCloseoutEventAdapter,
  type CallCloseoutObserver,
  type CallCloseoutResult,
} from "../runtime/call-closeout.js";
import { getOfficeProfileByPhone } from "../customers/abita/profile.js";
import {
  getProductInteractionConfig,
  validateProductConfig,
} from "../runtime/portal-auth.js";
import {
  recordPatientIdentityTransition,
  type CallState,
} from "../state/call-state.js";
import {
  acceptTransfer,
  beginTransfer,
  markTransferAmbiguous,
} from "../state/call-lifecycle.js";
import {
  recordAvailabilityReadEvent,
  recordAppointmentAction,
  recordOfficeKnowledgeRetrieval,
  recordOwnedMiddlewareFailure,
} from "../state/observability.js";
import {
  confirmedActivePatient,
  createTestCallState,
} from "./support/call-state.js";

class TestLiveKitEvents implements CallCloseoutEventAdapter {
  private closeout: (() => Promise<CallCloseoutResult>) | undefined;
  private observer: CallCloseoutObserver | undefined;

  capture = async (): Promise<CallCloseoutCapture> => ({
    language: {
      currentLanguage: "en",
      languageChanged: false,
    },
    sessionReport: { chat_history: { items: [] } },
    sessionUsage: { modelUsage: [] },
    sttProfiles: [],
  });

  observe(observer: CallCloseoutObserver): void {
    this.observer = observer;
  }

  onClose(closeout: () => Promise<CallCloseoutResult>): void {
    this.closeout = closeout;
  }

  async close(): Promise<CallCloseoutResult | undefined> {
    return this.closeout?.();
  }

  emit(method: string, event: unknown): void {
    const callback = Reflect.get(this.observer ?? {}, method) as unknown;
    if (typeof callback === "function") callback(event);
  }

  reachDurationLimit(): void {
    this.emit("durationLimitReached", undefined);
  }
}

type CallContext = Parameters<typeof attachCallCloseout>[0]["call"];

const DEFAULT_CALL: CallContext = {
  callId: "call-test",
  callerPhone: "+17275551212",
  fallbackModel: "fallback/model",
  initialVoiceLanguage: {
    current: "en",
    speaker: "wawona",
    ttsLanguage: "en",
    ttsProvider: "rime-inference",
  },
  livekitContext: {},
  officePhone: "+17275919997",
  startedAt: new Date("2026-07-20T10:00:00.000Z"),
};

async function setupCloseout(
  options: {
    call?: Partial<CallContext>;
    events?: TestLiveKitEvents;
    getCallState?: () => CallState | null;
    logger?: Pick<Console, "warn">;
    now?: () => Date;
    portal?: InMemoryCallPortal;
    state?: CallState | null;
  } = {},
) {
  const state =
    options.state === undefined ? createTestCallState() : options.state;
  const events = options.events ?? new TestLiveKitEvents();
  const portal = options.portal ?? new InMemoryCallPortal();
  const attachment = await attachCallCloseout({
    call: { ...DEFAULT_CALL, ...options.call },
    events,
    getCallState: options.getCallState ?? (() => state),
    logger: options.logger,
    now: options.now ?? (() => new Date("2026-07-20T10:01:00.000Z")),
    portal,
  });
  return { attachment, events, portal, state };
}

describe("call closeout", () => {
  it.each([
    ["+19999999999", "Unsupported trunk phone number: +19999999999"],
    [
      "not-a-phone-number",
      "Unsupported trunk phone number: not-a-phone-number",
    ],
    ["", "Unsupported trunk phone number: (empty)"],
  ])(
    "registers and closes out startup before rejecting trunk %j",
    async (trunkPhone, expectedError) => {
      const portal = new InMemoryCallPortal();
      let startupShutdown: (() => Promise<void>) | undefined;
      const startSession = vi.fn(async () => undefined);

      await expect(
        (async () => {
          await attachStartupCallCloseout({
            call: {
              callId: "call-unsupported-trunk",
              callerPhone: "+17275551212",
              livekitContext: { roomName: "room-test" },
              officePhone: trunkPhone,
              startedAt: new Date("2026-07-20T10:00:00.000Z"),
            },
            now: () => new Date("2026-07-20T10:01:00.000Z"),
            portal,
            registerShutdownCallback: (closeout) => {
              startupShutdown = closeout;
            },
          });
          expect(portal.deliveries.map(({ phase }) => phase)).toEqual([
            "call-start",
          ]);
          getOfficeProfileByPhone(trunkPhone);
          await startSession();
        })(),
      ).rejects.toThrow(expectedError);

      expect(startSession).not.toHaveBeenCalled();
      await startupShutdown?.();
      expect(portal.deliveries.map(({ phase }) => phase)).toEqual([
        "call-start",
        "shutdown-summary",
        "shutdown",
      ]);
      expect(portal.deliveries[1]?.payload).toMatchObject({
        endedReason: "call_state_not_initialized",
        status: "FAILED",
      });
    },
  );

  it("hands a registered call start to the full closeout lifecycle", async () => {
    const events = new TestLiveKitEvents();
    const portal = new InMemoryCallPortal();
    let startupShutdown: (() => Promise<void>) | undefined;

    const callStart = await attachStartupCallCloseout({
      call: DEFAULT_CALL,
      portal,
      registerShutdownCallback: (closeout) => {
        startupShutdown = closeout;
      },
    });
    await attachCallCloseout({
      call: DEFAULT_CALL,
      events,
      getCallState: createTestCallState,
      onCloseoutAttached: callStart.handOffToCallCloseout,
      portal,
      startResult: callStart.startResult,
    });
    await events.close();
    await startupShutdown?.();

    expect(portal.deliveries.map(({ phase }) => phase)).toEqual([
      "call-start",
      "shutdown-summary",
      "shutdown",
    ]);
  });

  it("closes a registered call start when shutdown begins during initialization", async () => {
    const portal = new InMemoryCallPortal();
    let startupShutdown: (() => Promise<void>) | undefined;
    const startSession = vi.fn(async () => undefined);

    await attachStartupCallCloseout({
      call: DEFAULT_CALL,
      now: () => new Date("2026-07-20T10:01:00.000Z"),
      portal,
      registerShutdownCallback: (closeout) => {
        startupShutdown = closeout;
      },
    });
    expect(startupShutdown).toBeTypeOf("function");
    await Promise.all([startupShutdown?.(), startupShutdown?.()]);

    expect(startSession).not.toHaveBeenCalled();
    expect(portal.deliveries.map(({ phase }) => phase)).toEqual([
      "call-start",
      "shutdown-summary",
      "shutdown",
    ]);
  });

  it("routes call evidence to Product with the selected tenant secret", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 200 }),
    ) as unknown as typeof fetch;
    const config = getProductInteractionConfig("spring-hill", {
      ABITA_EYE_GROUP_PRODUCT_SERVICE_SECRET: " product-secret ",
      ACUITY_PRODUCT_INTERACTION_URL:
        " https://product.example/v1/ai/interactions ",
    });
    expect(config).toEqual({
      secret: "product-secret",
      url: "https://product.example/v1/ai/interactions",
    });
    const portal = new HttpCallPortal({ ...config, fetchImpl });

    await portal.deliver({
      phase: "call-start",
      timeoutMs: 2_000,
      payload: {
        callId: "call-cutover-63",
        callerPhone: "+17275550199",
        officePhone: "+17275919997",
        startedAt: "2026-08-08T09:30:00.000Z",
        status: "IN_PROGRESS",
      },
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetchImpl).mock.calls[0]?.[0]).toBe(
      "https://product.example/v1/ai/interactions",
    );
  });

  it("requires Product delivery configuration in production", () => {
    expect(() =>
      validateProductConfig({
        NODE_ENV: "production",
        ACUITY_PRODUCT_INTERACTION_URL:
          "https://product.example/v1/ai/interactions",
        ACUITY_DEMO_PRODUCT_SERVICE_SECRET: "demo-secret",
      }),
    ).toThrow(
      "ACUITY_PRODUCT_INTERACTION_URL, ACUITY_PRODUCT_HANDOFF_URL, ACUITY_DEMO_PRODUCT_SERVICE_SECRET, ACUITY_DEMO_PRODUCT_PRACTICE_ID, ABITA_EYE_GROUP_PRODUCT_SERVICE_SECRET, ABITA_EYE_GROUP_PRODUCT_PRACTICE_ID are required in production",
    );
    expect(() =>
      validateProductConfig({
        NODE_ENV: "production",
        ACUITY_PRODUCT_INTERACTION_URL:
          "https://product.example/v1/ai/interactions",
        ACUITY_PRODUCT_HANDOFF_URL: "https://product.example/v1/handoffs",
        ACUITY_DEMO_PRODUCT_PRACTICE_ID: "00000000-0000-0000-0000-000000000001",
        ACUITY_DEMO_PRODUCT_SERVICE_SECRET: "demo-secret",
        ABITA_EYE_GROUP_PRODUCT_PRACTICE_ID:
          "00000000-0000-0000-0000-000000000002",
        ABITA_EYE_GROUP_PRODUCT_SERVICE_SECRET: "production-secret",
      }),
    ).not.toThrow();
    expect(() =>
      getProductInteractionConfig("spring-hill", {
        NODE_ENV: "production",
        ACUITY_PRODUCT_INTERACTION_URL:
          "https://product.example/v1/ai/interactions",
      }),
    ).toThrow(
      "ACUITY_PRODUCT_INTERACTION_URL and ABITA_EYE_GROUP_PRODUCT_SERVICE_SECRET are required for spring-hill Product interactions",
    );
    expect(() =>
      getProductInteractionConfig("dev", {
        NODE_ENV: "production",
        ACUITY_PRODUCT_INTERACTION_URL:
          "https://product.example/v1/ai/interactions",
      }),
    ).toThrow(
      "ACUITY_PRODUCT_INTERACTION_URL and ACUITY_DEMO_PRODUCT_SERVICE_SECRET are required for dev Product interactions",
    );
    expect(
      getProductInteractionConfig("dev", {
        NODE_ENV: "production",
        ACUITY_PRODUCT_INTERACTION_URL:
          "https://product.example/v1/ai/interactions",
        ACUITY_DEMO_PRODUCT_SERVICE_SECRET: "demo-secret",
        ABITA_EYE_GROUP_PRODUCT_SERVICE_SECRET: "production-secret",
      }),
    ).toEqual({
      secret: "demo-secret",
      url: "https://product.example/v1/ai/interactions",
    });
    expect(
      getProductInteractionConfig("spring-hill", {
        NODE_ENV: "production",
        ACUITY_PRODUCT_INTERACTION_URL:
          "https://product.example/v1/ai/interactions",
        ACUITY_DEMO_PRODUCT_SERVICE_SECRET: "demo-secret",
        ABITA_EYE_GROUP_PRODUCT_SERVICE_SECRET: "production-secret",
      }),
    ).toEqual({
      secret: "production-secret",
      url: "https://product.example/v1/ai/interactions",
    });
  });

  it("delivers call start, compact completion, and rich completion in order", async () => {
    const { events, portal, state } = await setupCloseout();
    await events.close();

    expect(portal.deliveries.map(({ phase }) => phase)).toEqual([
      "call-start",
      "shutdown-summary",
      "shutdown",
    ]);
    expect(portal.deliveries[0]?.payload).toMatchObject({
      callId: "call-test",
      startedAt: "2026-07-20T10:00:00.000Z",
      status: "IN_PROGRESS",
    });
    expect(portal.deliveries[1]?.payload).toMatchObject({
      durationSec: 60,
      status: "COMPLETED",
    });
    expect(portal.deliveries[2]?.payload).toMatchObject({
      callState: {
        office: state?.office,
        insurance: state?.insurance,
        workflow: state?.workflow,
      },
      preCallLookup: state?.runtime.preCallLookup,
      sessionReport: { chat_history: { items: [] } },
      status: "COMPLETED",
      usage: { modelUsage: [] },
    });
    expect(portal.deliveries[1]?.payload).not.toHaveProperty("callState");
    expect(portal.deliveries[1]?.payload).not.toHaveProperty("sessionReport");
  });

  it("delivers PHI-free availability read telemetry", async () => {
    const state = createTestCallState({
      activePatient: confirmedActivePatient({
        patientId: "private-patient-id",
      }),
    });
    recordAvailabilityReadEvent(state, {
      operation: "middleware_call",
      durationMs: 125,
    });
    recordAvailabilityReadEvent(state, {
      operation: "completed_cache_hit",
      durationMs: 0,
    });
    recordAvailabilityReadEvent(state, {
      operation: "invalidation",
      reason: "patient_context_changed",
    });
    const { events, portal } = await setupCloseout({ state });

    await events.close();

    for (const delivery of portal.deliveries.slice(1)) {
      expect(delivery.payload.availabilityReads).toMatchObject([
        { operation: "middleware_call", durationMs: 125 },
        { operation: "completed_cache_hit", durationMs: 0 },
        {
          operation: "invalidation",
          reason: "patient_context_changed",
        },
      ]);
      expect(JSON.stringify(delivery.payload.availabilityReads)).not.toContain(
        "private-patient-id",
      );
    }
  });

  it("redacts private appointment selectors from the rich call-state snapshot", async () => {
    const state = createTestCallState({
      activePatient: confirmedActivePatient({
        patientId: "private-patient-backend-id",
      }),
    });
    const appointment = {
      id: 987654321,
      appointmentRef: "appointment-safe-reference",
      cancellationToken: "private-cancellation-token",
      rescheduleToken: "private-reschedule-token",
      date: "Monday, June 1, 2026",
      time: "9:00 AM",
      provider: "Dr. Bach",
      type: "Follow-up",
      appointmentTypeId: 1005,
      facility: "Spring Hill",
      confirmed: true,
    };
    state.identity.activePatient!.appointments = [appointment];
    state.identity.activePatient!.backend = {
      insPlanId: "private-ins-plan-id",
      respPartyId: "private-party-id",
    };
    state.identity.privateCandidates = [
      {
        status: "candidate",
        ref: "precall:1",
        patientId: "private-patient-backend-id",
        firstName: "Private",
        lastName: "Candidate",
        dob: "01/02/1980",
        appointments: [],
      },
    ];
    state.identity.latestBookedAppointmentId = appointment.id;
    state.identity.completedBookingsByPatientId = {
      "private-patient-backend-id": {
        appointmentId: appointment.id,
        appointmentDescription: "private completed booking",
      },
    };
    state.identity.completedCancellations = [
      {
        patientId: "private-patient-backend-id",
        appointment,
      },
    ];
    state.identity.completedReschedulesByPatientId = {
      "private-patient-backend-id": {
        status: "rescheduled",
        appointmentDescription: "private completed reschedule",
      },
    };
    state.availability.bookingTokensBySlotId = {
      S1: "private-booking-token",
    };
    const { events, portal } = await setupCloseout({ state });

    await events.close();

    const callStatePayload = JSON.stringify(
      portal.deliveries[2]?.payload.callState,
    );
    expect(callStatePayload).toContain("appointment-safe-reference");
    expect(callStatePayload).not.toContain("private-cancellation-token");
    expect(callStatePayload).not.toContain("private-reschedule-token");
    expect(callStatePayload).not.toContain("private-booking-token");
    expect(callStatePayload).not.toContain("private-patient-backend-id");
    expect(callStatePayload).not.toContain("987654321");
    expect(callStatePayload).not.toContain("private-ins-plan-id");
    expect(callStatePayload).not.toContain("private-party-id");
    expect(callStatePayload).not.toContain("Private");
    expect(callStatePayload).not.toContain("Candidate");
    expect(callStatePayload).not.toContain("01/02/1980");
    expect(
      state.identity.activePatient!.appointments[0]?.cancellationToken,
    ).toBe("private-cancellation-token");
    expect(state.identity.activePatient!.appointments[0]?.rescheduleToken).toBe(
      "private-reschedule-token",
    );
  });

  it("includes identity transitions in compact and rich observation", async () => {
    const state = createTestCallState();
    recordPatientIdentityTransition(state, {
      outcome: "pending",
      source: "pre_call_phone_lookup",
    });
    recordPatientIdentityTransition(state, {
      outcome: "confirmed",
      source: "caller_transcript",
    });
    const { events, portal } = await setupCloseout({ state });
    await events.close();

    const expected = [
      { outcome: "pending", source: "pre_call_phone_lookup" },
      { outcome: "confirmed", source: "caller_transcript" },
    ];
    expect(portal.deliveries[1]?.payload.identityTransitions).toEqual(expected);
    expect(portal.deliveries[2]?.payload.identityTransitions).toEqual(expected);
  });

  it("classifies only accepted transfer state as escalated", async () => {
    const state = createTestCallState();
    acceptTransfer(state);
    const { events, portal } = await setupCloseout({ state });
    await events.close();

    expect(portal.deliveries[1]?.payload.status).toBe("ESCALATED");
    expect(portal.deliveries[2]?.payload.status).toBe("ESCALATED");
  });

  it.each([
    ["pending", beginTransfer],
    ["ambiguous", markTransferAmbiguous],
  ])("does not classify %s transfer state as escalated", async (_, mark) => {
    const state = createTestCallState();
    mark(state);
    const { events, portal } = await setupCloseout({ state });
    await events.close();

    expect(portal.deliveries[1]?.payload.status).toBe("COMPLETED");
  });

  it("records failed initialization as an explicit closeout reason", async () => {
    const { events, portal } = await setupCloseout({ state: null });
    await events.close();

    expect(portal.deliveries[1]?.payload).toMatchObject({
      endedReason: "call_state_not_initialized",
      status: "FAILED",
    });
    expect(portal.deliveries[2]?.payload).not.toHaveProperty("callState");
  });

  it("records duration-limit termination and its configured maximum", async () => {
    const { events, portal } = await setupCloseout({
      call: { maxCallDurationMs: 1_800_000 },
      now: () => new Date("2026-07-20T10:30:00.000Z"),
    });
    events.reachDurationLimit();
    await events.close();

    expect(portal.deliveries[1]?.payload).toMatchObject({
      endedReason: "duration_limit",
      maxCallDurationMs: 1_800_000,
      status: "COMPLETED",
    });
  });

  it("reconciles missing tool events from appointment side effects", async () => {
    const state = createTestCallState();
    recordAppointmentAction(state, {
      action: "booked",
      appointment: { patientName: "Private Patient" },
      status: "success",
      toolName: "book_appointment",
    });
    recordAppointmentAction(state, {
      action: "rescheduled",
      message: "Private appointment details",
      status: "partial",
      toolName: "reschedule_appointment",
    });
    recordAppointmentAction(state, {
      action: "cancelled",
      message: "Private appointment details",
      status: "error",
      toolName: "cancel_appointment",
    });
    recordOwnedMiddlewareFailure(state, "bookAppointment", {
      reason: "invalid_response",
      detail: "missing_appointment_id",
    });
    const { events, portal } = await setupCloseout({ state });
    await events.close();

    expect(portal.deliveries[2]?.payload.toolExecutions).toMatchObject([
      {
        outputClass: "appointment_booked",
        status: "success",
        toolName: "book_appointment",
      },
      {
        outputClass: "appointment_reschedule_partial",
        status: "error",
        toolName: "reschedule_appointment",
      },
      {
        outputClass: "appointment_not_cancelled",
        status: "error",
        toolName: "cancel_appointment",
      },
    ]);
    expect(portal.deliveries[2]?.payload.appointmentActions).toHaveLength(3);
    expect(portal.deliveries[2]?.payload.ownedMiddlewareFailures).toMatchObject(
      [
        {
          operation: "bookAppointment",
          reason: "invalid_response",
          detail: "missing_appointment_id",
        },
      ],
    );
    expect(
      JSON.stringify(portal.deliveries[2]?.payload.toolExecutions),
    ).not.toContain("Private");
  });

  it("delivers sanitized Office Knowledge hook outcomes in both closeout payloads", async () => {
    const state = createTestCallState();
    recordOfficeKnowledgeRetrieval(state, {
      elapsedMs: 1.25,
      language: "mixed",
      officeKey: "sweetwater",
      outcome: "matched",
      sectionCount: 1,
      topic: "pricing",
    });
    const { events, portal } = await setupCloseout({ state });

    await events.close();

    const expected = [
      {
        elapsedMs: 1.25,
        language: "mixed",
        officeKey: "sweetwater",
        outcome: "matched",
        sectionCount: 1,
        topic: "pricing",
      },
    ];
    expect(portal.deliveries[1]?.payload.knowledgeRetrievals).toMatchObject(
      expected,
    );
    expect(portal.deliveries[2]?.payload.knowledgeRetrievals).toMatchObject(
      expected,
    );
  });

  it("bounds Office Knowledge observations kept in Call State", () => {
    const state = createTestCallState();

    for (let index = 0; index <= 200; index += 1) {
      recordOfficeKnowledgeRetrieval(state, {
        elapsedMs: index,
        language: "en",
        officeKey: "spring-hill",
        outcome: "skipped",
        sectionCount: 0,
        topic: null,
      });
    }

    expect(state.runtime.knowledgeRetrievals).toHaveLength(200);
    expect(state.runtime.knowledgeRetrievals[0]?.elapsedMs).toBe(1);
    expect(state.runtime.knowledgeRetrievals.at(-1)?.elapsedMs).toBe(200);
  });

  it("uses captured tool events and latest session usage", async () => {
    const events = new TestLiveKitEvents();
    events.capture = async () => ({
      language: { currentLanguage: "en" },
      sessionUsage: { source: "session-fallback" },
      sttProfiles: [],
    });
    const { portal } = await setupCloseout({ events });
    events.emit("usageUpdated", { source: "latest-event" });
    events.emit("toolsExecuted", {
      createdAt: Date.parse("2026-07-20T10:00:30.000Z"),
      functionCalls: [{ callId: "tool-call-1", name: "book_appointment" }],
      functionCallOutputs: [
        {
          callId: "tool-call-1",
          output: JSON.stringify(
            "Booked July 21 at 9:00 AM with Doctor Smith.",
          ),
        },
      ],
    });
    await events.close();

    expect(portal.deliveries[2]?.payload.usage).toEqual({
      source: "latest-event",
    });
    expect(portal.deliveries[2]?.payload.toolExecutions).toEqual([
      {
        callId: "tool-call-1",
        createdAt: "2026-07-20T10:00:30.000Z",
        outputClass: "appointment_booked",
        status: "success",
        toolName: "book_appointment",
      },
    ]);
    expect(
      JSON.stringify(portal.deliveries[2]?.payload.toolExecutions),
    ).not.toContain("Private Patient");
  });

  it("checkpoints each receipt-backed appointment outcome once after tool execution", async () => {
    const state = createTestCallState();
    const { events, portal } = await setupCloseout({
      call: { officeKey: "abita-main" },
      state,
    });
    recordAppointmentAction(state, {
      action: "booked",
      status: "success",
      toolName: "book_appointment",
      externalPatientId: "patient-63",
      newAppointmentId: "appointment-63",
      bookingResult: { status: "booked", appointmentId: 63 },
    });
    const toolEvent = {
      createdAt: Date.parse("2026-07-20T10:00:30.000Z"),
      functionCalls: [{ callId: "tool-call-63", name: "book_appointment" }],
      functionCallOutputs: [
        { callId: "tool-call-63", output: JSON.stringify("Booked") },
      ],
    };

    events.emit("toolsExecuted", toolEvent);
    events.emit("toolsExecuted", toolEvent);
    await events.close();

    expect(portal.deliveries.map(({ phase }) => phase)).toEqual([
      "call-start",
      "outcome-checkpoint",
      "shutdown-summary",
      "shutdown",
    ]);
    expect(portal.deliveries[1]?.payload).toMatchObject({
      callId: "call-test",
      callerPhone: "+17275551212",
      officeKey: "abita-main",
      officePhone: "+17275919997",
      status: "IN_PROGRESS",
      appointmentOutcome: {
        action: "booked",
        externalPatientId: "patient-63",
        newAppointmentId: "appointment-63",
        bookingResult: { status: "booked", appointmentId: 63 },
      },
    });
  });

  it("collects diagnostic events into one sanitized lifecycle record", async () => {
    const state = createTestCallState();
    state.runtime.voiceLanguage = {
      current: "es",
      speaker: "luz",
      ttsLanguage: "es",
      ttsProvider: "rime-inference",
    };
    const events = new TestLiveKitEvents();
    events.capture = async () => ({
      language: {
        currentLanguage: "es",
        languageChanged: true,
        languageSwitches: 1,
      },
      sessionUsage: { modelUsage: [] },
      sttProfiles: [
        {
          createdAt: "2026-07-20T10:00:00.000Z",
          from: null,
          reason: "startup",
          to: "default",
        },
      ],
    });
    const { portal } = await setupCloseout({ events, state });
    events.emit("conversationItemAdded", {
      createdAt: Date.parse("2026-07-20T10:00:10.000Z"),
      item: {
        id: "assistant-turn-1",
        interrupted: false,
        metrics: { ttft: 0.42 },
        role: "assistant",
        textContent: "Private transcript text",
        type: "message",
      },
    });
    events.emit("llmMetric", {
      completionTokens: 20,
      metadata: { modelName: "fallback/model" },
      promptCachedTokens: 40,
      promptTokens: 100,
      ttftMs: 500,
      type: "llm_metrics",
    });
    events.emit("sessionError", {
      createdAt: Date.parse("2026-07-20T10:00:20.000Z"),
      error: Object.assign(new Error("secret provider response"), {
        code: "ETIMEDOUT",
      }),
      source: { name: "stt" },
    });
    events.emit("sessionClosed", {
      createdAt: Date.parse("2026-07-20T10:00:50.000Z"),
      reason: "participant_disconnected",
    });
    events.emit("falseInterruption", {
      createdAt: Date.parse("2026-07-20T10:00:30.000Z"),
      resumed: true,
    });
    events.emit("overlappingSpeech", {
      detectedAt: Date.parse("2026-07-20T10:00:40.000Z"),
      isInterruption: true,
      totalDurationInS: 1.25,
    });
    await events.close();

    const richPayload = portal.deliveries[2]?.payload;
    expect(richPayload).toMatchObject({
      language: {
        currentLanguage: "es",
        languageChanged: true,
        languageSwitches: 1,
      },
      llmSummary: {
        avgTtftMs: 500,
        fallbackUsed: true,
        modelsUsed: ["fallback/model"],
      },
      sessionEvents: {
        close: {
          createdAt: "2026-07-20T10:00:50.000Z",
          reason: "participant_disconnected",
        },
        errors: [
          {
            code: "ETIMEDOUT",
            messageClass: "code:ETIMEDOUT",
            name: "Error",
          },
        ],
        falseInterruptions: [
          {
            createdAt: "2026-07-20T10:00:30.000Z",
            resumed: true,
          },
        ],
        overlappingSpeech: [
          {
            createdAt: "2026-07-20T10:00:40.000Z",
            durationMs: 1250,
            isInterruption: true,
          },
        ],
      },
      turnMetrics: [
        {
          createdAt: Date.parse("2026-07-20T10:00:10.000Z"),
          interrupted: false,
          itemId: "assistant-turn-1",
          metrics: { ttft: 0.42 },
          role: "assistant",
          type: "message",
        },
      ],
      voiceLanguage: {
        current: "es",
        speaker: "luz",
        ttsLanguage: "es",
      },
    });
    expect(richPayload?.sttProfiles).toHaveLength(1);
    expect(JSON.stringify(richPayload)).not.toContain(
      "secret provider response",
    );
    expect(JSON.stringify(richPayload?.turnMetrics)).not.toContain(
      "Private transcript text",
    );
  });

  it("retries compact delivery before continuing to rich delivery", async () => {
    const portal = new InMemoryCallPortal({
      "shutdown-summary": [{ ok: false }, { ok: false }],
      shutdown: [{ ok: true, status: 200 }],
    });
    const { events } = await setupCloseout({ portal });
    await events.close();

    expect(portal.deliveries.map(({ phase }) => phase)).toEqual([
      "call-start",
      "shutdown-summary",
      "shutdown-summary",
      "shutdown",
    ]);
    expect(portal.waits).toEqual([1_000]);
  });

  it("exhausts rich retries after a successful compact delivery", async () => {
    const portal = new InMemoryCallPortal({
      "shutdown-summary": [{ ok: true }],
      shutdown: [{ ok: false }, { ok: false }, { ok: false }, { ok: false }],
    });
    const { events } = await setupCloseout({ portal });
    const result = await events.close();

    expect(result).toEqual({
      richResult: { ok: false },
      summaryResult: { ok: true },
    });
    expect(portal.deliveries.map(({ phase }) => phase)).toEqual([
      "call-start",
      "shutdown-summary",
      "shutdown",
      "shutdown",
      "shutdown",
      "shutdown",
    ]);
    expect(portal.waits).toEqual([2_000, 4_000, 6_000]);
  });

  it("returns both failures after exhausting compact and rich delivery", async () => {
    const portal = new InMemoryCallPortal({
      "shutdown-summary": [{ ok: false }, { ok: false }],
      shutdown: [{ ok: false }, { ok: false }, { ok: false }, { ok: false }],
    });
    const { events } = await setupCloseout({ portal });
    const result = await events.close();

    expect(result).toEqual({
      richResult: { ok: false },
      summaryResult: { ok: false },
    });
    expect(portal.deliveries.map(({ phase }) => phase)).toEqual([
      "call-start",
      "shutdown-summary",
      "shutdown-summary",
      "shutdown",
      "shutdown",
      "shutdown",
      "shutdown",
    ]);
  });

  it("returns explicit skipped outcomes when portal delivery is unavailable", async () => {
    const portal = new InMemoryCallPortal({
      "call-start": [{ ok: false, skipped: true }],
      "shutdown-summary": [{ ok: false, skipped: true }],
      shutdown: [{ ok: false, skipped: true }],
    });
    const { attachment, events } = await setupCloseout({ portal });
    const closeout = await events.close();

    expect(attachment).toEqual({
      startResult: { ok: false, skipped: true },
    });
    expect(closeout).toEqual({
      richResult: { ok: false, skipped: true },
      summaryResult: { ok: false, skipped: true },
    });
    expect(portal.deliveries).toHaveLength(3);
  });

  it("ignores captured audio when building closeout payloads", async () => {
    const events = new TestLiveKitEvents();
    events.capture = async () =>
      ({
        audio: Uint8Array.from([1, 2, 3]),
        language: { currentLanguage: "en" },
        sessionUsage: {},
        sttProfiles: [],
      }) as CallCloseoutCapture & { audio: Uint8Array };
    const { portal } = await setupCloseout({ events });
    await events.close();

    expect(portal.deliveries[1]?.payload).not.toHaveProperty("audioBase64");
    expect(portal.deliveries[2]?.payload).not.toHaveProperty("audioBase64");
  });

  it("removes LiveKit audio recording metadata from the captured report", async () => {
    const report = createSessionReport({
      audioRecordingPath: "/tmp/private-call.ogg",
      audioRecordingStartedAt: 1_234,
      chatHistory: ChatContext.empty(),
      enableRecording: true,
      events: [],
      jobId: "job-test",
      options: {
        maxToolSteps: 3,
        turnHandling: { preemptiveGeneration: { enabled: false } },
        useTtsAlignedTranscript: true,
        userAwayTimeout: 15,
      },
      room: "room-test",
      roomId: "room-id-test",
    });
    const adapter = createLiveKitCallCloseoutEventAdapter(
      { makeSessionReport: () => report } as unknown as JobContext,
      { usage: {} } as unknown as AgentSession<CallState>,
      {
        callId: "call-test",
        llm: { on: vi.fn() },
        maxCallDurationMs: 60_000,
        roomName: "room-test",
        shutdownSession: vi.fn(),
        sttProfiles: [],
        voiceLanguageRuntime: {
          snapshot: () => ({
            language: {},
            voiceLanguage: DEFAULT_CALL.initialVoiceLanguage,
          }),
        },
      },
    );

    const capture = await adapter.capture();

    expect(capture).not.toHaveProperty("audio");
    expect(capture.sessionReport).not.toHaveProperty("audio_recording_path");
    expect(capture.sessionReport).not.toHaveProperty(
      "audio_recording_started_at",
    );
  });

  it.each([
    {
      officeKey: "spring-hill" as const,
      secret: "production-secret",
      secretName: "ABITA_EYE_GROUP_PRODUCT_SERVICE_SECRET" as const,
    },
    {
      officeKey: "dev" as const,
      secret: "demo-secret",
      secretName: "ACUITY_DEMO_PRODUCT_SERVICE_SECRET" as const,
    },
  ])(
    "delivers the $officeKey lifecycle with the tenant bearer",
    async ({ officeKey, secret, secretName }) => {
      const events = new TestLiveKitEvents();
      const fetchImpl = vi.fn(
        async () => new Response(null, { status: 200 }),
      ) as unknown as typeof fetch;
      const logger = { log: vi.fn(), warn: vi.fn() };
      const config = getProductInteractionConfig(officeKey, {
        NODE_ENV: "production",
        ACUITY_PRODUCT_INTERACTION_URL:
          "https://product.example/v1/ai/interactions",
        [secretName]: secret,
      });
      const portal = new HttpCallPortal({
        ...config,
        fetchImpl,
        logger,
      });
      const state = createTestCallState();

      await attachCallCloseout({
        call: { ...DEFAULT_CALL, officeKey },
        events,
        getCallState: () => state,
        portal,
      });
      recordAppointmentAction(state, {
        action: "booked",
        status: "success",
        toolName: "book_appointment",
        newAppointmentId: "appointment-auth-proof",
        bookingResult: { status: "booked", appointmentId: 63 },
      });
      events.emit("toolsExecuted", {
        createdAt: Date.parse("2026-07-20T10:00:30.000Z"),
        functionCalls: [{ callId: "tool-call-auth", name: "book_appointment" }],
        functionCallOutputs: [
          { callId: "tool-call-auth", output: JSON.stringify("Booked") },
        ],
      });
      await events.close();

      expect(fetchImpl).toHaveBeenCalledTimes(4);
      for (const [, request] of vi.mocked(fetchImpl).mock.calls) {
        expect(request?.headers).toEqual({
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json",
        });
      }
      expect(logger.log.mock.calls.flat().join(" ")).not.toContain(secret);
      expect(logger.warn.mock.calls.flat().join(" ")).not.toContain(secret);
    },
  );

  it("sends Product Interaction envelopes with receipt-backed appointment evidence", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 200 }),
    ) as unknown as typeof fetch;
    const portal = new HttpCallPortal({
      fetchImpl,
      secret: "product-secret",
      url: "https://product.example/v1/ai/interactions",
    });
    const lifecycle = {
      callId: "call-product-63",
      callerPhone: "+17275550199",
      officePhone: "+17275919997",
      startedAt: "2026-08-08T09:30:00.000Z",
    };

    await portal.deliver({
      phase: "call-start",
      timeoutMs: 2_000,
      payload: { ...lifecycle, status: "IN_PROGRESS" },
    });
    await portal.deliver({
      phase: "shutdown-summary",
      timeoutMs: 3_000,
      payload: {
        ...lifecycle,
        endedAt: "2026-08-08T09:35:00.000Z",
        status: "COMPLETED",
      },
    });
    await portal.deliver({
      phase: "shutdown",
      timeoutMs: 10_000,
      payload: {
        ...lifecycle,
        endedAt: "2026-08-08T09:35:00.000Z",
        status: "COMPLETED",
        sessionReport: { chat_history: { items: [{ role: "user" }] } },
        appointmentActions: [
          {
            action: "rescheduled",
            status: "success",
            createdAt: "2026-08-08T09:33:00.000Z",
            externalPatientId: "patient-63",
            oldAppointmentId: "appointment-old",
            newAppointmentId: "appointment-new",
            bookingResult: { status: "booked", appointmentId: 6302 },
            cancellationResult: { status: "cancelled" },
          },
        ],
      },
    });

    const bodies = vi
      .mocked(fetchImpl)
      .mock.calls.map(
        ([, request]) =>
          JSON.parse(String(request?.body)) as Record<string, unknown>,
      );
    expect(bodies[0]).toEqual({
      kind: "START",
      sourceCallId: "call-product-63",
      callerPhone: "+17275550199",
      officePhone: "+17275919997",
      startedAt: "2026-08-08T09:30:00.000Z",
      status: "IN_PROGRESS",
    });
    expect(bodies[1]).toMatchObject({
      kind: "SUMMARY",
      sourceCallId: "call-product-63",
      summaryPayload: { callId: "call-product-63" },
    });
    expect(bodies[2]).toMatchObject({
      kind: "CLOSEOUT",
      sourceCallId: "call-product-63",
      transcript: { chat_history: { items: [{ role: "user" }] } },
      appointmentOutcome: {
        action: "RESCHEDULED",
        occurredAt: "2026-08-08T09:33:00.000Z",
        externalPatientId: "patient-63",
        oldAppointmentId: "appointment-old",
        newAppointmentId: "appointment-new",
        bookingResult: { status: "booked", appointmentId: 6302 },
        cancellationResult: { status: "cancelled" },
      },
      closeoutPayload: {
        callId: "call-product-63",
        appointmentActions: [
          expect.objectContaining({ action: "rescheduled" }),
        ],
      },
    });
    expect(bodies[2]).not.toHaveProperty("callId");
    expect(bodies[2]).not.toHaveProperty("appointmentActions");
  });

  it("skips a missing HTTP URL and omits absent authorization", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("private Product response", { status: 503 }),
    ) as unknown as typeof fetch;
    const logger = { log: vi.fn(), warn: vi.fn() };
    const missingUrlPortal = new HttpCallPortal({ fetchImpl, logger });

    await expect(
      missingUrlPortal.deliver({
        payload: { transcript: "private transcript" },
        phase: "call-start",
        timeoutMs: 2_000,
      }),
    ).resolves.toEqual({ ok: false, skipped: true });
    expect(fetchImpl).not.toHaveBeenCalled();

    const portal = new HttpCallPortal({
      fetchImpl,
      logger,
      url: "https://product.example/v1/ai/interactions",
    });
    await portal.deliver({
      payload: {
        callId: "private-call-id",
        callerPhone: "+17275550199",
        officePhone: "+17275919997",
        startedAt: "2026-08-08T09:30:00.000Z",
        endedAt: "2026-08-08T09:35:00.000Z",
        status: "COMPLETED",
        sessionReport: { transcript: "private transcript" },
      },
      phase: "shutdown",
      timeoutMs: 10_000,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://product.example/v1/ai/interactions",
      expect.objectContaining({
        headers: { "Content-Type": "application/json" },
      }),
    );
    const warnings = logger.warn.mock.calls.flat().join(" ");
    expect(warnings).not.toContain("private Product response");
    expect(warnings).not.toContain("private transcript");
    expect(warnings).not.toContain("product.example");
  });
});
