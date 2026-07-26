import { describe, expect, it, vi } from "vitest";
import {
  HttpCallCapturePortal,
  InMemoryCallCapturePortal,
  attachCallCapture,
  type CallCaptureEventAdapter,
  type CallCaptureFinalSnapshot,
  type CallCaptureFinishResult,
  type CallCapturePortal,
  type CallCapturePortalResult,
  type CallCaptureRecord,
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
  recordAppointmentAction,
  recordAvailabilityReadEvent,
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
  maxCallDurationMs: 1_800_000,
  officePhone: "+10000000001",
  startedAt: new Date("2026-07-20T10:00:00.000Z"),
};

const EMPTY_SNAPSHOT: CallCaptureFinalSnapshot = {
  language: {},
  sessionReport: { chat_history: { items: [] } },
  sessionUsage: { source: "snapshot" },
  sttProfiles: [],
};

class TestCallCaptureEvents implements CallCaptureEventAdapter {
  private finish:
    | ((snapshot: CallCaptureFinalSnapshot) => Promise<CallCaptureFinishResult>)
    | undefined;
  private record: ((record: CallCaptureRecord) => void) | undefined;

  observe(record: (record: CallCaptureRecord) => void): void {
    this.record = record;
  }

  onClose(
    finish: (
      snapshot: CallCaptureFinalSnapshot,
    ) => Promise<CallCaptureFinishResult>,
  ): void {
    this.finish = finish;
  }

  emit(record: CallCaptureRecord): void {
    this.record?.(record);
  }

  async close(
    snapshot: CallCaptureFinalSnapshot = EMPTY_SNAPSHOT,
  ): Promise<CallCaptureFinishResult> {
    if (!this.finish)
      throw new Error("capture finish callback is not attached");
    return this.finish(snapshot);
  }
}

function setupCapture(
  options: {
    finalizationTimeoutMs?: number;
    logger?: Pick<Console, "warn">;
    portal?: CallCapturePortal;
    state?: CallState | null;
  } = {},
) {
  const events = new TestCallCaptureEvents();
  const portal = options.portal ?? new InMemoryCallCapturePortal();
  const state =
    options.state === undefined ? createTestCallState() : options.state;
  attachCallCapture({
    call: CALL,
    events,
    finalizationTimeoutMs: options.finalizationTimeoutMs,
    getCallState: () => state,
    logger: options.logger,
    now: () => new Date("2026-07-20T10:01:00.000Z"),
    portal,
  });
  return { events, portal, state };
}

