import {
  parseInsuranceDecision,
  type InsuranceDecision,
} from "./insurance-decision.js";
import { randomUUID } from "node:crypto";
import {
  middlewareOperationByPath,
  beginMiddlewareRequest,
  readMiddlewareHeaders,
  readMiddlewareBody,
  recordMiddlewareRequest,
  type MiddlewareRequestDiagnostic,
} from "./middleware-diagnostics.js";
import { getOfficeProfileByPhone } from "../customers/abita/profile.js";
import type { OwnedMiddlewareFailureReason } from "../state/call-state.js";
import {
  appointmentMetadata,
  isRecord,
  normalizePatientResolveResponse,
  patientResolveReceiptIsComplete,
  stringValue,
  type PatientResolveResult as LegacyPatientResolveResult,
  type PatientResolveCandidate,
  type PatientResolveVerified,
} from "./owned-middleware-patient.js";

export { patientResolveReceiptIsComplete };
export type { PatientResolveCandidate, PatientResolveVerified };

export type MiddlewareFailureReason = Exclude<
  OwnedMiddlewareFailureReason,
  "invalid_cancellation_token"
>;

export type MiddlewareFailure = {
  status: "error";
  reason: MiddlewareFailureReason;
  detail?: "missing_appointment_id";
  noWrite?: true;
};

export function middlewareFailureIsRetryable(
  failure: MiddlewareFailure,
): boolean {
  return (
    failure.reason === "middleware_error" || failure.reason === "network_error"
  );
}

export type PatientResolveResult =
  Exclude<LegacyPatientResolveResult, { status: "error" }> | MiddlewareFailure;

export type PatientIdentity =
  | { phone: string }
  | { patientId: string }
  | { firstName: string; lastName?: string; dob: string };

export type AvailabilitySlot = {
  provider: string;
  date: string;
  time: string;
  datetime: string;
  bookingToken?: string;
  key?: string;
};

export type AvailabilityResult =
  | {
      status: "found" | "none" | "incomplete" | "unsupported";
      slots: AvailabilitySlot[];
      requestedDate?: string;
      actualDate?: string;
      searchedFrom?: string;
      searchedThrough?: string;
      bookingTokenExpiresAt?: string;
      dateShifted: boolean;
      shouldRetrySameSearch: boolean;
      message?: string;
    }
  | MiddlewareFailure;

export type CreatePatientInput = {
  firstName: string;
  lastName: string;
  dob: string;
  street: string;
  aptSuite: string;
  city: string;
  state: string;
  zip: string;
  sex: "male" | "female";
  insurance: string;
  phone: string;
  subscriberName: string;
  subscriberNum: string;
  coverageType?: "routine_vision";
  ssn?: string;
  email?: string;
};

type PatientCreationEvidence = {
  insuranceDecision?: InsuranceDecision;
  patientId: string;
  name: string | null;
  dob: string | null;
  phone: string;
  insuranceCarrier: string | null;
  insPlanId: string | null;
  respPartyId: string | null;
  routing: string | null;
  preauthRequired: boolean;
};

export type CreatePatientResult =
  | ({ status: "created" } & PatientCreationEvidence)
  | ({ status: "partial" } & PatientCreationEvidence)
  | MiddlewareFailure;

export type BookAppointmentInput = {
  insurancePlan?: string;
  hospitalName?: string;
  hospitalDate?: string;
  bookingToken: string;
  rescheduleToken?: string;
  visitCategory: "medical" | "routine_vision";
  patientStatus: "new" | "established";
  visitReason?: string;
  patientId: string;
  appointmentReason: string;
  referringDoctor: string;
  appointmentTypeId?: number;
  patientName?: string;
  dob?: string;
  routing?: string;
};

export type AppointmentTypeMissingFact =
  | "patientStatus"
  | "dob"
  | "routing"
  | "routeToSpringHill"
  | "appointmentLane"
  | "office";

