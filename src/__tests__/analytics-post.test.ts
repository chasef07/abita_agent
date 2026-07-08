import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getAnalyticsSecret,
  postAnalyticsPayload,
  postShutdownAnalyticsPayloads,
} from "../runtime/analytics-post.js";

describe("analytics POST", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("prefers the LiveKit forward sync secret over the legacy webhook secret", () => {
    expect(
      getAnalyticsSecret({
        LIVEKIT_FORWARD_SYNC_SECRET: "livekit-secret",
        WEBHOOK_SECRET: "legacy-secret",
      }),
    ).toBe("livekit-secret");
  });

  it("posts JSON with bearer auth", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));

    const result = await postAnalyticsPayload(
      {
        callId: "call-123",
        status: "IN_PROGRESS",
      },
      {
        fetchImpl: fetchMock,
        logger: { log: vi.fn(), warn: vi.fn() },
        phase: "call-start",
        secret: "secret",
        url: "https://portal.example/api/livekit/calls",
      },
    );

    expect(result).toMatchObject({ attempts: 1, ok: true, status: 200 });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://portal.example/api/livekit/calls",
      expect.objectContaining({
        body: JSON.stringify({
          callId: "call-123",
          status: "IN_PROGRESS",
        }),
        headers: {
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
        },
        method: "POST",
      }),
    );
  });

  it("retries non-OK responses", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("nope", { status: 503 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const result = await postAnalyticsPayload(
      { callId: "call-123", status: "COMPLETED" },
      {
        fetchImpl: fetchMock,
        logger: { log: vi.fn(), warn: vi.fn() },
        maxAttempts: 2,
        phase: "shutdown",
        retryDelayMs: 0,
        url: "https://portal.example/api/livekit/calls",
      },
    );

    expect(result).toMatchObject({ attempts: 2, ok: true, status: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("skips when no analytics URL is configured", async () => {
    const fetchMock = vi.fn();

    const result = await postAnalyticsPayload(
      { callId: "call-123", status: "IN_PROGRESS" },
      {
        fetchImpl: fetchMock,
        logger: { log: vi.fn(), warn: vi.fn() },
        phase: "call-start",
      },
    );

    expect(result).toEqual({ attempts: 0, ok: false, skipped: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts a compact shutdown summary before the rich shutdown payload", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));

    const result = await postShutdownAnalyticsPayloads(
      { callId: "call-123", status: "COMPLETED" },
      {
        callId: "call-123",
        sessionReport: { chat_history: { items: [] } },
        status: "COMPLETED",
      },
      {
        fetchImpl: fetchMock,
        logger: { log: vi.fn(), warn: vi.fn() },
        url: "https://portal.example/api/livekit/calls",
      },
    );

    expect(result.summaryResult).toMatchObject({
      attempts: 1,
      ok: true,
      status: 200,
    });
    expect(result.richResult).toMatchObject({
      attempts: 1,
      ok: true,
      status: 200,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      callId: "call-123",
      status: "COMPLETED",
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      callId: "call-123",
      sessionReport: { chat_history: { items: [] } },
      status: "COMPLETED",
    });
  });

  it("still posts rich shutdown payload after summary retries are exhausted", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("too busy", { status: 503 }))
      .mockResolvedValueOnce(new Response("still busy", { status: 503 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const result = await postShutdownAnalyticsPayloads(
      { callId: "call-123", status: "COMPLETED" },
      { callId: "call-123", sessionReport: {}, status: "COMPLETED" },
      {
        fetchImpl: fetchMock,
        logger: { log: vi.fn(), warn: vi.fn() },
        url: "https://portal.example/api/livekit/calls",
      },
    );

    expect(result.summaryResult).toMatchObject({
      attempts: 2,
      ok: false,
      status: 503,
    });
    expect(result.richResult).toMatchObject({
      attempts: 1,
      ok: true,
      status: 200,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
