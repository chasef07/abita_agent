import { AsyncLocalStorage } from "node:async_hooks";
import { trace } from "@opentelemetry/api";

export interface ProviderDiagnostic {
  operation: string;
  category: string;
  httpStatus?: number;
  code?: string;
  durationMs: number;
}

export interface MiddlewareRequestDiagnostic {
  requestId: string;
  operation: string;
  attempt: number;
  durationMs: number;
  result:
    | "response"
    | "http_error"
    | "network_error"
    | "timeout"
    | "cancelled"
    | "invalid_response"
    | "not_configured"
    | "unsupported_office";
  httpStatus?: number;
  responseStatus?: string;
  appointmentsStatus?: "found" | "none" | "error";
  outcome?: string;
  category?: string;
  providerErrors?: ProviderDiagnostic[];
  providerErrorCount?: number;
  failureReason?: string;
  failureDetail?: "missing_appointment_id";
  retryable?: boolean;
}

export const middlewareDiagnosticContext = new AsyncLocalStorage<
  MiddlewareRequestDiagnostic[]
>();

const categories = new Set([
  "none",
  "canceled",
  "timeout",
  "network",
  "conflict",
  "rejected",
  "authentication",
  "unavailable",
  "upstream_status",
  "invalid_response",
  "internal",
  "upstream_error",
]);
const operations = new Set([
  "lookuppatient",
  "addpatient",
  "addinsurance",
  "enddateinsurance",
  "getdemographic",
  "getschedulersetup",
  "get_appointments",
  "get_block_holds",
  "get_appointments_by_month",
  "book_appointment",
  "cancel_appointment",
]);
const outcomes = new Set([
  "success",
  "invalid_request",
  "authentication_rejected",
  "provider_failure",
  "internal_failure",
  "not_found",
  "client_error",
  "server_error",
  "rejected",
  "reconciled_failure",
  "indeterminate_write",
  "validation_failed",
  "unavailable",
  "failed",
  "reconciled_success",
  "validation",
  "invalid_booking_token",
  "invalid_cancellation_token",
  "invalid_reschedule_token",
  "booking_token_required",
  "appointment_type_unresolved",
  "patient_context_mismatch",
  "slot_unavailable",
  "provider_conflict",
  "provider_rejected",
  "ownership_mismatch",
  "write_failed",
  "availability_search_incomplete",
  "availability_found",
  "no_availability",
  "no_eligible_providers",
]);
const statuses = new Set([
  "unresolved",
  "error",
  "failed",
  "failure",
  "success",
  "verified",
  "multiple_matches",
  "not_found",
  "no_match",
  "no_appointments",
  "created",
  "partial",
  "updated",
  "booked",
  "cancelled",
  "found",
  "none",
  "incomplete",
]);
export const middlewareOperationByPath: Record<string, string> = {
  "/api/patient/resolve": "resolvePatient",
  "/api/scheduler/slots": "getAvailability",
  "/api/add-patient": "createPatient",
  "/api/appointment/reschedule": "rescheduleAppointment",
  "/api/appointment/book": "bookAppointment",
  "/api/appointment/cancel": "cancelAppointment",
  "/api/patient/update-insurance": "updateInsurance",
};

function label(value: unknown, allowed: Set<string>): string | undefined {
  return typeof value === "string" && allowed.has(value) ? value : undefined;
}

export function readMiddlewareHeaders(
  headers: Headers,
  diagnostic: MiddlewareRequestDiagnostic,
): void {
  diagnostic.category = label(
    headers.get("X-Abita-Error-Category"),
    categories,
  );
  diagnostic.outcome = label(headers.get("X-Abita-Outcome"), outcomes);
  const raw = headers.get("X-Abita-Provider-Errors");
  if (!raw || raw.length > 8192) return;
  try {
    const values: unknown = JSON.parse(raw);
    if (!Array.isArray(values)) return;
    diagnostic.providerErrors = values.slice(0, 8).flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const operation = label(value.operation, operations);
      const category = label(value.category, categories);
      if (
        !operation ||
        !category ||
        !Number.isSafeInteger(value.durationMs) ||
        value.durationMs < 0
      )
        return [];
      return [
        {
          operation,
          category,
          durationMs: value.durationMs,
          ...(Number.isInteger(value.httpStatus) &&
          value.httpStatus >= 100 &&
          value.httpStatus <= 599
            ? { httpStatus: value.httpStatus }
            : {}),
          ...(typeof value.code === "string" &&
          /^-?[0-9]{1,6}$/.test(value.code)
            ? { code: value.code }
            : {}),
        },
      ];
    });
    const count = Number(headers.get("X-Abita-Provider-Error-Count"));
    if (
      Number.isSafeInteger(count) &&
      count >= diagnostic.providerErrors.length
    )
      diagnostic.providerErrorCount = count;
  } catch {
    /* Diagnostic metadata must not change request execution. */
  }
}

export function readMiddlewareBody(
  value: unknown,
  diagnostic: MiddlewareRequestDiagnostic,
): void {
  if (!value || typeof value !== "object") return;
  const body = value as Record<string, unknown>;
  diagnostic.responseStatus = label(body.status, statuses);
  if (
    body.appointmentsStatus === "found" ||
    body.appointmentsStatus === "none" ||
    body.appointmentsStatus === "error"
  )
    diagnostic.appointmentsStatus = body.appointmentsStatus;
  diagnostic.outcome = label(body.outcome, outcomes) ?? diagnostic.outcome;
}

export function beginMiddlewareRequest(
  diagnostic: MiddlewareRequestDiagnostic,
): void {
  const requests = middlewareDiagnosticContext.getStore();
  if (requests) {
    diagnostic.attempt =
      requests.filter((request) => request.operation === diagnostic.operation)
        .length + 1;
    requests.push(diagnostic);
  }
}

export function recordMiddlewareRequest(
  diagnostic: MiddlewareRequestDiagnostic,
): void {
  trace.getActiveSpan()?.addEvent("abita.middleware.request", {
    "abita.middleware.request_id": diagnostic.requestId,
    "abita.middleware.operation": diagnostic.operation,
    "abita.middleware.diagnostic": JSON.stringify(diagnostic),
  });
}