export type BookAppointmentResult =
  | {
      status: "booked" | "partial";
      appointmentId: number;
      appointmentTypeId?: number;
      rescheduleToken?: string;
      cancellationToken?: string;
      officeId?: string;
      office?: string;
      visitType?: "medical" | "routine_vision";
      patientId?: string;
      providerName: string | null;
      locationName: string | null;
      appointmentTypeName: string | null;
      message: string | null;
    }
  | {
      status: "unavailable";
      reason: "slot_unavailable";
    }
  | {
      status: "rejected";
      reason:
        | "invalid_booking_token"
        | "booking_token_required"
        | "invalid_reschedule_token";
    }
  | {
      status: "needs_input";
      reason: "appointment_type_unresolved";
      missing: AppointmentTypeMissingFact[];
    }
  | MiddlewareFailure;

export type RescheduleAppointmentResult =
  | {
      status: "completed" | "partial";
      booking: Extract<BookAppointmentResult, { status: "booked" | "partial" }>;
      cancellation?: { status: "cancelled"; appointmentId: number };
      outcome?: string;
    }
  | { status: "failed"; outcome?: string }
  | { status: "uncertain"; outcome?: string };

export type CancelAppointmentResult =
  | { status: "cancelled"; message: string | null }
  | {
      status: "rejected";
      reason: "invalid_cancellation_token";
      message: string | null;
    }
  | MiddlewareFailure;

export type CancelAppointmentInput =
  | {
      cancellationToken: string;
      appointmentId?: never;
      patientId?: never;
    }
  | {
      cancellationToken?: never;
      appointmentId: number;
      patientId: string;
    };

export type UpdateInsuranceInput = {
  patientId: string;
  dob?: string;
  insPlanId: string;
  respPartyId: string;
  oldInsurance: string;
  insurance: string;
  coverageType: "medical" | "routine_vision";
  subscriberNum: string;
};

export type UpdateInsuranceResult =
  | {
      status: "updated";
      insuranceDecision?: InsuranceDecision;
      newInsurance: string | null;
      routing: string | null;
      preauthRequired: boolean;
    }
  | MiddlewareFailure;

export interface OwnedMiddleware {
  checkInsurance?(request: {
    office: string;
    plan: string;
    coverageType: "medical";
    dob?: string;
  }): Promise<InsuranceDecision | undefined>;
  resolvePatient(request: {
    office: string;
    identity: PatientIdentity;
    fallbackPhone?: string | null;
    signal?: AbortSignal;
  }): Promise<PatientResolveResult>;
  getAvailability(request: {
    office: string;
    patientId?: string;
    insurancePlan?: string;
    coverageType?: "medical" | "routine_vision";
    visitType?: "medical" | "routine_vision";
    startDate?: string;
    rangeDays?: 14;
    dob?: string;
    routing?: string;
    preauthRequired?: boolean;
    signal?: AbortSignal;
  }): Promise<AvailabilityResult>;
  createPatient(request: {
    office: string;
    patient: CreatePatientInput;
  }): Promise<CreatePatientResult>;
  bookAppointment(request: {
    office: string;
    booking: BookAppointmentInput;
  }): Promise<BookAppointmentResult>;
  rescheduleAppointment(request: {
    office: string;
    booking: BookAppointmentInput & { rescheduleToken: string };
  }): Promise<RescheduleAppointmentResult>;
  cancelAppointment(
    request: { office: string } & CancelAppointmentInput,
  ): Promise<CancelAppointmentResult>;
  updateInsurance(request: {
    office: string;
    update: UpdateInsuranceInput;
  }): Promise<UpdateInsuranceResult>;
}

type HttpOwnedMiddlewareOptions = {
  authToken?: string;
  fetch?: typeof fetch;
  middlewareBaseUrl?: string;
  officeOverride?: "spring_hill";
  timeoutMs?: number;
};

export class HttpOwnedMiddleware implements OwnedMiddleware {
  readonly #authToken: string;
  readonly #fetch: typeof fetch;
  readonly #middlewareBaseUrl: string;
  readonly #officeOverride: "spring_hill" | undefined;
  readonly #timeoutMs: number;

  constructor(options: HttpOwnedMiddlewareOptions = {}) {
    this.#authToken = options.authToken ?? process.env.AMD_API_TOKEN ?? "";
    this.#fetch = options.fetch ?? fetch;
    this.#middlewareBaseUrl =
      options.middlewareBaseUrl ?? process.env.AMD_API_URL ?? "";
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#officeOverride = options.officeOverride;
  }

