import {
  AgentSessionEventTypes,
  ChatMessage,
  type AgentSession,
  type JobContext,
} from "@livekit/agents";
import { describe, expect, it, vi } from "vitest";
import {
  CallCapture,
  HttpCallCapturePortal,
  InMemoryCallCapturePortal,
  createLiveKitCallCaptureEventAdapter,
  type CallCaptureDelivery,
  type CallCapturePortal,
  type CallCapturePortalResult,
} from "../runtime/call-capture.js";
import { getAnalyticsSecret } from "../runtime/portal-auth.js";
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

const CALL = {
  callId: "call-test",
  callerPhone: "+10000000000",
  fallbackModel: "fallback/model",
  initialVoiceLanguage: {
    current: "en" as const,
    speaker: "test-speaker",
    ttsLanguage: "eng",
    ttsProvider: "rime" as const,
  },
  livekitContext: {
    agentJobId: "job-test",
    roomName: "room-test",
  },
  officePhone: "+10000000001",
  startedAt: new Date("2026-07-20T10:00:00.000Z"),
};

function createCapture<
  Portal extends CallCapturePortal = InMemoryCallCapturePortal,
>(
  portal: Portal = new InMemoryCallCapturePortal() as Portal,
  options: {
    finalizationTimeoutMs?: number;
    logger?: Pick<Console, "warn">;
    retryDelayMs?: number;
    state?: CallState | null;
  } = {},
) {
  const state =
    options.state === undefined ? createTestCallState() : options.state;
  const capture = new CallCapture({
    call: CALL,
    finalizationTimeoutMs: options.finalizationTimeoutMs,
    getCallState: () => state,
    logger: options.logger,
    now: () => new Date("2026-07-20T10:01:00.000Z"),
    portal,
    retryDelayMs: options.retryDelayMs,
  });
  capture.start();
  return { capture, portal, state };
}

