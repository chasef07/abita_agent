import { afterEach, expect, it, vi } from "vitest";
import { isFunctionTool, tool } from "@livekit/agents";
import { trace } from "@opentelemetry/api";
import { z } from "zod";
import { HttpOwnedMiddleware } from "../clients/owned-middleware.js";
import {
  middlewareDiagnosticContext,
  type MiddlewareRequestDiagnostic,
  readMiddlewareHeaders,
} from "../clients/middleware-diagnostics.js";
import { withMiddlewareToolDiagnostics } from "../runtime/middleware-tool-diagnostics.js";
import {
  recordDomainOutcome,
  domainOutcomeReceipts,
} from "../state/observability.js";
import { createTestCallState } from "./support/call-state.js";
import { createToolContext } from "./support/tool-context.js";

const office = "+17275919997";
afterEach(() => vi.restoreAllMocks());

it("preserves both read attempts through tool normalization, trace and persisted domain receipt", async () => {
  const span = {
    addEvent: vi.fn(),
    setAttribute: vi.fn(),
    setStatus: vi.fn(),
    end: vi.fn(),
  };
  vi.spyOn(trace, "getTracer").mockReturnValue({
    startActiveSpan: (
      _name: unknown,
      _options: unknown,
      callback: (value: unknown) => unknown,
    ) => callback(span),
  } as never);
  vi.spyOn(trace, "getActiveSpan").mockReturnValue(span as never);
  const sentIDs: string[] = [];
  const middleware = new HttpOwnedMiddleware({
    middlewareBaseUrl: "https://middleware.example",
    fetch: vi.fn(async (_url, options) => {
      const id = new Headers(options?.headers).get("X-Request-ID")!;
      sentIDs.push(id);
      return Response.json(
        { status: "error", message: "synthetic-private-patient" },
        {
          headers: {
            "X-Request-ID": id,
            "X-Abita-Outcome": "provider_failure",
            "X-Abita-Error-Category": "timeout",
            "X-Abita-Provider-Errors": JSON.stringify([
              {
                operation: "lookuppatient",
                category: "timeout",
                durationMs: 30000,
              },
            ]),
            "X-Abita-Provider-Error-Count": "1",
          },
        },
      );
    }),
  });
  const state = createTestCallState();
  const entry = withMiddlewareToolDiagnostics(
    tool({
      name: "resolve_patient",
      description: "Resolve the patient for diagnostics testing.",
      parameters: z.object({}),
      execute: async () => {
        const result = await middleware.resolvePatient({
          office,
          identity: { phone: "synthetic-private-patient" },
        });
        expect(result).toEqual({ status: "error", reason: "middleware_error" });
        recordDomainOutcome(state, {
          callId: "tool-1",
          toolName: "resolve_patient",
          outcome: "patient_lookup_failed",
          status: "failed",
        });
        throw new Error("expected tool failure");
      },
    }),
  );
  if (!isFunctionTool(entry)) throw new Error("missing tool");
  await expect(
    entry.execute({}, {
      ctx: createToolContext(state),
      toolCallId: "tool-1",
    } as never),
  ).rejects.toThrow("expected tool failure");
  const receipts = domainOutcomeReceipts(state);
  expect(receipts).toHaveLength(1);
  expect(receipts[0]).toMatchObject({
    callId: "tool-1",
    outcome: "patient_lookup_failed",
    status: "failed",
    middlewareRequests: [
      {
        requestId: sentIDs[0],
        operation: "resolvePatient",
        attempt: 1,
        failureReason: "middleware_error",
        retryable: true,
        httpStatus: 200,
        category: "timeout",
        providerErrors: [{ operation: "lookuppatient", category: "timeout" }],
      },
      {
        requestId: sentIDs[1],
        attempt: 2,
        failureReason: "middleware_error",
        retryable: true,
      },
    ],
  });
  expect(new Set(sentIDs).size).toBe(2);
  expect(JSON.stringify(receipts)).not.toContain("synthetic-private-patient");
  expect(span.setAttribute).toHaveBeenCalledWith(
    "abita.middleware.requests",
    JSON.stringify(receipts[0]?.middlewareRequests),
  );
  expect(span.addEvent).toHaveBeenCalledTimes(2);
});