  async resolvePatient(request: {
    office: string;
    identity: PatientIdentity;
    fallbackPhone?: string | null;
    signal?: AbortSignal;
  }): Promise<PatientResolveResult> {
    // This client owns the single retry for patient reads, including phone bootstrap.
    for (let attempt = 0; ; attempt++) {
      const transport = await this.#post(
        "/api/patient/resolve",
        request.office,
        request.identity,
        { signal: request.signal },
      );
      const result = transport.ok
        ? (normalizePatientResolveResponse(transport.value, {
            fallbackPhone: request.fallbackPhone,
          }) as PatientResolveResult)
        : transport.failure;
      annotateMiddlewareResult(transport.diagnostic, result);
      if (
        attempt === 1 ||
        result.status !== "error" ||
        !middlewareFailureIsRetryable(result) ||
        request.signal?.aborted
      ) {
        return result;
      }
    }
  }

  async checkInsurance(request: {
    office: string;
    plan: string;
    coverageType: "medical";
    dob?: string;
  }): Promise<InsuranceDecision | undefined> {
    const result = await this.#post("/api/insurance/decision", request.office, {
      plan: request.plan,
      coverageType: request.coverageType,
      dob: request.dob ?? "",
    });
    return result.ok ? parseInsuranceDecision(result.value) : undefined;
  }

  async getAvailability(request: {
    office: string;
    patientId?: string;
    insurancePlan?: string;
    coverageType?: "medical" | "routine_vision";
    visitType?: "medical" | "routine_vision";
    startDate?: string;
    rangeDays?: 14;
    dob?: string;
    routing?: string;
    preauthRequired?: boolean;
    signal?: AbortSignal;
  }): Promise<AvailabilityResult> {
    const body = {
      rangeDays: request.rangeDays ?? 14,
      ...(request.patientId ? { patientId: request.patientId } : {}),
      ...(request.insurancePlan
        ? { insurancePlan: request.insurancePlan }
        : {}),
      ...(request.coverageType ? { coverageType: request.coverageType } : {}),
      ...(request.visitType ? { visitType: request.visitType } : {}),
      ...(request.startDate ? { startDate: request.startDate } : {}),
      ...(request.dob ? { dob: request.dob } : {}),
      ...(request.routing ? { routing: request.routing } : {}),
      ...(request.preauthRequired ? { preauthRequired: true } : {}),
    };
    let transport = await this.#post(
      "/api/scheduler/slots",
      request.office,
      body,
      { signal: request.signal },
    );
    if (!transport.ok) {
      annotateMiddlewareResult(transport.diagnostic, transport.failure);
      return transport.failure;
    }
    let result = normalizeAvailability(transport.value);
    annotateMiddlewareResult(transport.diagnostic, result);
    if (isUnclassifiedReadFailure(result)) {
      transport = await this.#post(
        "/api/scheduler/slots",
        request.office,
        body,
        { signal: request.signal },
      );
      if (!transport.ok) {
        annotateMiddlewareResult(transport.diagnostic, transport.failure);
        return transport.failure;
      }
      result = normalizeAvailability(transport.value);
      annotateMiddlewareResult(transport.diagnostic, result);
      if (isUnclassifiedReadFailure(result)) {
        const exhausted = requestRejectedFailure();
        annotateMiddlewareResult(transport.diagnostic, exhausted);
        return exhausted;
      }
    }
    return result;
  }

  async createPatient(request: {
    office: string;
    patient: CreatePatientInput;
  }): Promise<CreatePatientResult> {
    const transport = await this.#post(
      "/api/add-patient",
      request.office,
      request.patient,
    );
    const result = transport.ok
      ? normalizeCreatedPatient(transport.value, {
          phone: request.patient.phone,
        })
      : transport.failure;
    annotateMiddlewareResult(transport.diagnostic, result);
    return result;
  }

  async bookAppointment(request: {
    office: string;
    booking: BookAppointmentInput;
  }): Promise<BookAppointmentResult> {
    const transport = await this.#post(
      "/api/appointment/book",
      request.office,
      request.booking,
      {
        includeOffice: false,
      },
    );
    const result = transport.ok
      ? normalizeBookedAppointment(transport.value)
      : transport.failure;
    annotateMiddlewareResult(transport.diagnostic, result);
    return result;
  }

  async rescheduleAppointment(request: {
    office: string;
    booking: BookAppointmentInput & { rescheduleToken: string };
  }): Promise<RescheduleAppointmentResult> {
    const transport = await this.#post(
      "/api/appointment/reschedule",
      request.office,
      request.booking,
      { includeOffice: false },
    );
    // A lost or malformed response cannot establish whether either write happened.
    const result: RescheduleAppointmentResult = transport.ok
      ? normalizeRescheduledAppointment(
          transport.value,
          request.booking.patientId,
        )
      : { status: "uncertain", outcome: transport.failure.reason };
    transport.diagnostic.retryable = false;
    if (result.status !== "completed")
      transport.diagnostic.failureReason = result.outcome ?? result.status;
    return result;
  }

  async cancelAppointment(
    request: { office: string } & CancelAppointmentInput,
  ): Promise<CancelAppointmentResult> {
    const usesCancellationToken = "cancellationToken" in request;
    const transport = await this.#post(
      "/api/appointment/cancel",
      request.office,
      usesCancellationToken
        ? { cancellationToken: request.cancellationToken }
        : {
            appointmentId: request.appointmentId,
            patientId: request.patientId,
          },
      usesCancellationToken ? { includeOffice: false } : {},
    );
    const result = transport.ok
      ? normalizeCancelledAppointment(transport.value)
      : transport.failure;
    annotateMiddlewareResult(transport.diagnostic, result);
    return result;
  }

  async updateInsurance(request: {
    office: string;
    update: UpdateInsuranceInput;
  }): Promise<UpdateInsuranceResult> {
    const transport = await this.#post(
      "/api/patient/update-insurance",
      request.office,
      request.update,
    );
    const result = transport.ok
      ? normalizeUpdatedInsurance(transport.value)
      : transport.failure;
    annotateMiddlewareResult(transport.diagnostic, result);
    return result;
  }

  async #post(
    path: string,
    office: string,
    body: object,
    options: {
      includeOffice?: boolean;
      signal?: AbortSignal;
    } = {},
  ): Promise<
    | { ok: true; value: unknown; diagnostic: MiddlewareRequestDiagnostic }
    | {
        ok: false;
        failure: MiddlewareFailure;
        diagnostic: MiddlewareRequestDiagnostic;
      }
  > {
    const started = Date.now();
    const diagnostic: MiddlewareRequestDiagnostic = {
      requestId: randomUUID(),
      operation: middlewareOperationByPath[path] ?? "unknown",
      attempt: 1,
      durationMs: 0,
      result: "response",
    };
    beginMiddlewareRequest(diagnostic);
    try {
      const payload =
        options.includeOffice === false
          ? body
          : { ...body, office: this.#officeOverride ?? office };
      try {
        getOfficeProfileByPhone(office);
      } catch {
        diagnostic.result = "unsupported_office";
        return {
          ok: false,
          diagnostic,
          failure: {
            status: "error",
            reason: "unsupported_office",
          },
        };
      }
      if (!this.#middlewareBaseUrl) {
        diagnostic.result = "not_configured";
        return {
          ok: false,
          diagnostic,
          failure: {
            status: "error",
            reason: "middleware_error",
          },
        };
      }
      const baseUrl = this.#middlewareBaseUrl.replace(/\/+$/, "");
      const signal = this.#requestSignal(options.signal);
      try {
        const response = await this.#fetch(`${baseUrl}${path}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Request-ID": diagnostic.requestId,
            Authorization: this.#authToken,
          },
          body: JSON.stringify(payload),
          signal,
        });
        diagnostic.httpStatus = response.status;
        readMiddlewareHeaders(response.headers, diagnostic);
        if (!response.ok) {
          diagnostic.result = "http_error";
          const retryable =
            response.status === 408 ||
            response.status === 429 ||
            response.status >= 500;
          return {
            ok: false,
            diagnostic,
            failure: {
              status: "error",
              reason: retryable ? "middleware_error" : "request_rejected",
            },
          };
        }
        try {
          const value: unknown = await response.json();
          readMiddlewareBody(value, diagnostic);
          return { ok: true, value, diagnostic };
        } catch (error) {
          diagnostic.result = options.signal?.aborted
            ? "cancelled"
            : signal.aborted
              ? "timeout"
              : error instanceof SyntaxError
                ? "invalid_response"
                : "network_error";
          return {
            ok: false,
            diagnostic,
            failure: {
              status: "error",
              reason:
                error instanceof SyntaxError
                  ? "invalid_response"
                  : "network_error",
            },
          };
        }
      } catch {
        diagnostic.result = options.signal?.aborted
          ? "cancelled"
          : signal.aborted
            ? "timeout"
            : "network_error";
        return {
          ok: false,
          diagnostic,
          failure: {
            status: "error",
            reason: options.signal?.aborted ? "cancelled" : "network_error",
          },
        };
      }
    } finally {
      diagnostic.durationMs = Date.now() - started;
      recordMiddlewareRequest(diagnostic);
    }
  }

  #requestSignal(signal?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
  }
}

