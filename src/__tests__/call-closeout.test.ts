import { InMemoryCallPortal } from "./support/call-portal.js";
import {
  ChatContext,
  createSessionReport,
  type AgentSession,
  type JobContext,
} from "@livekit/agents";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HttpCallPortal,
  attachCallCloseout,
  attachStartupCallCloseout,
  createLiveKitCallCloseoutEventAdapter,
  resolveLiveKitCallStart,
  type CallCloseoutCapture,
  type CallCloseoutEventAdapter,
  type CallCloseoutObserver,
  type CallPortalResult,
} from "../runtime/call-closeout.js";
import {
  getProductInteractionConfig,
  validateRuntimeConfig,
} from "../runtime/portal-auth.js";
import { type CallState } from "../state/call-state.js";
import {
  acceptTransfer,
  beginTransfer,
  markTransferAmbiguous,
} from "../state/call-lifecycle.js";
import { recordDomainOutcome } from "../state/observability.js";
import { createTestCallState } from "./support/call-state.js";
import { createToolContext } from "./support/tool-context.js";
import { create_staff_task } from "../tools/create-staff-task.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

class TestLiveKitEvents implements CallCloseoutEventAdapter {
  private closeout: (() => Promise<CallPortalResult>) | undefined;
  private observer: CallCloseoutObserver | undefined;

  capture = async (): Promise<CallCloseoutCapture> => ({
    language: {
      currentLanguage: "en",
      languageChanged: false,
    },
    sessionReport: { chat_history: { items: [] } },
    sttProfiles: [],
  });

  observe(observer: CallCloseoutObserver): void {
    this.observer = observer;
  }

  onClose(closeout: () => Promise<CallPortalResult>): void {
    this.closeout = closeout;
  }