describe("call capture", () => {
  it("prefers the LiveKit portal secret over the legacy secret", () => {
    expect(
      getAnalyticsSecret({
        LIVEKIT_FORWARD_SYNC_SECRET: "livekit-secret",
        WEBHOOK_SECRET: "legacy-secret",
      }),
    ).toBe("livekit-secret");
  });

  it("checkpoints each committed LiveKit message once by call and item id", async () => {
    const { capture, portal } = createCapture();
    const item = {
      id: "item-user-1",
      interrupted: false,
      role: "user",
      text: "Example caller words",
      timestamp: Date.parse("2026-07-20T10:00:10.000Z"),
      transcriptConfidence: 0.94,
    };

    capture.record({ item, type: "conversation-item" });
    capture.record({ item, type: "conversation-item" });

    await vi.waitFor(() => {
      expect(
        portal.deliveries.filter(
          ({ envelope }) => envelope.type === "checkpoint",
        ),
      ).toHaveLength(1);
    });
    expect(portal.deliveries[1]?.envelope).toMatchObject({
      callId: "call-test",
      idempotencyKey: "call-test:item-user-1",
      items: [item],
      schemaVersion: 1,
      type: "checkpoint",
    });
  });

  it("recovers committed items after temporary portal failures", async () => {
    const portal = new InMemoryCallCapturePortal({
      checkpoint: [
        { ok: false, status: 503 },
        { ok: false },
        { ok: true, status: 200 },
      ],
    });
    const { capture } = createCapture(portal, { retryDelayMs: 0 });

    capture.record({
      item: {
        id: "item-assistant-1",
        interrupted: false,
        role: "assistant",
        text: "Example assistant words",
        timestamp: Date.parse("2026-07-20T10:00:20.000Z"),
      },
      type: "conversation-item",
    });

    await vi.waitFor(() => {
      expect(
        portal.deliveries.filter(
          ({ envelope }) => envelope.type === "checkpoint",
        ),
      ).toHaveLength(3);
    });
    expect(
      portal.deliveries
        .filter(({ envelope }) => envelope.type === "checkpoint")
        .map(({ envelope }) => envelope.idempotencyKey),
    ).toEqual([
      "call-test:item-assistant-1",
      "call-test:item-assistant-1",
      "call-test:item-assistant-1",
    ]);
  });

  it("recovers the ordered start envelope after a temporary portal failure", async () => {
    const portal = new InMemoryCallCapturePortal({
      start: [
        { ok: false, status: 503 },
        { ok: true, status: 200 },
      ],
    });
    const { capture } = createCapture(portal, { retryDelayMs: 0 });

    capture.record({
      item: {
        id: "item-after-start",
        interrupted: false,
        role: "user",
        text: "Committed message after start",
        timestamp: Date.parse("2026-07-20T10:00:10.000Z"),
      },
      type: "conversation-item",
    });

    await vi.waitFor(() => expect(portal.deliveries).toHaveLength(3));
    expect(
      portal.deliveries.map(({ envelope }) => ({
        idempotencyKey: envelope.idempotencyKey,
        type: envelope.type,
      })),
    ).toEqual([
      { idempotencyKey: "call-test:start", type: "start" },
      { idempotencyKey: "call-test:start", type: "start" },
      {
        idempotencyKey: "call-test:item-after-start",
        type: "checkpoint",
      },
    ]);
  });

  it("keeps a terminal checkpoint failure pending and advances the queue", async () => {
    const portal = new InMemoryCallCapturePortal({
      checkpoint: [{ ok: false, status: 401 }],
    });
    const logger = { warn: vi.fn() };
    const { capture } = createCapture(portal, {
      logger,
      retryDelayMs: 0,
    });

    for (const id of ["item-terminal", "item-after-terminal"]) {
      capture.record({
        item: {
          id,
          interrupted: false,
          role: "user",
          text: `Committed ${id}`,
          timestamp: Date.parse("2026-07-20T10:00:10.000Z"),
        },
        type: "conversation-item",
      });
    }

    await vi.waitFor(() => expect(portal.deliveries).toHaveLength(3));
    expect(
      portal.deliveries
        .filter(({ envelope }) => envelope.type === "checkpoint")
        .map(({ envelope }) => envelope.idempotencyKey),
    ).toEqual(["call-test:item-terminal", "call-test:item-after-terminal"]);
    expect(logger.warn).toHaveBeenCalledWith(
      "[call-capture] delivery pending type=checkpoint status=401 retryable=false",
    );
  });

  it("recovers the final state after a temporary portal failure", async () => {
    const portal = new InMemoryCallCapturePortal({
      final: [
        { ok: false, status: 503 },
        { ok: true, status: 200 },
      ],
    });
    const { capture } = createCapture(portal, { retryDelayMs: 0 });

    const result = await capture.finish({
      language: {},
      sessionReport: { chat_history: { items: [] } },
      sttProfiles: [],
    });

    expect(
      portal.deliveries.filter(({ envelope }) => envelope.type === "final"),
    ).toHaveLength(2);
    expect(result.finalResult).toEqual({ ok: true, status: 200 });
  });

  it("reconciles a missing committed tail from the final LiveKit report", async () => {
    const { capture, portal } = createCapture();
    capture.record({
      item: {
        id: "item-user-1",
        interrupted: false,
        role: "user",
        text: "First committed message",
        timestamp: 1_721_466_010_000,
        transcriptConfidence: 0.91,
      },
      type: "conversation-item",
    });
    await vi.waitFor(() => expect(portal.deliveries).toHaveLength(2));

    const result = await capture.finish({
      language: { currentLanguage: "en" },
      sessionReport: {
        chat_history: {
          items: [
            {
              content: ["First committed message"],
              created_at: 1_721_466_010_000,
              id: "item-user-1",
              interrupted: false,
              role: "user",
              transcript_confidence: 0.91,
              type: "message",
            },
            {
              content: ["Committed shutdown tail"],
              created_at: 1_721_466_050_000,
              id: "item-assistant-tail",
              interrupted: true,
              role: "assistant",
              type: "message",
            },
          ],
        },
      },
      sessionUsage: { modelUsage: [] },
      sttProfiles: [],
    });

    expect(
      portal.deliveries
        .filter(({ envelope }) => envelope.type === "checkpoint")
        .map(({ envelope }) => envelope.idempotencyKey),
    ).toEqual(["call-test:item-user-1", "call-test:item-assistant-tail"]);
    expect(portal.deliveries.at(-1)?.envelope).toMatchObject({
      items: [
        { id: "item-user-1" },
        { id: "item-assistant-tail", interrupted: true },
      ],
      type: "final",
    });
    expect(result).toMatchObject({
      pendingItemCount: 0,
      timedOut: false,
    });
  });

  it("checkpoints sanitized tool outcomes once by LiveKit tool call id", async () => {
    const { capture, portal } = createCapture();
    const event = {
      createdAt: Date.parse("2026-07-20T10:00:30.000Z"),
      functionCallOutputs: [
        {
          callId: "tool-call-1",
          output: JSON.stringify({
            appointmentId: "private-appointment-id",
            patientName: "Private Patient",
            status: "booked",
          }),
        },
      ],
      functionCalls: [
        {
          callId: "tool-call-1",
          name: "book_appointment",
        },
      ],
    };

    capture.record({ event, type: "tools-executed" });
    capture.record({ event, type: "tools-executed" });

    await vi.waitFor(() => {
      expect(
        portal.deliveries.filter(
          ({ envelope }) => envelope.toolOutcomes?.length,
        ),
      ).toHaveLength(1);
    });
    const delivery = portal.deliveries.find(
      ({ envelope }) => envelope.toolOutcomes?.length,
    );
    expect(delivery?.envelope).toMatchObject({
      idempotencyKey: "call-test:tool:tool-call-1",
      toolOutcomes: [
        {
          callId: "tool-call-1",
          idempotencyKey: "call-test:tool:tool-call-1",
          outputClass: "appointment_booked",
          status: "success",
          toolName: "book_appointment",
        },
      ],
    });
    expect(JSON.stringify(delivery)).not.toContain("Private");
    expect(JSON.stringify(delivery)).not.toContain("private-appointment-id");
  });

  it("preserves a sanitized appointment outcome when the tool event is missing", async () => {
    const state = createTestCallState();
    recordAppointmentAction(state, {
      action: "booked",
      appointment: { patientName: "Private Patient" },
      status: "success",
      toolName: "book_appointment",
    });
    const { capture, portal } = createCapture(new InMemoryCallCapturePortal(), {
      state,
    });

    await capture.finish({
      language: {},
      sessionReport: { chat_history: { items: [] } },
      sttProfiles: [],
    });

    const outcome = portal.deliveries.find(
      ({ envelope }) => envelope.toolOutcomes?.length,
    );
    expect(outcome?.envelope.toolOutcomes).toMatchObject([
      {
        callId: "appointment_action_1",
        outputClass: "appointment_booked",
        status: "success",
        toolName: "book_appointment",
      },
    ]);
    expect(JSON.stringify(outcome)).not.toContain("Private Patient");
  });

  it.each([
    ["accepted", acceptTransfer, "ESCALATED"],
    ["pending", beginTransfer, "COMPLETED"],
    ["ambiguous", markTransferAmbiguous, "COMPLETED"],
  ])("classifies %s transfer final state", async (_, transition, status) => {
    const state = createTestCallState();
    transition(state);
    const { capture, portal } = createCapture(new InMemoryCallCapturePortal(), {
      state,
    });

    await capture.finish({
      language: {},
      sessionReport: { chat_history: { items: [] } },
      sttProfiles: [],
    });

    expect(portal.deliveries.at(-1)?.legacyPayload?.status).toBe(status);
  });

  it("preserves explicit failed-initialization and duration-limit final states", async () => {
    const missingState = createCapture(new InMemoryCallCapturePortal(), {
      state: null,
    });
    await missingState.capture.finish({
      language: {},
      sessionReport: { chat_history: { items: [] } },
      sttProfiles: [],
    });
    expect(missingState.portal.deliveries.at(-1)?.legacyPayload).toMatchObject({
      endedReason: "call_state_not_initialized",
      status: "FAILED",
    });

    const state = createTestCallState();
    const portal = new InMemoryCallCapturePortal();
    const capture = new CallCapture({
      call: { ...CALL, maxCallDurationMs: 1_800_000 },
      getCallState: () => state,
      now: () => new Date("2026-07-20T10:30:00.000Z"),
      portal,
      retryDelayMs: 0,
    });
    capture.start();
    capture.record({ type: "duration-limit" });
    await capture.finish({
      language: {},
      sessionReport: { chat_history: { items: [] } },
      sttProfiles: [],
    });
    expect(portal.deliveries.at(-1)?.legacyPayload).toMatchObject({
      durationSec: 1_800,
      endedReason: "duration_limit",
      maxCallDurationMs: 1_800_000,
      status: "COMPLETED",
    });
  });

  it("preserves latest usage and sanitized workflow observations", async () => {
    const state = createTestCallState();
    recordPatientIdentityTransition(state, {
      outcome: "pending",
      source: "pre_call_phone_lookup",
    });
    recordOfficeKnowledgeRetrieval(state, {
      elapsedMs: 1.25,
      language: "mixed",
      officeKey: "test-office",
      outcome: "matched",
      sectionCount: 1,
      topic: "pricing",
    });
    recordAvailabilityReadEvent(state, {
      durationMs: 125,
      operation: "middleware_call",
    });
    recordAvailabilityReadEvent(state, {
      operation: "invalidation",
      reason: "patient_context_changed",
    });
    recordOwnedMiddlewareFailure(state, "bookAppointment", {
      detail: "missing_appointment_id",
      reason: "invalid_response",
    });
    for (const action of [
      {
        action: "booked" as const,
        status: "success" as const,
        toolName: "book_appointment",
      },
      {
        action: "rescheduled" as const,
        status: "partial" as const,
        toolName: "reschedule_appointment",
      },
      {
        action: "cancelled" as const,
        status: "error" as const,
        toolName: "cancel_appointment",
      },
    ]) {
      recordAppointmentAction(state, {
        ...action,
        message: "Private appointment details",
      });
    }
    const { capture, portal } = createCapture(new InMemoryCallCapturePortal(), {
      state,
    });
    capture.record({
      type: "usage-updated",
      usage: { source: "latest-event" },
    });

    await capture.finish({
      language: {},
      sessionReport: { chat_history: { items: [] } },
      sessionUsage: { source: "stale-snapshot" },
      sttProfiles: [],
    });

    const final = portal.deliveries.at(-1)?.legacyPayload;
    expect(final?.usage).toEqual({ source: "latest-event" });
    expect(final?.identityTransitions).toEqual([
      { outcome: "pending", source: "pre_call_phone_lookup" },
    ]);
    expect(final?.knowledgeRetrievals).toMatchObject([
      {
        officeKey: "test-office",
        outcome: "matched",
        topic: "pricing",
      },
    ]);
    expect(final?.availabilityReads).toMatchObject([
      { durationMs: 125, operation: "middleware_call" },
      {
        operation: "invalidation",
        reason: "patient_context_changed",
      },
    ]);
    expect(final?.ownedMiddlewareFailures).toMatchObject([
      {
        detail: "missing_appointment_id",
        operation: "bookAppointment",
        reason: "invalid_response",
      },
    ]);
    expect(final?.toolExecutions).toMatchObject([
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
    expect(JSON.stringify(final?.toolExecutions)).not.toContain("Private");
  });

  it("bounds shutdown reconciliation when a checkpoint never settles", async () => {
    class HangingCheckpointPortal extends InMemoryCallCapturePortal {
      override async deliver(
        delivery: CallCaptureDelivery,
      ): Promise<CallCapturePortalResult> {
        this.deliveries.push(delivery);
        if (delivery.envelope.type === "checkpoint") {
          return new Promise(() => {});
        }
        return { ok: true, status: 200 };
      }
    }
    const portal = new HangingCheckpointPortal();
    const logger = { warn: vi.fn() };
    const { capture } = createCapture(portal, {
      finalizationTimeoutMs: 40,
      logger,
      retryDelayMs: 0,
    });
    capture.record({
      item: {
        id: "item-pending",
        interrupted: false,
        role: "user",
        text: "Pending committed message",
        timestamp: 1_721_466_030_000,
      },
      type: "conversation-item",
    });
    await vi.waitFor(() => expect(portal.deliveries).toHaveLength(2));

    const startedAt = Date.now();
    const result = await capture.finish({
      language: {},
      sessionReport: {
        chat_history: {
          items: [],
        },
      },
      sttProfiles: [],
    });

    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(result).toMatchObject({
      pendingItemCount: 1,
      timedOut: true,
    });
    expect(portal.deliveries.at(-1)?.envelope.type).toBe("final");
    const warnings = logger.warn.mock.calls.flat().join(" ");
    expect(warnings).toContain("pendingItems=1");
    expect(warnings).not.toContain("Pending committed message");
  });

  it("sends one sanitized final state without the old shutdown summary", async () => {
    const state = createTestCallState({
      patientId: "private-patient-backend-id",
    });
    state.identity.preCall = {
      callerPhone: "+10000000000",
      candidates: [
        {
          appointments: [],
          dob: "01/02/1980",
          firstName: "Private",
          lastName: "Candidate",
          patientId: "private-candidate-id",
          ref: "precall:1",
          status: "candidate",
        },
      ],
      source: "phone_lookup",
      status: "single_match_confirmed",
    };
    state.availability.bookingTokensBySlotId = {
      slot1: "private-booking-token",
    };
    const { capture, portal } = createCapture(new InMemoryCallCapturePortal(), {
      state,
    });

    await capture.finish({
      language: { currentLanguage: "en" },
      sessionReport: {
        chat_history: {
          items: [
            {
              arguments: '{"patientName":"Private Patient"}',
              call_id: "tool-call-private",
              id: "function-call-private",
              name: "book_appointment",
              type: "function_call",
            },
            {
              call_id: "tool-call-private",
              id: "function-output-private",
              output: '{"appointmentId":"private-appointment-id"}',
              type: "function_call_output",
            },
          ],
        },
        recording_location: "private-recording-location",
        sdk_version: "1.5.5",
        usage: [],
      },
      sessionUsage: { modelUsage: [] },
      sttProfiles: [],
    });

    expect(portal.deliveries.map(({ envelope }) => envelope.type)).toEqual([
      "start",
      "final",
    ]);
    const final = portal.deliveries[1];
    expect(final?.legacyPayload).toMatchObject({
      callId: "call-test",
      callState: {
        office: state.office,
        workflow: state.workflow,
      },
      durationSec: 60,
      sessionReport: {
        chat_history: { items: [] },
        sdk_version: "1.5.5",
        usage: [],
      },
      status: "COMPLETED",
    });
    const serialized = JSON.stringify(final);
    expect(serialized).not.toContain("private-patient-backend-id");
    expect(serialized).not.toContain("private-candidate-id");
    expect(serialized).not.toContain("private-booking-token");
    expect(serialized).not.toContain("private-appointment-id");
    expect(serialized).not.toContain("private-recording-location");
    expect(serialized).not.toContain("01/02/1980");
    expect(serialized).not.toContain("Private");
    expect(serialized).not.toContain("Candidate");
  });

  it("requires the checkpoint receiver to acknowledge every item", async () => {
    const fetchImpl = vi.fn(async (_url: string, request?: RequestInit) => {
      const envelope = JSON.parse(String(request?.body)) as {
        callId: string;
        idempotencyKey: string;
        items?: Array<{ id: string }>;
        sequence: number;
      };
      return Response.json({
        callId: envelope.callId,
        idempotencyKey: envelope.idempotencyKey,
        ok: true,
        recordedItemIds: (envelope.items ?? []).map(({ id }) => id),
        recordedToolCallIds: [],
        sequence: envelope.sequence,
      });
    }) as unknown as typeof fetch;
    const portal = new HttpCallCapturePortal({
      captureUrl: "https://capture.example.test/calls",
      fetchImpl,
      logger: { log: vi.fn(), warn: vi.fn() },
      secret: "test-secret",
    });
    const { capture } = createCapture(portal, { retryDelayMs: 0 });
    capture.record({
      item: {
        id: "item-acknowledged",
        interrupted: false,
        role: "assistant",
        text: "Acknowledged committed message",
        timestamp: 1_721_466_040_000,
      },
      type: "conversation-item",
    });

    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));

    const request = vi.mocked(fetchImpl).mock.calls[1]?.[1];
    expect(request?.headers).toEqual({
      Authorization: "Bearer test-secret",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(request?.body))).toMatchObject({
      idempotencyKey: "call-test:item-acknowledged",
      schemaVersion: 1,
      type: "checkpoint",
    });
  });

  it("recovers a checkpoint after a temporary HTTP timeout", async () => {
    let checkpointAttempts = 0;
    const fetchImpl = vi.fn(async (_url: string, request?: RequestInit) => {
      const envelope = JSON.parse(String(request?.body)) as {
        callId: string;
        idempotencyKey: string;
        items?: Array<{ id: string }>;
        sequence: number;
        type: string;
      };
      if (envelope.type === "checkpoint" && checkpointAttempts++ === 0) {
        throw new DOMException("timed out", "TimeoutError");
      }
      return Response.json({
        callId: envelope.callId,
        idempotencyKey: envelope.idempotencyKey,
        ok: true,
        recordedItemIds: (envelope.items ?? []).map(({ id }) => id),
        recordedToolCallIds: [],
        sequence: envelope.sequence,
      });
    }) as unknown as typeof fetch;
    const portal = new HttpCallCapturePortal({
      captureUrl: "https://capture.example.test/calls",
      fetchImpl,
      logger: { log: vi.fn(), warn: vi.fn() },
      secret: "test-secret",
    });
    const { capture } = createCapture(portal, { retryDelayMs: 0 });

    capture.record({
      item: {
        id: "item-after-timeout",
        interrupted: false,
        role: "assistant",
        text: "Committed response",
        timestamp: 1_721_466_040_000,
      },
      type: "conversation-item",
    });

    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
    expect(checkpointAttempts).toBe(2);
    expect(
      vi
        .mocked(fetchImpl)
        .mock.calls.map(
          ([, request]) => JSON.parse(String(request?.body)).type,
        ),
    ).toEqual(["start", "checkpoint", "checkpoint"]);
  });

  it("does not send transcript capture without the receiver secret", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 200 }),
    ) as unknown as typeof fetch;
    const logger = { log: vi.fn(), warn: vi.fn() };
    const portal = new HttpCallCapturePortal({
      captureUrl: "https://capture.example.test/calls",
      fetchImpl,
      logger,
    });

    const result = await portal.deliver({
      envelope: {
        callId: "call-test",
        idempotencyKey: "call-test:item-1",
        items: [
          {
            id: "item-1",
            interrupted: false,
            role: "user",
            text: "Sensitive committed message",
            timestamp: 1,
          },
        ],
        schemaVersion: 1,
        sequence: 2,
        type: "checkpoint",
      },
      timeoutMs: 1_000,
    });

    expect(result).toEqual({ ok: false, skipped: true });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "[call-capture] delivery skipped reason=missing_auth",
    );
    expect(logger.warn.mock.calls.flat().join(" ")).not.toContain("Sensitive");
  });

  it("does not send checkpoints to the legacy whole-call endpoint", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 200 }),
    ) as unknown as typeof fetch;
    const portal = new HttpCallCapturePortal({
      fetchImpl,
      legacyUrl: "https://portal.example.test/api/livekit/calls",
      logger: { log: vi.fn(), warn: vi.fn() },
    });
    const result = await portal.deliver({
      envelope: {
        callId: "call-test",
        idempotencyKey: "call-test:item-1",
        items: [
          {
            id: "item-1",
            interrupted: false,
            role: "user",
            text: "Committed message",
            timestamp: 1,
          },
        ],
        schemaVersion: 1,
        sequence: 2,
        type: "checkpoint",
      },
      timeoutMs: 1_000,
    });

    expect(result).toEqual({ ok: false, skipped: true });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps only committed LiveKit ChatMessage events with their stable fields", async () => {
    const listeners = new Map<string, (event: never) => void>();
    let shutdown: (() => Promise<void>) | undefined;
    const ctx = {
      addShutdownCallback(callback: () => Promise<void>) {
        shutdown = callback;
      },
      makeSessionReport() {
        throw new Error("report unavailable in adapter test");
      },
      shutdown: vi.fn(),
    } as unknown as JobContext;
    const session = {
      on(event: string, listener: (event: never) => void) {
        listeners.set(event, listener);
      },
      usage: { modelUsage: [] },
    } as unknown as AgentSession<CallState>;
    const adapter = createLiveKitCallCaptureEventAdapter(ctx, session, {
      callId: "call-test",
      llm: { on: vi.fn() },
      maxCallDurationMs: 60_000,
      roomName: "room-test",
      shutdownSession: vi.fn(),
      sttLanguageDetector: {
        telemetry: { currentLanguage: "en" },
      } as never,
      sttProfiles: [],
    });
    const records: unknown[] = [];
    adapter.observe((record) => records.push(record));
    adapter.onClose(async () => ({
      finalResult: { ok: true },
      pendingItemCount: 0,
      pendingToolOutcomeCount: 0,
      timedOut: false,
    }));
    const item = ChatMessage.create({
      content: "Committed LiveKit message",
      createdAt: 1_721_466_010_000,
      id: "livekit-item-1",
      interrupted: true,
      role: "user",
      transcriptConfidence: 0.87,
    });

    listeners.get(AgentSessionEventTypes.ConversationItemAdded)?.({
      createdAt: 1_721_466_010_100,
      item,
      type: "conversation_item_added",
    } as never);

    expect(records).toContainEqual({
      item: {
        id: "livekit-item-1",
        interrupted: true,
        role: "user",
        text: "Committed LiveKit message",
        timestamp: 1_721_466_010_000,
        transcriptConfidence: 0.87,
      },
      type: "conversation-item",
    });
    expect(listeners.has(AgentSessionEventTypes.UserInputTranscribed)).toBe(
      false,
    );
    await shutdown?.();
  });
});