it("keeps indeterminate mutation outcomes and provider status without replaying writes", async () => {
  const fetch = vi.fn(async () =>
    Response.json(
      { status: "error", outcome: "indeterminate_write" },
      {
        headers: {
          "X-Abita-Provider-Errors": JSON.stringify([
            {
              operation: "cancel_appointment",
              category: "upstream_status",
              httpStatus: 503,
              durationMs: 100,
            },
          ]),
        },
      },
    ),
  );
  const middleware = new HttpOwnedMiddleware({
    middlewareBaseUrl: "https://middleware.example",
    fetch,
  });
  const requests: MiddlewareRequestDiagnostic[] = [];
  const result = await middlewareDiagnosticContext.run(requests, () =>
    middleware.cancelAppointment({
      office,
      appointmentId: 1,
      patientId: "synthetic",
    }),
  );
  expect(result).toEqual({ status: "error", reason: "request_rejected" });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(requests[0]).toMatchObject({
    outcome: "indeterminate_write",
    providerErrors: [{ httpStatus: 503 }],
  });
});

it("distinguishes timeout from network error while retaining the existing retry reason", async () => {
  for (const timeout of [true, false]) {
    const requests: MiddlewareRequestDiagnostic[] = [];
    const middleware = new HttpOwnedMiddleware({
      middlewareBaseUrl: "https://middleware.example",
      timeoutMs: 5,
      fetch: async (_url, options) => {
        if (!timeout) throw new TypeError("synthetic-private-network-message");
        await new Promise((_resolve, reject) =>
          options?.signal?.addEventListener(
            "abort",
            () => reject(options.signal?.reason),
            { once: true },
          ),
        );
        throw new Error("unreachable");
      },
    });
    const result = await middlewareDiagnosticContext.run(requests, () =>
      middleware.resolvePatient({ office, identity: { phone: "synthetic" } }),
    );
    expect(result).toEqual({ status: "error", reason: "network_error" });
    expect(requests[0]).toMatchObject({
      result: timeout ? "timeout" : "network_error",
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(JSON.stringify(requests)).not.toContain("synthetic-private");
  }
});

it("isolates concurrent tool scopes", async () => {
  const requests = [[], []] as MiddlewareRequestDiagnostic[][];
  const middleware = new HttpOwnedMiddleware({
    middlewareBaseUrl: "https://middleware.example",
    fetch: async () => Response.json({ status: "not_found" }),
  });
  await Promise.all(
    requests.map((scope) =>
      middlewareDiagnosticContext.run(scope, () =>
        middleware.resolvePatient({ office, identity: { phone: "synthetic" } }),
      ),
    ),
  );
  expect(requests.map((scope) => scope.length)).toEqual([1, 1]);
  expect(requests[0]?.[0]?.requestId).not.toBe(requests[1]?.[0]?.requestId);
});

it("allows only safe provider metadata and caps retained provider errors", () => {
  const request: MiddlewareRequestDiagnostic = {
    requestId: "fb672b37-0211-4e69-baf1-b0f56b181911",
    operation: "resolvePatient",
    attempt: 1,
    durationMs: 0,
    result: "response",
  };
  readMiddlewareHeaders(
    new Headers({
      "X-Abita-Error-Category": "private-patient",
      "X-Abita-Provider-Errors": JSON.stringify(
        Array.from({ length: 10 }, () => ({
          operation: "lookuppatient",
          category: "rejected",
          durationMs: 1,
          httpStatus: 999,
          code: "private-patient",
          message: "private-patient",
        })),
      ),
    }),
    request,
  );
  expect(request.providerErrors).toHaveLength(8);
  expect(JSON.stringify(request)).not.toContain("private-patient");
  expect(request.providerErrors?.[0]).not.toHaveProperty("httpStatus");
});

it("retains a recovered retry and the independent appointment-load status without changing verified identity", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ status: "error" }))
    .mockResolvedValueOnce(
      Response.json({
        status: "verified",
        patientId: "synthetic",
        name: "Synthetic Patient",
        dob: "01/01/1990",
        appointmentsStatus: "error",
        appointments: [],
      }),
    );
  const middleware = new HttpOwnedMiddleware({
    middlewareBaseUrl: "https://middleware.example",
    fetch,
  });
  const state = createTestCallState();
  const entry = withMiddlewareToolDiagnostics(
    tool({
      name: "resolve_patient",
      description: "Resolve the patient for diagnostics testing.",
      parameters: z.object({}),
      execute: async () => {
        const result = await middleware.resolvePatient({
          office,
          identity: { phone: "synthetic" },
        });
        expect(result.status).toBe("verified");
        recordDomainOutcome(state, {
          callId: "recovered",
          toolName: "resolve_patient",
          outcome: "patient_verified",
          status: "success",
        });
        return "Verified identity; appointments could not be loaded.";
      },
    }),
  );
  if (!isFunctionTool(entry)) throw new Error("missing tool");
  await entry.execute({}, {
    ctx: createToolContext(state),
    toolCallId: "recovered",
  } as never);
  expect(domainOutcomeReceipts(state)[0]).toMatchObject({
    status: "success",
    outcome: "patient_verified",
    middlewareRequests: [
      { attempt: 1, failureReason: "middleware_error", retryable: true },
      { attempt: 2, responseStatus: "verified", appointmentsStatus: "error" },
    ],
  });
});

