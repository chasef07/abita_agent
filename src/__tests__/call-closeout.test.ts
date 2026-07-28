import { describe, expect, it, vi } from "vitest";
import {
  HttpCallPortal,
  InMemoryCallPortal,
  attachCallCloseout,
  attachStartupCallCloseout,
  type CallCloseoutCapture,
  type CallCloseoutEventAdapter,
  type CallCloseoutObserver,
  type CallCloseoutResult,
} from "../runtime/call-closeout.js";
import { getOfficeProfileByPhone } from "../customers/abita/profile.js";
import { getPortalSecret } from "../runtime/portal-auth.js";
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
import { createTestCallState } from "./support/call-state.js";

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
    ttsLanguage: "eng",
    ttsProvider: "rime",
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

  it("returns the configured LiveKit portal secret", () => {
    expect(
      getPortalSecret({
        LIVEKIT_FORWARD_SYNC_SECRET: "livekit-secret",
      }),
    ).toBe("livekit-secret");
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
    const state = createTestCallState({ patientId: "private-patient-id" });
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
      patientId: "private-patient-backend-id",
    });
    const appointment = {
      id: 987654321,
      appointmentRef: "appointment-safe-reference",
      cancellationToken: "private-cancellation-token",
      date: "Monday, June 1, 2026",
      time: "9:00 AM",
      provider: "Dr. Bach",
      type: "Follow-up",
      appointmentTypeId: 1005,
      facility: "Spring Hill",
      confirmed: true,
    };
    state.identity.patient.appointments = [appointment];
    state.identity.patientBackend = {
      insPlanId: "private-ins-plan-id",
      respPartyId: "private-party-id",
    };
    state.identity.preCall = {
      status: "single_match_confirmed",
      source: "phone_lookup",
      callerPhone: "+17275551212",
      candidates: [
        {
          status: "candidate",
          ref: "precall:1",
          patientId: "private-patient-backend-id",
          firstName: "Private",
          lastName: "Candidate",
          dob: "01/02/1980",
          appointments: [],
        },
      ],
    };
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
    expect(callStatePayload).not.toContain("private-booking-token");
    expect(callStatePayload).not.toContain("private-patient-backend-id");
    expect(callStatePayload).not.toContain("987654321");
    expect(callStatePayload).not.toContain("private-ins-plan-id");
    expect(callStatePayload).not.toContain("private-party-id");
    expect(callStatePayload).not.toContain("Private");
    expect(callStatePayload).not.toContain("Candidate");
    expect(callStatePayload).not.toContain("01/02/1980");
    expect(state.identity.patient.appointments[0]?.cancellationToken).toBe(
      "private-cancellation-token",
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

  it("collects diagnostic events into one sanitized lifecycle record", async () => {
    const state = createTestCallState();
    state.runtime.voiceLanguage = {
      current: "es",
      speaker: "luz",
      ttsLanguage: "spa",
      ttsProvider: "rime",
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
        ttsLanguage: "spa",
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

  it("includes readable call audio in the authorized rich payload", async () => {
    const events = new TestLiveKitEvents();
    events.capture = async () => ({
      audio: Uint8Array.from([1, 2, 3]),
      language: { currentLanguage: "en" },
      sessionUsage: {},
      sttProfiles: [],
    });
    const { portal } = await setupCloseout({ events });
    await events.close();

    expect(portal.deliveries[2]?.payload.audioBase64).toBe("AQID");
    expect(portal.deliveries[1]?.payload).not.toHaveProperty("audioBase64");
  });

  it("omits oversized audio with a content-free warning", async () => {
    const events = new TestLiveKitEvents();
    events.capture = async () => ({
      audio: new Uint8Array(3 * 1024 * 1024),
      language: { currentLanguage: "en" },
      sessionUsage: {},
      sttProfiles: [],
    });
    const logger = { warn: vi.fn() };
    const { portal } = await setupCloseout({ events, logger });
    await events.close();

    expect(portal.deliveries[2]?.payload).not.toHaveProperty("audioBase64");
    expect(logger.warn).toHaveBeenCalledWith(
      "[closeout] Call audio exceeded 4 MiB payload limit; omitted",
    );
  });

  it("continues rich delivery when recorded audio is unreadable", async () => {
    const events = new TestLiveKitEvents();
    events.capture = async () => ({
      audioUnreadable: true,
      language: { currentLanguage: "en" },
      sessionReport: { chat_history: { items: [] } },
      sessionUsage: {},
      sttProfiles: [],
    });
    const logger = { warn: vi.fn() };
    const { portal } = await setupCloseout({ events, logger });
    const result = await events.close();

    expect(result).toMatchObject({ richResult: { ok: true } });
    expect(portal.deliveries[2]?.payload).not.toHaveProperty("audioBase64");
    expect(logger.warn).toHaveBeenCalledWith(
      "[closeout] Recorded call audio could not be read; omitted",
    );
  });

  it("delivers the lifecycle through HTTP with bearer authorization", async () => {
    const events = new TestLiveKitEvents();
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 200 }),
    ) as unknown as typeof fetch;
    const logger = { log: vi.fn(), warn: vi.fn() };
    const portal = new HttpCallPortal({
      fetchImpl,
      logger,
      secret: "private-secret",
      url: "https://portal.example/api/livekit/calls",
    });

    await attachCallCloseout({
      call: DEFAULT_CALL,
      events,
      getCallState: createTestCallState,
      portal,
    });
    await events.close();

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    for (const [, request] of vi.mocked(fetchImpl).mock.calls) {
      expect(request?.headers).toEqual({
        Authorization: "Bearer private-secret",
        "Content-Type": "application/json",
      });
    }
    expect(logger.log.mock.calls.flat().join(" ")).not.toContain(
      "private-secret",
    );
    expect(logger.warn.mock.calls.flat().join(" ")).not.toContain(
      "private-secret",
    );
  });

  it("skips a missing HTTP URL and omits absent authorization", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("private portal response", { status: 503 }),
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
      url: "https://portal.example/api/livekit/calls",
    });
    await portal.deliver({
      payload: { transcript: "private transcript" },
      phase: "shutdown",
      timeoutMs: 10_000,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://portal.example/api/livekit/calls",
      expect.objectContaining({
        headers: { "Content-Type": "application/json" },
      }),
    );
    const warnings = logger.warn.mock.calls.flat().join(" ");
    expect(warnings).not.toContain("private portal response");
    expect(warnings).not.toContain("private transcript");
    expect(warnings).not.toContain("portal.example");
  });
});