// Record the normalized decision beside transport evidence using the same
// retry policy that the tool runtime applies.
function annotateMiddlewareResult(
  diagnostic: MiddlewareRequestDiagnostic,
  result:
    | PatientResolveResult
    | AvailabilityResult
    | CreatePatientResult
    | BookAppointmentResult
    | CancelAppointmentResult
    | UpdateInsuranceResult,
): void {
  if (
    result.status !== "error" &&
    result.status !== "rejected" &&
    result.status !== "unresolved"
  )
    return;
  diagnostic.failureReason = result.reason;
  diagnostic.retryable =
    result.status === "error" && middlewareFailureIsRetryable(result);
  if (result.status === "error") diagnostic.failureDetail = result.detail;
}

function normalizeAvailability(raw: unknown): AvailabilityResult {
  const outcome = isRecord(raw) ? stringValue(raw.outcome) : null;
  if (hasFailureStatus(raw) && outcome !== "availability_search_incomplete") {
    return {
      status: "error",
      reason: outcome === null ? "middleware_error" : "request_rejected",
    };
  }
  const status = availabilityStatus(outcome);
  if (!status) {
    return {
      status: "error",
      reason: "invalid_response",
    };
  }
  if (!isRecord(raw) || !Array.isArray(raw.slots)) {
    return {
      status: "error",
      reason: "invalid_response",
    };
  }
  if (!raw.slots.every(isAvailabilitySlot)) {
    return {
      status: "error",
      reason: "invalid_response",
    };
  }
  const slots = raw.slots.map((slot) => ({
    key: [
      slot.columnId,
      slot.profileId,
      slot.provider,
      slot.datetime,
      slot.duration,
    ].join("|"),
    provider: stringValue(slot.provider) ?? "",
    date:
      stringValue(slot.date) ?? stringValue(slot.datetime)?.split("T")[0] ?? "",
    time: stringValue(slot.time) ?? "",
    datetime: stringValue(slot.datetime) ?? "",
    ...(stringValue(slot.bookingToken)
      ? { bookingToken: stringValue(slot.bookingToken) ?? undefined }
      : {}),
  }));
  return {
    status,
    slots,
    ...(stringValue(raw.requestedDate)
      ? { requestedDate: stringValue(raw.requestedDate) ?? undefined }
      : {}),
    ...(stringValue(raw.actualDate)
      ? { actualDate: stringValue(raw.actualDate) ?? undefined }
      : {}),
    ...(stringValue(raw.searchedFrom)
      ? { searchedFrom: stringValue(raw.searchedFrom) ?? undefined }
      : {}),
    ...(stringValue(raw.searchedThrough)
      ? { searchedThrough: stringValue(raw.searchedThrough) ?? undefined }
      : {}),
    ...(stringValue(raw.bookingTokenExpiresAt)
      ? {
          bookingTokenExpiresAt:
            stringValue(raw.bookingTokenExpiresAt) ?? undefined,
        }
      : {}),
    dateShifted: raw.dateShifted === true,
    shouldRetrySameSearch: raw.shouldRetrySameSearch === true,
    ...(stringValue(raw.message)
      ? { message: stringValue(raw.message) ?? undefined }
      : {}),
  };
}