it("records diagnostics alone when a tool has no domain receipt, without inventing domain success", async () => {
  const middleware = new HttpOwnedMiddleware({
    middlewareBaseUrl: "https://middleware.example",
    fetch: async () => Response.json({ status: "not_found" }),
  });
  const state = createTestCallState();
  const entry = withMiddlewareToolDiagnostics(
    tool({
      name: "list_available_appointments",
      description: "List appointments for diagnostics testing.",
      parameters: z.object({}),
      execute: async () => {
        await middleware.resolvePatient({
          office,
          identity: { phone: "synthetic" },
        });
        return "A tool response alone is not a domain outcome.";
      },
    }),
  );
  if (!isFunctionTool(entry)) throw new Error("missing tool");
  await entry.execute({}, {
    ctx: createToolContext(state),
    toolCallId: "diagnostic-only",
  } as never);
  expect(domainOutcomeReceipts(state)[0]).toMatchObject({
    outcome: "middleware_diagnostics",
    status: "observed",
    middlewareRequests: [{ operation: "resolvePatient" }],
  });
});

it.each([
  ["cancel", "invalid_cancellation_token"],
  ["book", "invalid_booking_token"],
  ["book", "booking_token_required"],
  ["book", "invalid_reschedule_token"],
] as const)(
  "retains %s rejection %s without replaying the request",
  async (operation, outcome) => {
    const fetch = vi.fn(async () =>
      Response.json({ status: "error", outcome }),
    );
    const middleware = new HttpOwnedMiddleware({
      middlewareBaseUrl: "https://middleware.example",
      fetch,
    });
    const requests: MiddlewareRequestDiagnostic[] = [];
    const result = await middlewareDiagnosticContext.run(requests, () =>
      operation === "cancel"
        ? middleware.cancelAppointment({
            office,
            cancellationToken: "synthetic-token",
          })
        : middleware.bookAppointment({
            office,
            booking: {
              bookingToken: "synthetic-token",
              patientId: "synthetic-patient",
              visitCategory: "medical",
              patientStatus: "established",
              appointmentReason: "synthetic",
              referringDoctor: "none",
            },
          }),
    );
    expect(result).toMatchObject({ status: "rejected", reason: outcome });
    expect(requests[0]).toMatchObject({
      outcome,
      failureReason: outcome,
      retryable: false,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);

it("retains the safe missing appointment ID detail without raw provider data", async () => {
  const fetch = vi.fn(async () =>
    Response.json({
      status: "booked",
      message: "synthetic-private-provider-body",
    }),
  );
  const middleware = new HttpOwnedMiddleware({
    middlewareBaseUrl: "https://middleware.example",
    fetch,
  });
  const requests: MiddlewareRequestDiagnostic[] = [];
  const result = await middlewareDiagnosticContext.run(requests, () =>
    middleware.bookAppointment({
      office,
      booking: {
        bookingToken: "synthetic-token",
        patientId: "synthetic-patient",
        visitCategory: "medical",
        patientStatus: "established",
        appointmentReason: "synthetic",
        referringDoctor: "none",
      },
    }),
  );
  expect(result).toEqual({
    status: "error",
    reason: "invalid_response",
    detail: "missing_appointment_id",
  });
  expect(requests[0]).toMatchObject({
    responseStatus: "booked",
    failureReason: "invalid_response",
    failureDetail: "missing_appointment_id",
    retryable: false,
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(requests)).not.toContain(
    "synthetic-private-provider-body",
  );
});