describe("call capture", () => {
  it("delivers exactly one final payload", async () => {
    const { events, portal } = setupCapture();

    const result = await events.close({
      language: { currentLanguage: "en" },
      sessionReport: {
        chat_history: {
          items: [
            {
              content: ["Committed caller message"],
              created_at: 1_721_466_010_000,
              id: "message-1",
              interrupted: false,
              metrics: { ttft: 0.42 },
              role: "user",
              transcript_confidence: 0.92,
              type: "message",
            },
            {
              arguments: '{"patientName":"Private Patient"}',
              call_id: "tool-call-private",
              id: "function-call-private",
              name: "book_appointment",
              type: "function_call",
            },
          ],
        },
        recording_location: "private-recording-location",
        sdk_version: "1.5.5",
      },
      sttProfiles: [],
    });

    expect(portal).toBeInstanceOf(InMemoryCallCapturePortal);
    const deliveries = (portal as InMemoryCallCapturePortal).deliveries;
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.payload).toMatchObject({
      callId: "call-test",
      sessionReport: {
        chat_history: {
          items: [
            {
              content: ["Committed caller message"],
              id: "message-1",
              role: "user",
              transcript_confidence: 0.92,
              type: "message",
            },
          ],
        },
        sdk_version: "1.5.5",
      },
      status: "COMPLETED",
      turnMetrics: [
        {
          createdAt: 1_721_466_010_000,
          interrupted: false,
          itemId: "message-1",
          metrics: { ttft: 0.42 },
          role: "user",
          type: "message",
        },
      ],
    });
    expect(deliveries[0]).not.toHaveProperty("phase");
    expect(deliveries[0]).not.toHaveProperty("envelope");
    expect(JSON.stringify(deliveries)).not.toContain("function-call-private");
    expect(JSON.stringify(deliveries)).not.toContain(
      "private-recording-location",
    );
    expect(result).toEqual({
      finalResult: { ok: true, status: 200 },
      timedOut: false,
    });
  });

  it("bounds a hanging final write", async () => {
    class HangingFinalPortal implements CallCapturePortal {
      async deliver(): Promise<CallCapturePortalResult> {
        return new Promise(() => {});
      }
    }
    const logger = { warn: vi.fn() };
    const { events } = setupCapture({
      finalizationTimeoutMs: 40,
      logger,
      portal: new HangingFinalPortal(),
    });

    const startedAt = Date.now();
    const result = await events.close();

    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(result).toEqual({
      finalResult: { ok: false },
      timedOut: true,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "[call-capture] final delivery incomplete timedOut=true finalOk=false",
    );
  });

  it("deduplicates and sanitizes tool outcomes in the final payload", async () => {
    const { events, portal } = setupCapture();
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

    events.emit({ event, type: "tools-executed" });
    events.emit({ event, type: "tools-executed" });
    await events.close();

    const final = (portal as InMemoryCallCapturePortal).deliveries.at(
      -1,
    )?.payload;
    expect(final?.toolExecutions).toEqual([
      {
        callId: "tool-call-1",
        createdAt: "2026-07-20T10:00:30.000Z",
        outputClass: "appointment_booked",
        status: "success",
        toolName: "book_appointment",
      },
    ]);
    expect(JSON.stringify(final?.toolExecutions)).not.toContain("Private");
    expect(JSON.stringify(final?.toolExecutions)).not.toContain(
      "private-appointment-id",
    );
  });

  it("preserves latest usage and PHI-free workflow observations", async () => {
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
    recordOwnedMiddlewareFailure(state, "bookAppointment", {
      detail: "missing_appointment_id",
      reason: "invalid_response",
    });
    recordAppointmentAction(state, {
      action: "booked",
      message: "Private appointment details",
      status: "success",
      toolName: "book_appointment",
    });
    const { events, portal } = setupCapture({ state });
    events.emit({
      type: "usage-updated",
      usage: { source: "latest-event" },
    });

    await events.close();

    const final = (portal as InMemoryCallCapturePortal).deliveries.at(
      -1,
    )?.payload;
    expect(final).toMatchObject({
      appointmentActions: [{ action: "booked", status: "success" }],
      availabilityReads: [{ durationMs: 125, operation: "middleware_call" }],
      identityTransitions: [
        { outcome: "pending", source: "pre_call_phone_lookup" },
      ],
      knowledgeRetrievals: [
        { officeKey: "test-office", outcome: "matched", topic: "pricing" },
      ],
      ownedMiddlewareFailures: [
        {
          detail: "missing_appointment_id",
          operation: "bookAppointment",
          reason: "invalid_response",
        },
      ],
      usage: { source: "latest-event" },
    });
    expect(final?.toolExecutions).toMatchObject([
      {
        outputClass: "appointment_booked",
        status: "success",
        toolName: "book_appointment",
      },
    ]);
    expect(JSON.stringify(final?.toolExecutions)).not.toContain("Private");
  });

  it("removes private candidate and appointment selectors from final state", async () => {
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
    const { events, portal } = setupCapture({ state });

    await events.close();

    const serialized = JSON.stringify(
      (portal as InMemoryCallCapturePortal).deliveries.at(-1)?.payload,
    );
    expect(serialized).not.toContain("private-patient-backend-id");
    expect(serialized).not.toContain("private-candidate-id");
    expect(serialized).not.toContain("private-booking-token");
    expect(serialized).not.toContain("01/02/1980");
    expect(serialized).not.toContain("Private");
    expect(serialized).not.toContain("Candidate");
  });

  it.each([
    ["accepted", acceptTransfer, "ESCALATED"],
    ["pending", beginTransfer, "COMPLETED"],
    ["ambiguous", markTransferAmbiguous, "COMPLETED"],
  ])("classifies %s transfer final state", async (_, transition, status) => {
    const state = createTestCallState();
    transition(state);
    const { events, portal } = setupCapture({ state });

    await events.close();

    expect(
      (portal as InMemoryCallCapturePortal).deliveries.at(-1)?.payload.status,
    ).toBe(status);
  });

  it("records failed initialization and duration-limit final states", async () => {
    const missingState = setupCapture({ state: null });
    await missingState.events.close();
    expect(
      (missingState.portal as InMemoryCallCapturePortal).deliveries.at(-1)
        ?.payload,
    ).toMatchObject({
      endedReason: "call_state_not_initialized",
      status: "FAILED",
    });

    const durationLimit = setupCapture();
    durationLimit.events.emit({ type: "duration-limit" });
    await durationLimit.events.close();
    expect(
      (durationLimit.portal as InMemoryCallCapturePortal).deliveries.at(-1)
        ?.payload,
    ).toMatchObject({
      endedReason: "duration_limit",
      maxCallDurationMs: 1_800_000,
      status: "COMPLETED",
    });
  });

  it("uses the existing portal URL and bearer authentication", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 200 }),
    ) as unknown as typeof fetch;
    const logger = { log: vi.fn(), warn: vi.fn() };
    const portal = new HttpCallCapturePortal({
      fetchImpl,
      logger,
      secret: "test-secret",
      url: "https://portal.example.test/api/livekit/calls",
    });

    await portal.deliver({
      payload: { callId: "call-test", status: "COMPLETED" },
      timeoutMs: 1_000,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://portal.example.test/api/livekit/calls",
      expect.objectContaining({
        headers: {
          Authorization: "Bearer test-secret",
          "Content-Type": "application/json",
        },
        method: "POST",
      }),
    );
    expect(logger.log.mock.calls.flat().join(" ")).not.toContain("test-secret");
  });

  it("skips delivery when the existing portal URL is unavailable", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 200 }),
    ) as unknown as typeof fetch;
    const portal = new HttpCallCapturePortal({ fetchImpl });

    await expect(
      portal.deliver({
        payload: { callId: "call-test" },
        timeoutMs: 1_000,
      }),
    ).resolves.toEqual({ ok: false, skipped: true });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not send final call data without bearer authentication", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 200 }),
    ) as unknown as typeof fetch;
    const logger = { log: vi.fn(), warn: vi.fn() };
    const portal = new HttpCallCapturePortal({
      fetchImpl,
      logger,
      url: "https://portal.example.test/api/livekit/calls",
    });

    await expect(
      portal.deliver({
        payload: { callId: "call-test", transcript: "Sensitive transcript" },
        timeoutMs: 1_000,
      }),
    ).resolves.toEqual({ ok: false, skipped: true });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "[call-capture] final delivery skipped reason=missing_auth",
    );
    expect(logger.warn.mock.calls.flat().join(" ")).not.toContain("Sensitive");
  });

  it("prefers the LiveKit portal secret over the legacy secret", () => {
    expect(
      getAnalyticsSecret({
        LIVEKIT_FORWARD_SYNC_SECRET: "livekit-secret",
        WEBHOOK_SECRET: "legacy-secret",
      }),
    ).toBe("livekit-secret");
  });
});