function availabilityStatus(outcome: string | null) {
  switch (outcome) {
    case "availability_found":
      return "found" as const;
    case "no_availability":
      return "none" as const;
    case "no_eligible_providers":
      return "unsupported" as const;
    case "availability_search_incomplete":
      return "incomplete" as const;
    default:
      return null;
  }
}

function normalizeCreatedPatient(
  raw: unknown,
  fallback: { phone: string },
): CreatePatientResult {
  if (hasFailureStatus(raw)) {
    const failure = mutationFailure(raw, patientMutationCanRetry);
    const outcome = isRecord(raw) ? stringValue(raw.outcome) : null;
    return [
      "validation_failed",
      "rejected",
      "unavailable",
      "reconciled_failure",
    ].includes(outcome ?? "")
      ? { ...failure, noWrite: true }
      : failure;
  }
  const status = isRecord(raw)
    ? (stringValue(raw.status)?.toLowerCase() ?? "")
    : "";
  if (
    !isRecord(raw) ||
    !stringValue(raw.patientId) ||
    (status !== "" &&
      status !== "created" &&
      status !== "partial" &&
      status !== "success")
  ) {
    return {
      status: "error",
      reason: "invalid_response",
    };
  }
  return {
    status: status === "partial" ? "partial" : "created",
    patientId: stringValue(raw.patientId) ?? "",
    name: stringValue(raw.name),
    dob: stringValue(raw.dob),
    phone: stringValue(raw.phone) ?? fallback.phone,
    insuranceDecision: parseInsuranceDecision(raw.insuranceDecision),
    insuranceCarrier: stringValue(raw.insuranceCarrier),
    insPlanId: stringValue(raw.insPlanId),
    respPartyId: stringValue(raw.respPartyId),
    routing: stringValue(raw.routing),
    preauthRequired: raw.preauthRequired === true,
  };
}

