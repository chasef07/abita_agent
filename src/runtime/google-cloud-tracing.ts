import { telemetry, type JobContext } from "@livekit/agents";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  NodeTracerProvider,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-node";

export function setupGoogleCloudTracing(
  ctx: Pick<JobContext, "addShutdownCallback">,
  env: NodeJS.ProcessEnv = process.env,
): NodeTracerProvider | undefined {
  const endpoint = env.GOOGLE_CLOUD_TRACE_ENDPOINT?.trim();
  const token = env.GOOGLE_CLOUD_TRACE_TOKEN?.trim();
  if (!endpoint && !token) return;
  if (!endpoint || !token) {
    throw new Error(
      "GOOGLE_CLOUD_TRACE_ENDPOINT and GOOGLE_CLOUD_TRACE_TOKEN are required together",
    );
  }
  const url = URL.canParse(endpoint) ? new URL(endpoint) : undefined;
  if (
    !url ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/v1/traces"
  ) {
    throw new Error(
      "GOOGLE_CLOUD_TRACE_ENDPOINT must be an HTTPS /v1/traces URL without credentials or query parameters",
    );
  }
  // The collector authenticates to Google using its attached service identity.
  // Only the scoped collector token crosses the LiveKit deployment boundary.
  const otlp = new OTLPTraceExporter({
    url: url.href,
    timeoutMillis: 15_000,
    headers: { Authorization: `Bearer ${token}` },
  });
  const exporter: SpanExporter = {
    export(spans, callback) {
      otlp.export(spans, (result) => {
        if (result.code !== 0) {
          // Auth/HTTP errors can contain credentials or request payloads.
          console.error("[tracing] Google Cloud trace export failed", {
            spanCount: spans.length,
          });
        }
        callback(result);
      });
    },
    shutdown: () => otlp.shutdown(),
  };
  const fanout = new telemetry.FanoutSpanProcessor();
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      "service.name": "abita-agent",
      "deployment.environment.name":
        env.LIVEKIT_AGENT_DEPLOYMENT?.trim() ||
        (env.NODE_ENV === "production" ? "production" : "development"),
    }),
    spanProcessors: [
      new BatchSpanProcessor(exporter, { exportTimeoutMillis: 17_000 }),
      fanout,
    ],
  });
  provider.register();
  telemetry.setTracerProvider(provider, {
    // Retain recorded conversation and tool payloads for call investigation.
    // LiveKit's project-enforced redaction policy still takes precedence.
    allowPii: true,
    registerSpanProcessor: (processor) => fanout.add(processor),
  });
  // LiveKit finalizes the session before running job shutdown callbacks.
  ctx.addShutdownCallback(async () => {
    try {
      await provider.shutdown();
    } catch {
      console.error("[tracing] Google Cloud trace shutdown failed");
    }
  });
  console.info("[tracing] Google Cloud trace export enabled");
  return provider;
}
