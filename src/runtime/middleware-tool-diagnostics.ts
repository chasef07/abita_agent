import { isFunctionTool, type ToolContextEntry } from "@livekit/agents";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import {
  middlewareDiagnosticContext,
  type MiddlewareRequestDiagnostic,
} from "../clients/middleware-diagnostics.js";
import type { CallState } from "../state/call-state.js";
import { recordDomainOutcome } from "../state/observability.js";
import { getState } from "../tools/session.js";

// One async scope per tool invocation keeps concurrent tools/calls separate.
export function withMiddlewareToolDiagnostics(
  entry: ToolContextEntry<CallState>,
): ToolContextEntry<CallState> {
  if (
    !isFunctionTool(entry) ||
    ![
      "resolve_patient",
      "add_patient",
      "update_insurance",
      "list_available_appointments",
      "book_appointment",
      "cancel_appointment",
      "reschedule_appointment",
    ].includes(entry.name)
  )
    return entry;
  return {
    ...entry,
    execute: async (params, options) => {
      const requests: MiddlewareRequestDiagnostic[] = [];
      // LiveKit invokes user code before starting its function_tool span.
      // Own a diagnostic span and correlate it using the native tool call ID.
      return trace.getTracer("abita-agent.middleware").startActiveSpan(
        "middleware_tool",
        {
          attributes: {
            "gen_ai.tool.call.id": options.toolCallId,
            "gen_ai.tool.name": entry.name,
          },
        },
        (span) =>
          middlewareDiagnosticContext.run(requests, async () => {
            let failed = false;
            try {
              return await entry.execute(params, options);
            } catch (error) {
              failed = true;
              throw error;
            } finally {
              if (requests.length > 0) {
                const state = getState(options.ctx);
                const receipt = state.runtime.outcomeReceipts.find(
                  (item) => item.callId === options.toolCallId,
                );
                recordDomainOutcome(state, {
                  ...(receipt ?? {
                    callId: options.toolCallId,
                    toolName: entry.name,
                    outcome: "middleware_diagnostics",
                    status: "observed",
                  }),
                  middlewareRequests: requests,
                });
                span.setAttribute(
                  "abita.middleware.requests",
                  JSON.stringify(requests),
                );
                span.setAttribute(
                  "abita.middleware.request_count",
                  requests.length,
                );
                if (failed) span.setStatus({ code: SpanStatusCode.ERROR });
              }
              span.end();
            }
          }),
      );
    },
  };
}