function normalizeBookedAppointment(raw: unknown): BookAppointmentResult {
  if (!isRecord(raw)) return invalidBookingResult();
  const status = stringValue(raw.status)?.toLowerCase();
  const outcome = stringValue(raw.outcome)?.toLowerCase();
  if (outcome === "appointment_type_unresolved") {
    const missing = normalizeAppointmentTypeMissingFacts(raw.missing);
    if (!missing) return invalidBookingResult();
    return {
      status: "needs_input",
      reason: "appointment_type_unresolved",
      missing,
    };
  }
  if (outcome === "slot_unavailable") {
    return {
      status: "unavailable",
      reason: "slot_unavailable",
    };
  }
  if (
    outcome === "invalid_booking_token" ||
    outcome === "booking_token_required" ||
    outcome === "invalid_reschedule_token"
  ) {
    return {
      status: "rejected",
      reason: outcome,
    };
  }
  const appointmentId = positiveInteger(raw.appointmentId);
  if (
    appointmentId !== null &&
    (status === "booked" || status === "partial" || status === "success")
  ) {
    const appointmentTypeId = positiveInteger(raw.appointmentTypeId);
    const rescheduleToken = stringValue(raw.rescheduleToken)?.trim();
    return {
      status: status === "partial" ? "partial" : "booked",
      appointmentId,
      ...appointmentMetadata(raw),
      ...(stringValue(raw.patientId)
        ? { patientId: stringValue(raw.patientId)! }
        : {}),
      ...(appointmentTypeId !== null ? { appointmentTypeId } : {}),
      ...(rescheduleToken ? { rescheduleToken } : {}),
      providerName: stringValue(raw.providerName),
      locationName: stringValue(raw.locationName),
      appointmentTypeName: stringValue(raw.appointmentTypeName),
      message: stringValue(raw.message),
    };
  }
  if (status === "booked" || status === "partial" || status === "success") {
    return {
      status: "error",
      reason: "invalid_response",
      detail: "missing_appointment_id",
    };
  }
  return hasFailureStatus(raw)
    ? mutationFailure(raw, schedulingMutationCanRetry)
    : invalidBookingResult();
}

