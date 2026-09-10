import { telemetry } from "@livekit/agents";
import {
  context,
  propagation,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupGoogleCloudTracing } from "../runtime/google-cloud-tracing.js";

const transport = vi.hoisted(() => ({
  options: undefined as
    { url: string; headers: Record<string, string> } | undefined,
  batches: [] as ReadableSpan[][],
  error: undefined as Error | undefined,
}));

vi.mock("@opentelemetry/exporter-trace-otlp-proto", () => ({
  OTLPTraceExporter: class {
    constructor(options: typeof transport.options) {
      transport.options = options;
    }
    export(
      spans: ReadableSpan[],
      callback: (result: { code: number; error?: Error }) => void,
    ) {
      transport.batches.push(spans);
      callback(
        transport.error ? { code: 1, error: transport.error } : { code: 0 },
      );
    }
    async shutdown() {}
  },
}));

describe("Google Cloud trace export", () => {
  let callbacks: (() => Promise<void>)[];
  const ctx = {
    addShutdownCallback: (callback: () => Promise<void>) =>
      callbacks.push(callback),
  };

  beforeEach(() => {
    callbacks = [];
    transport.options = undefined;
    transport.batches = [];
    transport.error = undefined;
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    for (const callback of callbacks) await callback();
    trace.disable();
    context.disable();
    propagation.disable();
    vi.restoreAllMocks();
  });

  it("leaves the existing LiveKit provider alone when disabled", () => {
    const existing = telemetry.tracer.getProvider();
    expect(setupGoogleCloudTracing(ctx, {})).toBeUndefined();
    expect(telemetry.tracer.getProvider()).toBe(existing);
    expect(transport.options).toBeUndefined();
    expect(callbacks).toEqual([]);
  });

  it("protects pilot native LiveKit exports when no Google collector is configured", async () => {
    const add = vi.spyOn(telemetry.FanoutSpanProcessor.prototype, "add");
    const provider = setupGoogleCloudTracing(ctx, {
      ACUITY_PRODUCT_KNOWLEDGE_PILOT: "spring-hill",
    })!;
    expect(provider).toBeDefined();
    expect(transport.options).toBeUndefined();
    const destination = new InMemorySpanExporter();
    add.mock.contexts[0].add(new SimpleSpanProcessor(destination));
    telemetry.tracer
      .startSpan({
        name: "function_tool",
        attributes: {
          "lk.function_tool.name": "search_office_knowledge",
          "lk.pii.function_tool.arguments": "sensitive-query",
          "gen_ai.tool.call.arguments": "sensitive-query",
          "gen_ai.tool.call.id": "knowledge-1",
        },
      })
      .end();
    await provider.forceFlush();
    expect(
      JSON.stringify(
        destination.getFinishedSpans().map((span) => span.attributes),
      ),
    ).not.toContain("sensitive-query");
    expect(
      destination.getFinishedSpans()[0].attributes["gen_ai.tool.call.id"],
    ).toBe("knowledge-1");
  });

  it("rejects a malformed destination before installing a provider", () => {
    expect(() =>
      setupGoogleCloudTracing(ctx, {
        GOOGLE_CLOUD_TRACE_ENDPOINT: "http://collector.example/v1/traces",
        GOOGLE_CLOUD_TRACE_TOKEN: "test-token",
      }),
    ).toThrow("GOOGLE_CLOUD_TRACE_ENDPOINT must be an HTTPS /v1/traces URL");
    expect(transport.options).toBeUndefined();
  });

  it("never includes malformed endpoint content in configuration errors", () => {
    const endpoint = "synthetic-private-invalid-endpoint";
    let error: unknown;
    try {
      setupGoogleCloudTracing(ctx, {
        GOOGLE_CLOUD_TRACE_ENDPOINT: endpoint,
        GOOGLE_CLOUD_TRACE_TOKEN: "test-token",
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("must be an HTTPS");
    expect(String(error)).not.toContain(endpoint);
    expect(JSON.stringify(error)).not.toContain(endpoint);
  });

  it.each([false, true])(
    "exports content unless project redaction is enforced (%s)",
    async (redactionEnabled) => {
      const provider = setupGoogleCloudTracing(ctx, {
        GOOGLE_CLOUD_TRACE_ENDPOINT: "https://collector.example/v1/traces",
        GOOGLE_CLOUD_TRACE_TOKEN: "test-token",
        LIVEKIT_AGENT_DEPLOYMENT: "staging",
      })!;
      const parent = telemetry.tracer.startSpan({ name: "agent_session" });
      const child = telemetry.tracer.startSpan({
        name: "function_tool",
        context: trace.setSpan(context.active(), parent),
        attributes: {
          "lk.redaction.enabled": redactionEnabled,
          "lk.job_id": "synthetic-job",
          "gen_ai.usage.input_tokens": 10,
          "lk.pii.function_tool.arguments": "synthetic-private-arguments",
          "lk.pii.function_tool.output": "synthetic-private-result",
          "gen_ai.tool.call.arguments": "synthetic-private-arguments",
          "gen_ai.tool.call.result": "synthetic-private-result",
          "gen_ai.output.messages": "synthetic-private-response",
          "gen_ai.input.messages": "synthetic-private-chat",
        },
      });
      child.addEvent("gen_ai.user.message", {
        content: "synthetic-private-message",
      });
      child.recordException(new Error("synthetic-private-error"));
      child.setStatus({
        code: SpanStatusCode.ERROR,
        message: "synthetic-private-status",
      });
      child.end();
      parent.end();
      await provider.forceFlush();

      const spans = transport.batches.flat();
      expect(spans).toHaveLength(2);
      const exported = spans.find((span) => span.name === "function_tool")!;
      expect(exported.spanContext().traceId).toBe(parent.spanContext().traceId);
      expect(exported.attributes).toMatchObject({
        "lk.job_id": "synthetic-job",
        "gen_ai.usage.input_tokens": 10,
      });
      expect(exported.resource.attributes).toMatchObject({
        "service.name": "abita-agent",
        "deployment.environment.name": "staging",
      });
      const content = JSON.stringify({
        attributes: exported.attributes,
        events: exported.events,
        status: exported.status,
      });
      if (redactionEnabled) {
        expect(content).not.toContain("synthetic-private");
      } else {
        expect(exported.attributes).toMatchObject({
          "lk.pii.function_tool.arguments": "synthetic-private-arguments",
          "lk.pii.function_tool.output": "synthetic-private-result",
          "gen_ai.tool.call.arguments": "synthetic-private-arguments",
          "gen_ai.tool.call.result": "synthetic-private-result",
          "gen_ai.input.messages": "synthetic-private-chat",
          "gen_ai.output.messages": "synthetic-private-response",
        });
        expect(content).toContain("synthetic-private-message");
        expect(content).toContain("synthetic-private-error");
        expect(exported.status.message).toBe("synthetic-private-status");
      }
      expect(exported.status.code).toBe(SpanStatusCode.ERROR);
    },
  );

  it("redacts knowledge tool payloads and message copies while retaining other tools", async () => {
    const provider = setupGoogleCloudTracing(ctx, {
      GOOGLE_CLOUD_TRACE_ENDPOINT: "https://collector.example/v1/traces",
      GOOGLE_CLOUD_TRACE_TOKEN: "test-token",
    })!;
    telemetry.tracer
      .startSpan({
        name: "function_tool",
        attributes: {
          "lk.function_tool.name": "search_office_knowledge",
          "lk.pii.function_tool.arguments": "sensitive-query",
          "gen_ai.tool.call.arguments": "sensitive-query",
          "gen_ai.tool.call.result": "sensitive-passage",
          "gen_ai.tool.call.id": "knowledge-1",
        },
      })
      .end();
    telemetry.tracer
      .startSpan({
        name: "llm_node",
        attributes: {
          "gen_ai.input.messages": JSON.stringify([
            {
              role: "assistant",
              parts: [
                {
                  type: "tool_call",
                  id: "knowledge-1",
                  name: "search_office_knowledge",
                  arguments: { query: "sensitive-query" },
                },
              ],
            },
            {
              role: "tool",
              parts: [
                {
                  type: "tool_call_response",
                  id: "knowledge-1",
                  response: "sensitive-passage",
                },
              ],
            },
            {
              role: "assistant",
              parts: [
                {
                  type: "tool_call",
                  id: "other-1",
                  name: "check_insurance",
                  arguments: { plan: "existing-policy-content" },
                },
              ],
            },
          ]),
        },
      })
      .end();
    await provider.forceFlush();
    const exported = JSON.stringify(
      transport.batches.flat().map((span) => span.attributes),
    );
    expect(exported).not.toContain("sensitive-query");
    expect(exported).not.toContain("sensitive-passage");
    expect(exported).toContain("existing-policy-content");
    expect(exported).toContain("knowledge-1");
  });

  it("retains the registrar LiveKit needs to add its own span processor", async () => {
    const add = vi.spyOn(telemetry.FanoutSpanProcessor.prototype, "add");
    const provider = setupGoogleCloudTracing(ctx, {
      GOOGLE_CLOUD_TRACE_ENDPOINT: "https://collector.example/v1/traces",
      GOOGLE_CLOUD_TRACE_TOKEN: "test-token",
    })!;
    const fanout = add.mock.contexts[0];
    const additionalDestination = new InMemorySpanExporter();
    fanout.add(new SimpleSpanProcessor(additionalDestination));
    telemetry.tracer.startSpan({ name: "shared-session" }).end();
    await provider.forceFlush();
    expect(transport.batches.flat()).toHaveLength(1);
    expect(additionalDestination.getFinishedSpans()).toHaveLength(1);
    expect(additionalDestination.getFinishedSpans()[0].spanContext()).toEqual(
      transport.batches[0][0].spanContext(),
    );
  });

  it("authenticates to the collector and rejects incomplete configuration", () => {
    expect(() =>
      setupGoogleCloudTracing(ctx, {
        GOOGLE_CLOUD_TRACE_ENDPOINT: "https://collector.example/v1/traces",
      }),
    ).toThrow("required together");
    setupGoogleCloudTracing(ctx, {
      GOOGLE_CLOUD_TRACE_ENDPOINT: "https://collector.example/v1/traces",
      GOOGLE_CLOUD_TRACE_TOKEN: "test-token",
    });
    expect(transport.options).toMatchObject({
      url: "https://collector.example/v1/traces",
      headers: { Authorization: "Bearer test-token" },
    });
  });

  it("flushes final spans on job shutdown", async () => {
    setupGoogleCloudTracing(ctx, {
      GOOGLE_CLOUD_TRACE_ENDPOINT: "https://collector.example/v1/traces",
      GOOGLE_CLOUD_TRACE_TOKEN: "test-token",
    });
    telemetry.tracer.startSpan({ name: "final-session-span" }).end();
    expect(transport.batches).toEqual([]);
    await callbacks[0]();
    expect(transport.batches.flat().map((span) => span.name)).toEqual([
      "final-session-span",
    ]);
  });

  it("reports export failures without leaking the transport error or throwing into the call", async () => {
    const provider = setupGoogleCloudTracing(ctx, {
      GOOGLE_CLOUD_TRACE_ENDPOINT: "https://collector.example/v1/traces",
      GOOGLE_CLOUD_TRACE_TOKEN: "test-token",
    })!;
    transport.error = new Error("synthetic-private-credential-and-payload");
    expect(() =>
      telemetry.tracer.startSpan({ name: "failed-export" }).end(),
    ).not.toThrow();
    await expect(provider.forceFlush()).rejects.toBeDefined();
    expect(console.error).toHaveBeenCalledWith(
      "[tracing] Google Cloud trace export failed",
      { spanCount: 1 },
    );
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
      "synthetic-private",
    );
  });
});
