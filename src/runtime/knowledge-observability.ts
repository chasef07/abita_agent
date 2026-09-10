import { log, type JobContext } from "@livekit/agents";
import type { SpanProcessor, Span } from "@opentelemetry/sdk-trace-node";

const TOOL = "search_office_knowledge";
const REDACTED = "[knowledge payload omitted]";
const PAYLOAD_KEYS = new Set([
  "arguments",
  "args",
  "output",
  "result",
  "response",
]);

/** Covers native GenAI parts and serialized ChatContext call/output pairs. */
export function redactKnowledgePayload(value: unknown): unknown {
  const ids = new Set<string>();
  function collect(value: unknown): void {
    if (Array.isArray(value)) {
      value.forEach(collect);
      return;
    }
    if (!value || typeof value !== "object") return;
    const item = value as Record<string, unknown>;
    if (item.name === TOOL) {
      for (const key of ["id", "callId", "call_id"])
        if (typeof item[key] === "string") ids.add(item[key]);
    }
    Object.values(item).forEach(collect);
  }
  function redact(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(redact);
    if (!value || typeof value !== "object") return value;
    const item = value as Record<string, unknown>;
    const targeted =
      item.name === TOOL ||
      [item.id, item.callId, item.call_id].some(
        (id) => typeof id === "string" && ids.has(id),
      );
    return Object.fromEntries(
      Object.entries(item).map(([key, val]) => [
        key,
        targeted && PAYLOAD_KEYS.has(key) ? REDACTED : redact(val),
      ]),
    );
  }
  collect(value);
  return redact(value);
}

/** Before all registered exporters, including LiveKit's own fanout. */
export const knowledgeSpanProcessor: SpanProcessor = {
  onStart() {},
  onEnding(span: Span) {
    const attrs = span.attributes as Record<string, unknown>;
    const knowledgeTool =
      attrs["lk.function_tool.name"] === TOOL ||
      attrs["gen_ai.tool.name"] === TOOL;
    for (const [key, value] of Object.entries(attrs)) {
      if (
        knowledgeTool &&
        (key.includes(".pii.") ||
          key.includes(".arguments") ||
          key.includes(".result") ||
          key.includes(".messages"))
      ) {
        delete attrs[key];
      } else if (
        typeof value === "string" &&
        value.includes(TOOL) &&
        (key.includes(".messages") || key.includes(".pii."))
      ) {
        try {
          attrs[key] = JSON.stringify(
            redactKnowledgePayload(JSON.parse(value)),
          );
        } catch {
          if (value.includes(TOOL)) delete attrs[key];
        }
      }
    }
    if (knowledgeTool) {
      span.events.length = 0;
      span.setStatus({ code: span.status.code });
      delete (span.status as { message?: string }).message;
    }
  },
  onEnd() {},
  async forceFlush() {},
  async shutdown() {},
};

const wrappedLoggers = new WeakSet<ReturnType<typeof log>>();
/** Native LiveKit logs arguments before tool.execute, including rejected inputs. */
export function setupKnowledgeLogging(
  logger: ReturnType<typeof log> = log(),
): void {
  if (wrappedLoggers.has(logger)) return;
  wrappedLoggers.add(logger);
  for (const level of [
    "trace",
    "debug",
    "info",
    "warn",
    "error",
    "fatal",
  ] as const) {
    const original = logger[level];
    logger[level] = function (
      this: ReturnType<typeof log>,
      ...args: unknown[]
    ) {
      const value = args[0];
      if (
        value &&
        typeof value === "object" &&
        (value as Record<string, unknown>).function === TOOL
      ) {
        args[0] = Object.fromEntries(
          Object.entries(value).filter(
            ([key]) =>
              !key.includes("pii") &&
              !["arguments", "args", "error", "err"].includes(key),
          ),
        );
      }
      return Reflect.apply(original, this, args);
    } as typeof original;
  }
  const onChild = logger.onChild;
  logger.onChild = (child) => {
    onChild(child);
    setupKnowledgeLogging(child);
  };
}

const wrappedJobs = new WeakSet<object>();
/** SDK console and cloud upload both obtain their report from this public factory. */
export function setupKnowledgeReportRedaction(
  ctx: Pick<JobContext, "makeSessionReport">,
): void {
  if (wrappedJobs.has(ctx)) return;
  wrappedJobs.add(ctx);
  const original = ctx.makeSessionReport.bind(ctx);
  ctx.makeSessionReport = (...args) => {
    const report = original(...args);
    const chatHistory = report.chatHistory.copy();
    chatHistory.items = chatHistory.items.filter(
      (item) =>
        !(
          (item.type === "function_call" ||
            item.type === "function_call_output") &&
          item.name === TOOL
        ),
    );
    return {
      ...report,
      chatHistory,
      events: report.events.map((event) =>
        event.type === "function_tools_executed"
          ? (redactKnowledgePayload(event) as typeof event)
          : event,
      ),
    };
  };
}