function normalizeRescheduledAppointment(
  raw: unknown,
  patientId: string,
): RescheduleAppointmentResult {
  if (!isRecord(raw)) return { status: "uncertain" };
  const outcome = stringValue(raw.outcome) ?? undefined;
  if (raw.status === "uncertain") return { status: "uncertain", outcome };
  if (raw.status === "failed") {
    if (raw.booking || raw.cancellation || outcome === "indeterminate_write")
      return { status: "uncertain", outcome };
    return { status: "failed", outcome };
  }
  if (raw.status !== "completed" && raw.status !== "partial")
    return { status: "uncertain", outcome };
  const booking = normalizeBookedAppointment(raw.booking);
  if (
    (booking.status !== "booked" && booking.status !== "partial") ||
    booking.patientId !== patientId
  )
    return { status: "uncertain", outcome };
  const cancellation =
    isRecord(raw.cancellation) &&
    raw.cancellation.status === "cancelled" &&
    positiveInteger(raw.cancellation.appointmentId)
      ? {
          status: "cancelled" as const,
          appointmentId: positiveInteger(raw.cancellation.appointmentId)!,
        }
      : undefined;
  return {
    status:
      raw.status === "completed" && cancellation ? "completed" : "partial",
    booking,
    cancellation,
    outcome,
  };
}

function normalizeCancelledAppointment(raw: unknown): CancelAppointmentResult {
  const response = isRecord(raw) ? raw : null;
  const status = response ? stringValue(response.status)?.toLowerCase() : null;
  if (status === "cancelled") {
    return {
      status: "cancelled",
      message: stringValue(response?.message),
    };
  }
  if (
    status === "error" &&
    stringValue(response?.outcome)?.toLowerCase() ===
      "invalid_cancellation_token"
  ) {
    return {
      status: "rejected",
      reason: "invalid_cancellation_token",
      message: stringValue(response?.message),
    };
  }
  return hasFailureStatus(raw)
    ? mutationFailure(raw, schedulingMutationCanRetry)
    : { status: "error", reason: "invalid_response" };
}

function normalizeUpdatedInsurance(raw: unknown): UpdateInsuranceResult {
  if (isRecord(raw) && stringValue(raw.status)?.toLowerCase() === "updated") {
    return {
      status: "updated",
      insuranceDecision: parseInsuranceDecision(raw.insuranceDecision),
      newInsurance: stringValue(raw.newInsurance),
      routing: stringValue(raw.routing),
      preauthRequired: raw.preauthRequired === true,
    };
  }
  return hasFailureStatus(raw)
    ? mutationFailure(raw, patientMutationCanRetry)
    : { status: "error", reason: "invalid_response" };
}

function mutationFailure(
  raw: unknown,
  canRetry: (outcome: string | null) => boolean,
): MiddlewareFailure {
  const outcome = isRecord(raw)
    ? (stringValue(raw.outcome)?.toLowerCase() ?? null)
    : null;
  return {
    status: "error",
    reason: canRetry(outcome) ? "middleware_error" : "request_rejected",
    ...(outcome === "write_failed" || outcome === "validation_failed"
      ? { noWrite: true as const }
      : {}),
  };
}

function patientMutationCanRetry(outcome: string | null): boolean {
  return outcome === "unavailable" || outcome === "reconciled_failure";
}

function schedulingMutationCanRetry(outcome: string | null): boolean {
  return outcome === "write_failed";
}

function isUnclassifiedReadFailure(
  result: PatientResolveResult | AvailabilityResult,
): boolean {
  return result.status === "error" && result.reason === "middleware_error";
}

function requestRejectedFailure(): MiddlewareFailure {
  return { status: "error", reason: "request_rejected" };
}

function invalidBookingResult(): BookAppointmentResult {
  return {
    status: "error",
    reason: "invalid_response",
  };
}

function normalizeAppointmentTypeMissingFacts(
  value: unknown,
): AppointmentTypeMissingFact[] | null {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every(isAppointmentTypeMissingFact)
  ) {
    return null;
  }
  return value;
}

function isAppointmentTypeMissingFact(
  value: unknown,
): value is AppointmentTypeMissingFact {
  switch (value) {
    case "patientStatus":
    case "dob":
    case "routing":
    case "routeToSpringHill":
    case "appointmentLane":
    case "office":
      return true;
    default:
      return false;
  }
}

function positiveInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) {
    return Number(value);
  }
  return null;
}

function isAvailabilitySlot(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    stringValue(value.provider) !== null &&
    stringValue(value.time) !== null &&
    stringValue(value.datetime) !== null
  );
}

function hasFailureStatus(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const status = stringValue(value.status)?.toLowerCase();
  return status === "error" || status === "failed" || status === "failure";
}