  async close(): Promise<CallPortalResult | undefined> {
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
    "verified",
    "multiple_matches",
    "no_match",
    "lookup_failed",
    "not_attempted",
  ] as const)(
    "persists only the bounded phone lookup status: %s",
    async (status) => {
      const state = createTestCallState();
      state.runtime.preCallLookup = { status };
      const { events, portal } = await setupCloseout({ state });
      await events.close();
      expect(portal.deliveries.at(-1)?.payload.phoneLookup).toEqual({ status });
    },
  );

  it("keeps LiveKit-owned call identity and timing stable across worker attempts", () => {
    const roomCreationTime = new Date("2026-08-28T13:45:06.000Z");
    const firstWorkerStartedAt = vi.fn(
      () => new Date("2026-08-28T13:45:05.000Z"),
    );
    const secondWorkerStartedAt = vi.fn(
      () => new Date("2026-08-28T13:45:10.000Z"),
    );
    const liveKitCall = {
      participantIdentity: "sip-participant",
      roomCreationTime,
      roomName: "room-call-63",
      sipCallId: "sip-call-63",
    };

    const firstAttempt = resolveLiveKitCallStart(
      liveKitCall,
      firstWorkerStartedAt,
    );
    const secondAttempt = resolveLiveKitCallStart(
      { ...liveKitCall, roomCreationTime: new Date(roomCreationTime) },
      secondWorkerStartedAt,
    );

    expect(firstAttempt).toEqual({
      callId: "sip-call-63",
      startedAt: roomCreationTime,
    });
    expect(secondAttempt).toEqual(firstAttempt);
    expect(firstWorkerStartedAt).toHaveBeenCalledOnce();
    expect(secondWorkerStartedAt).toHaveBeenCalledOnce();
  });

  it.each([
    ["", "room-call-63", "sip-participant", "room-call-63"],
    ["", "", "sip-participant", "sip-participant"],
    ["", "", "", "unknown"],
  ])(
    "keeps the existing call ID fallbacks for sip=%j room=%j participant=%j",
    (sipCallId, roomName, participantIdentity, expectedCallId) => {
      expect(
        resolveLiveKitCallStart({
          participantIdentity,
          roomCreationTime: new Date("2026-08-28T13:45:00.000Z"),
          roomName,
          sipCallId,
        }).callId,
      ).toBe(expectedCallId);
    },
  );

  it.each([new Date(0), new Date(Number.NaN)])(
    "uses one explicit worker-time fallback for invalid room timestamp %j",
    (roomCreationTime) => {
      const fallbackStartedAt = new Date("2026-08-28T13:45:05.000Z");
      const fallback = vi.fn(() => fallbackStartedAt);

      expect(
        resolveLiveKitCallStart(
          {
            participantIdentity: "sip-participant",
            roomCreationTime,
            roomName: "room-call-63",
            sipCallId: "sip-call-63",
          },
          fallback,
        ),
      ).toEqual({ callId: "sip-call-63", startedAt: fallbackStartedAt });
      expect(fallback).toHaveBeenCalledOnce();
    },
  );

  it("rejects a room creation timestamp beyond the clock-skew tolerance", () => {
    const workerStartedAt = new Date("2026-08-28T13:45:05.000Z");
    const fallback = vi.fn(() => workerStartedAt);

    expect(
      resolveLiveKitCallStart(
        {
          participantIdentity: "sip-participant",
          roomCreationTime: new Date("2026-08-28T13:45:11.000Z"),
          roomName: "room-call-63",
          sipCallId: "sip-call-63",
        },
        fallback,
      ),
    ).toEqual({ callId: "sip-call-63", startedAt: workerStartedAt });
    expect(fallback).toHaveBeenCalledOnce();
  });

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
      validateRuntimeConfig({
        NODE_ENV: "production",
        ACUITY_PRODUCT_INTERACTION_URL:
          "https://product.example/v1/ai/interactions",
        ACUITY_DEMO_PRODUCT_SERVICE_SECRET: "demo-secret",
      }),
    ).toThrow(
      "AMD_API_URL, AMD_API_TOKEN, ACUITY_PRODUCT_INTERACTION_URL, ACUITY_PRODUCT_KNOWLEDGE_URL, ACUITY_PRODUCT_HANDOFF_URL, ACUITY_DEMO_PRODUCT_SERVICE_SECRET, ACUITY_DEMO_PRODUCT_PRACTICE_ID, ABITA_EYE_GROUP_PRODUCT_SERVICE_SECRET, ABITA_EYE_GROUP_PRODUCT_PRACTICE_ID are required in production",
    );
    const configured = {
      NODE_ENV: "production",
      AMD_API_URL: "https://middleware.example",
      AMD_API_TOKEN: "middleware-secret",
      ACUITY_PRODUCT_INTERACTION_URL:
        "https://product.example/v1/ai/interactions",
      ACUITY_PRODUCT_KNOWLEDGE_URL:
        "https://product.example/v1/agent/knowledge/search",
      ACUITY_PRODUCT_HANDOFF_URL: "https://product.example/v1/handoffs",
      ACUITY_DEMO_PRODUCT_PRACTICE_ID: "00000000-0000-0000-0000-000000000001",
      ACUITY_DEMO_PRODUCT_SERVICE_SECRET: "demo-secret",
      ABITA_EYE_GROUP_PRODUCT_PRACTICE_ID:
        "00000000-0000-0000-0000-000000000002",
      ABITA_EYE_GROUP_PRODUCT_SERVICE_SECRET: "production-secret",
    };
    expect(() => validateRuntimeConfig(configured)).not.toThrow();
    expect(() =>
      validateRuntimeConfig({
        ...configured,
        ACUITY_PRODUCT_KNOWLEDGE_URL: undefined,
      }),
    ).toThrow("ACUITY_PRODUCT_KNOWLEDGE_URL");
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
      getProductInteractionConfig("rheumatology-demo", {
        NODE_ENV: "production",
        ACUITY_PRODUCT_INTERACTION_URL:
          "https://product.example/v1/ai/interactions",
      }),
    ).toThrow(
      "ACUITY_PRODUCT_INTERACTION_URL and ACUITY_DEMO_PRODUCT_SERVICE_SECRET are required for rheumatology-demo Product interactions",
    );
    expect(
      getProductInteractionConfig("rheumatology-demo", {
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
      getProductInteractionConfig("new-tampa-demo", {
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
      getProductInteractionConfig("ophthalmology-demo", {
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

  it("classifies only accepted transfer state as escalated", async () => {
    const state = createTestCallState();
    acceptTransfer(state);
    const { events, portal } = await setupCloseout({ state });
    await events.close();

    expect(portal.deliveries[1]?.payload.status).toBe("ESCALATED");
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
    expect(portal.deliveries[1]?.payload).not.toHaveProperty("callState");
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

  it("keeps terminal timing chronological within accepted room clock skew", async () => {
    const { events, portal } = await setupCloseout({
      call: { startedAt: new Date("2026-08-28T13:45:06.000Z") },
      now: () => new Date("2026-08-28T13:45:05.000Z"),
    });

    await events.close();

    expect(portal.deliveries[1]?.payload).toMatchObject({
      durationSec: 0,
      endedAt: "2026-08-28T13:45:06.000Z",
      startedAt: "2026-08-28T13:45:06.000Z",
    });
  });

  it("checkpoints each receipt-backed appointment outcome once after tool execution", async () => {
    const state = createTestCallState();
    const { events, portal } = await setupCloseout({
      call: { officeKey: "abita-main" },
      state,
    });
    recordDomainOutcome(state, {
      callId: "tool-call-63",
      toolName: "book_appointment",
      outcome: "booked",
      status: "success",
      evidence: {
        action: "booked",
        externalPatientId: "patient-63",
        newAppointmentId: "appointment-63",
        bookingResult: {
          message: null,
          status: "booked",
          appointmentId: 63,
        },
      },
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
        bookingResult: {
          message: null,
          status: "booked",
          appointmentId: 63,
        },
      },
    });
  });

  it("delivers a real Staff Task result with its durable Product owner", async () => {
    vi.stubEnv(
      "ACUITY_PRODUCT_HANDOFF_URL",
      "https://product.example/v1/handoffs",
    );
    vi.stubEnv("ABITA_EYE_GROUP_PRODUCT_SERVICE_SECRET", "product-secret");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ status: "created", taskId: "task-follow-up-63" }),
      ),
    );
    const state = createTestCallState();
    const events = new TestLiveKitEvents();
    events.capture = async () => ({
      language: { currentLanguage: "en", languageChanged: false },
      sessionReport: {
        chat_history: {
          items: [
            {
              type: "function_call",
              name: "create_staff_task",
              call_id: "staff-task-call-63",
              arguments: "{}",
              created_at: 1_787_648_401_000,
            },
            {
              type: "function_call_output",
              name: "create_staff_task",
              call_id: "staff-task-call-63",
              output: "Task sent to staff.",
              is_error: false,
              created_at: 1_787_648_402_000,
            },
          ],
        },
      },
      sttProfiles: [],
    });
    const { portal } = await setupCloseout({ events, state });

    await create_staff_task.execute(
      {
        category: "other",
        urgency: "normal",
        summary: "Caller needs office follow-up.",
        message: "Caller asked the office to return their call.",
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "staff-task-call-63",
      } as never,
    );
    events.emit("toolsExecuted", {
      functionCalls: [
        { callId: "staff-task-call-63", name: "create_staff_task" },
      ],
      functionCallOutputs: [
        { callId: "staff-task-call-63", output: "Task sent to staff." },
      ],
    });
    await events.close();

    expect(portal.deliveries.at(-1)?.payload).toMatchObject({
      sessionReport: {
        chat_history: {
          items: [
            expect.objectContaining({
              call_id: "staff-task-call-63",
              type: "function_call",
            }),
            expect.objectContaining({
              call_id: "staff-task-call-63",
              is_error: false,
              type: "function_call_output",
            }),
          ],
        },
      },
      domainOutcomes: [
        {
          callId: "staff-task-call-63",
          outcome: "staff_task_created",
          status: "success",
          evidence: {
            createdAt: expect.any(String),
            idempotencyKey: expect.stringMatching(/^staff_task_/),
            status: "created",
            taskId: "task-follow-up-63",
          },
        },
      ],
    });
  });

  it("promotes the final appointment receipt without requiring a tool event", async () => {
    const state = createTestCallState();
    const { events, portal } = await setupCloseout({ state });
    recordDomainOutcome(state, {
      callId: "tool-call-final",
      toolName: "book_appointment",
      outcome: "booked",
      status: "success",
      occurredAt: "2026-07-20T10:00:30.000Z",
      evidence: {
        action: "booked",
        newAppointmentId: "appointment-final",
        bookingResult: {
          message: null,
          status: "booked",
          appointmentId: 63,
        },
      },
    });

    await events.close();

    expect(portal.deliveries.map(({ phase }) => phase)).toEqual([
      "call-start",
      "shutdown",
    ]);
    expect(portal.deliveries[1]?.payload.appointmentOutcome).toMatchObject({
      action: "booked",
      occurredAt: "2026-07-20T10:00:30.000Z",
      newAppointmentId: "appointment-final",
      bookingResult: {
        message: null,
        status: "booked",
        appointmentId: 63,
      },
    });
  });

  it("does not promote a failed appointment receipt as a Product outcome", async () => {
    const state = createTestCallState();
    const { events, portal } = await setupCloseout({ state });
    recordDomainOutcome(state, {
      callId: "tool-call-failed",
      toolName: "book_appointment",
      outcome: "booked",
      status: "failed",
      middlewareRequests: [
        {
          requestId: "fb672b37-0211-4e69-baf1-b0f56b181911",
          operation: "bookAppointment",
          attempt: 1,
          durationMs: 1400,
          result: "response",
          httpStatus: 200,
          outcome: "indeterminate_write",
          providerErrors: [
            {
              operation: "book_appointment",
              category: "upstream_status",
              httpStatus: 503,
              durationMs: 1300,
            },
          ],
        },
      ],
      evidence: {
        action: "booked",
        bookingResult: { status: "error", reason: "middleware_error" },
      },
    });

    events.emit("toolsExecuted", {
      functionCalls: [{ callId: "tool-call-failed", name: "book_appointment" }],
    });
    await events.close();

    expect(portal.deliveries.map(({ phase }) => phase)).toEqual([
      "call-start",
      "shutdown",
    ]);
    expect(portal.deliveries[1]?.payload).not.toHaveProperty(
      "appointmentOutcome",
    );
    expect(portal.deliveries[1]?.payload.domainOutcomes).toMatchObject([
      {
        callId: "tool-call-failed",
        status: "failed",
        middlewareRequests: [
          {
            requestId: "fb672b37-0211-4e69-baf1-b0f56b181911",
            outcome: "indeterminate_write",
            providerErrors: [{ httpStatus: 503 }],
          },
        ],
      },
    ]);
  });

  it("correlates replay calls without duplicating the Product appointment event", async () => {
    const state = createTestCallState();
    const { events, portal } = await setupCloseout({ state });
    const evidence = {
      action: "booked",
      newAppointmentId: "appointment-original",
      bookingResult: {
        message: null,
        status: "booked",
        appointmentId: 63,
      },
    };
    recordDomainOutcome(state, {
      callId: "tool-call-original",
      toolName: "book_appointment",
      outcome: "booked",
      status: "success",
      occurredAt: "2026-07-20T10:00:30.000Z",
      evidence,
    });
    recordDomainOutcome(state, {
      callId: "tool-call-replay",
      toolName: "book_appointment",
      outcome: "booked",
      status: "success",
      occurredAt: "2026-07-20T10:00:45.000Z",
      evidence: { ...evidence, replayed: true },
    });

    events.emit("toolsExecuted", {
      functionCalls: [{ callId: "tool-call-replay", name: "book_appointment" }],
    });
    await events.close();

    expect(portal.deliveries.map(({ phase }) => phase)).toEqual([
      "call-start",
      "shutdown",
    ]);
    expect(portal.deliveries[1]?.payload.appointmentOutcome).toMatchObject({
      action: "booked",
      occurredAt: "2026-07-20T10:00:30.000Z",
      newAppointmentId: "appointment-original",
    });
  });

  it("retries closeout delivery with the same bounded idempotent payload", async () => {
    const portal = new InMemoryCallPortal({
      shutdown: [{ ok: false }, { ok: false }, { ok: true, status: 200 }],
    });
    const { events } = await setupCloseout({ portal });
    const result = await events.close();

    expect(result).toEqual({ ok: true, status: 200 });
    expect(portal.deliveries.map(({ phase }) => phase)).toEqual([
      "call-start",
      "shutdown",
      "shutdown",
      "shutdown",
    ]);
    expect(portal.deliveries[1]?.payload).toBe(portal.deliveries[2]?.payload);
    expect(portal.deliveries[2]?.payload).toBe(portal.deliveries[3]?.payload);
    expect(portal.waits).toEqual([2_000, 4_000]);
  });

  it("exhausts closeout retries after four attempts", async () => {
    const portal = new InMemoryCallPortal({
      shutdown: [{ ok: false }, { ok: false }, { ok: false }, { ok: false }],
    });
    const { events } = await setupCloseout({ portal });
    const result = await events.close();

    expect(result).toEqual({ ok: false });
    expect(portal.deliveries.map(({ phase }) => phase)).toEqual([
      "call-start",
      "shutdown",
      "shutdown",
      "shutdown",
      "shutdown",
    ]);
    expect(portal.waits).toEqual([2_000, 4_000, 6_000]);
  });

  it("returns explicit skipped outcomes when portal delivery is unavailable", async () => {
    const portal = new InMemoryCallPortal({
      "call-start": [{ ok: false, skipped: true }],
      shutdown: [{ ok: false, skipped: true }],
    });
    const { attachment, events } = await setupCloseout({ portal });
    const closeout = await events.close();

    expect(attachment).toEqual({
      startResult: { ok: false, skipped: true },
    });
    expect(closeout).toEqual({ ok: false, skipped: true });
    expect(portal.deliveries).toHaveLength(2);
  });

  it("ignores captured audio when building closeout payloads", async () => {
    const events = new TestLiveKitEvents();
    events.capture = async () =>
      ({
        audio: Uint8Array.from([1, 2, 3]),
        language: { currentLanguage: "en" },
        sttProfiles: [],
      }) as CallCloseoutCapture & { audio: Uint8Array };
    const { portal } = await setupCloseout({ events });
    await events.close();

    expect(portal.deliveries[1]?.payload).not.toHaveProperty("audioBase64");
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
        recordingOptions: {
          audio: true,
          traces: true,
          logs: true,
          transcript: true,
          redaction: true,
        },
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
        maxCallDurationMs: 60_000,
        roomName: "room-test",
        shutdownSession: vi.fn(),
        sttProfiles: [],
        voiceLanguageRuntime: {
          snapshot: () => ({
            language: {
              acceptedLanguages: ["en"],
              candidateLanguage: null,
              candidateTurns: 0,
              currentLanguage: "en",
              initialLanguage: "en",
              keepEvents: [],
              languageChanged: false,
              languageSwitches: 0,
              observedLanguages: [],
              switchEvents: [],
            },
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

  it("preserves native usage while redacting credentials from report values", async () => {
    const report = createSessionReport({
      chatHistory: ChatContext.empty(),
      events: [],
      jobId: "job-test",
      modelUsage: [
        {
          type: "llm_usage",
          provider: "openai",
          model: "gpt-test",
          inputTokens: 12,
          inputCachedTokens: 0,
          inputAudioTokens: 0,
          inputCachedAudioTokens: 0,
          inputTextTokens: 12,
          inputCachedTextTokens: 0,
          inputImageTokens: 0,
          inputCachedImageTokens: 0,
          outputTokens: 4,
          outputAudioTokens: 0,
          outputTextTokens: 4,
          sessionDurationMs: 0,
        },
      ],
      options: {
        recordingOptions: {
          audio: true,
          traces: true,
          logs: true,
          transcript: true,
          redaction: true,
        },
        maxToolSteps: 3,
        turnHandling: { preemptiveGeneration: { enabled: false } },
        useTtsAlignedTranscript: true,
        userAwayTimeout: 15,
      },
      room: "room-test",
      roomId: "room-id-test",
    });
    const serialized = report as unknown as Record<string, unknown>;
    serialized.events = [
      {
        type: "error",
        error:
          "request failed with Authorization: Bearer private-token at http://10.0.0.5/private",
        clientSecret: "private-client-secret",
        functionCalls: [
          {
            name: "search_office_knowledge",
            callId: "knowledge-1",
            args: "sensitive-query",
          },
        ],
        outputs: [
          {
            type: "function_call_output",
            callId: "knowledge-1",
            output: "sensitive-passage",
          },
        ],
      },
    ];
    const adapter = createLiveKitCallCloseoutEventAdapter(
      { makeSessionReport: () => report } as unknown as JobContext,
      { usage: {} } as unknown as AgentSession<CallState>,
      {
        callId: "call-test",
        maxCallDurationMs: 60_000,
        roomName: "room-test",
        shutdownSession: vi.fn(),
        sttProfiles: [],
        voiceLanguageRuntime: {
          snapshot: () => ({
            language: {
              acceptedLanguages: ["en"],
              candidateLanguage: null,
              candidateTurns: 0,
              currentLanguage: "en",
              initialLanguage: "en",
              keepEvents: [],
              languageChanged: false,
              languageSwitches: 0,
              observedLanguages: [],
              switchEvents: [],
            },
            voiceLanguage: DEFAULT_CALL.initialVoiceLanguage,
          }),
        },
      },
    );

    const capture = await adapter.capture();
    const captured = JSON.stringify(capture.sessionReport);

    expect(capture.sessionReport?.usage).toMatchObject([
      { input_tokens: 12, output_tokens: 4 },
    ]);
    expect(captured).not.toContain("private-token");
    expect(captured).toContain("sensitive-query");
    expect(captured).toContain("sensitive-passage");
    expect(captured).toContain("search_office_knowledge");
    expect(captured).not.toContain("private-client-secret");
    expect(captured).not.toContain("10.0.0.5");
  });

  it.each([
    {
      officeKey: "spring-hill" as const,
      secret: "production-secret",
      secretName: "ABITA_EYE_GROUP_PRODUCT_SERVICE_SECRET" as const,
    },
    {
      officeKey: "rheumatology-demo" as const,
      secret: "demo-secret",
      secretName: "ACUITY_DEMO_PRODUCT_SERVICE_SECRET" as const,
    },
    {
      officeKey: "ophthalmology-demo" as const,
      secret: "demo-secret",
      secretName: "ACUITY_DEMO_PRODUCT_SERVICE_SECRET" as const,
    },
    {
      officeKey: "new-tampa-demo" as const,
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
      recordDomainOutcome(state, {
        callId: "tool-call-auth",
        toolName: "book_appointment",
        outcome: "booked",
        status: "success",
        evidence: {
          action: "booked",
          newAppointmentId: "appointment-auth-proof",
          bookingResult: {
            message: null,
            status: "booked",
            appointmentId: 63,
          },
        },
      });
      events.emit("toolsExecuted", {
        createdAt: Date.parse("2026-07-20T10:00:30.000Z"),
        functionCalls: [{ callId: "tool-call-auth", name: "book_appointment" }],
        functionCallOutputs: [
          { callId: "tool-call-auth", output: JSON.stringify("Booked") },
        ],
      });
      await events.close();

      expect(fetchImpl).toHaveBeenCalledTimes(3);
      for (const [, request] of vi.mocked(fetchImpl).mock.calls) {
        expect(request?.headers).toEqual({
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json",
        });
      }
      const closeoutBody = JSON.parse(
        String(vi.mocked(fetchImpl).mock.calls.at(-1)?.[1]?.body),
      ) as Record<string, unknown>;
      expect(closeoutBody).toMatchObject({
        kind: "CLOSEOUT",
        appointmentOutcome: {
          action: "BOOKED",
          newAppointmentId: "appointment-auth-proof",
        },
        closeoutPayload: {
          domainOutcomes: [
            expect.objectContaining({
              callId: "tool-call-auth",
              outcome: "booked",
            }),
          ],
        },
      });
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
      phase: "shutdown",
      timeoutMs: 10_000,
      payload: {
        ...lifecycle,
        endedAt: "2026-08-08T09:35:00.000Z",
        status: "COMPLETED",
        sessionReport: { chat_history: { items: [{ role: "user" }] } },
        appointmentOutcome: {
          action: "rescheduled",
          status: "success",
          createdAt: "2026-08-08T09:33:00.000Z",
          externalPatientId: "patient-63",
          oldAppointmentId: "appointment-old",
          newAppointmentId: "appointment-new",
          bookingResult: {
            message: null,
            status: "booked",
            appointmentId: 6302,
          },
          cancellationResult: { status: "cancelled" },
        },
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
      kind: "CLOSEOUT",
      sourceCallId: "call-product-63",
      transcript: { chat_history: { items: [{ role: "user" }] } },
      appointmentOutcome: {
        action: "RESCHEDULED",
        occurredAt: "2026-08-08T09:33:00.000Z",
        externalPatientId: "patient-63",
        oldAppointmentId: "appointment-old",
        newAppointmentId: "appointment-new",
        bookingResult: {
          message: null,
          status: "booked",
          appointmentId: 6302,
        },
        cancellationResult: { status: "cancelled" },
      },
      closeoutPayload: {
        callId: "call-product-63",
        appointmentOutcome: expect.objectContaining({ action: "rescheduled" }),
      },
    });
    expect(bodies[1]).not.toHaveProperty("callId");
    expect(bodies[1]).not.toHaveProperty("appointmentActions");
    expect(bodies[1]?.closeoutPayload).not.toHaveProperty("sessionReport");
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
