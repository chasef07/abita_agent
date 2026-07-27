import { getOfficeProfileByPhone } from "../customers/abita/profile.js";
import type { OwnedMiddlewareFailureReason } from "../state/call-state.js";
import {
  isRecord,
  normalizePatientResolveResponse,
  stringValue,
  type PatientResolveResult as LegacyPatientResolveResult,
  type PatientResolveCandidate,
  type PatientResolveVerified,
} from "./owned-middleware-patient.js";

const DEFAULT_PRODUCTION_BASE_URL =
  "https://advancedmd-token-management-production.up.railway.app";
const RANKED_AVAILABILITY_SELECTION_POLICY = "preference_ranked_v1";

export type { PatientResolveCandidate, PatientResolveVerified };

export type MiddlewareFailureReason = Exclude<
  OwnedMiddlewareFailureReason,
  "invalid_cancellation_token"
>;

export type MiddlewareFailure = {
  status: "error";
  reason: MiddlewareFailureReason;
  detail?: "missing_appointment_id";
};

export type PatientResolveResult =
  Exclude<LegacyPatientResolveResult, { status: "error" }> | MiddlewareFailure;

export type PatientIdentity =
  | { phone: string }
  | { patientId: string }
  | { firstName: string; lastName: string; dob: string };

export type AvailabilitySlot = {
  provider: string;
  date: string;
  time: string;
  datetime: string;
  bookingToken?: string;
};

export type AvailabilityTimePreference =
  { kind: "morning" | "afternoon" } | { minuteOfDay: number };

export type AvailabilityPreference = {
  date?: string;
  time?: AvailabilityTimePreference;
};

export type AvailabilityResult =
  | {
      status: "found" | "none" | "incomplete";
      slots: AvailabilitySlot[];
      requestedDate?: string;
      actualDate?: string;
      searchedFrom?: string;
      searchedThrough?: string;
      bookingTokenExpiresAt?: string;
      selectionPolicy?: typeof RANKED_AVAILABILITY_SELECTION_POLICY;
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
  patientId: string;
  name: string | null;
  dob: string;
  phone: string;
  insuranceCarrier: string | null;
  insPlanId: string | null;
  respPartyId: string | null;
  routing: string | null;
  allowedProviders: string[];
  routingAmbiguous: boolean;
  preauthRequired: boolean;
};

export type CreatePatientResult =
  | ({ status: "created" } & PatientCreationEvidence)
  | ({ status: "partial" } & PatientCreationEvidence)
  | MiddlewareFailure;

export type BookAppointmentInput = {
  bookingToken: string;
  visitCategory: "medical" | "routine_vision";
  visitKind: "medical" | "routine_vision" | "post_op";
  patientStatus: "new" | "established";
  visitReason?: string;
  isPostOp?: true;
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
      reason: "invalid_booking_token" | "booking_token_required";
    }
  | {
      status: "needs_input";
      reason: "appointment_type_unresolved";
      missing: AppointmentTypeMissingFact[];
    }
  | MiddlewareFailure;

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
      newInsurance: string | null;
      routing: string | null;
      allowedProviders: string[];
      routingAmbiguous: boolean;
      preauthRequired: boolean;
    }
  | MiddlewareFailure;

export interface OwnedMiddleware {
  resolvePatient(request: {
    office: string;
    identity: PatientIdentity;
    fallbackPhone?: string | null;
    signal?: AbortSignal;
  }): Promise<PatientResolveResult>;
  getAvailability(request: {
    office: string;
    date: string;
    dob?: string;
    routing?: string;
    preauthRequired?: boolean;
    preferences?: AvailabilityPreference[];
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
  cancelAppointment(
    request: { office: string } & CancelAppointmentInput,
  ): Promise<CancelAppointmentResult>;
  updateInsurance(request: {
    office: string;
    update: UpdateInsuranceInput;
  }): Promise<UpdateInsuranceResult>;
}

let activeOwnedMiddleware: OwnedMiddleware | undefined;

export function ownedMiddleware(): OwnedMiddleware {
  return activeOwnedMiddleware ?? new HttpOwnedMiddleware();
}

export function resolvePatientWithOwnedMiddleware(
  office: string,
  identity: PatientIdentity,
): Promise<PatientResolveResult> {
  return ownedMiddleware().resolvePatient({ office, identity });
}

export function setOwnedMiddleware(
  middleware: OwnedMiddleware | undefined,
): void {
  activeOwnedMiddleware = middleware;
}

type HttpOwnedMiddlewareOptions = {
  authToken?: string;
  fetch?: typeof fetch;
  productionBaseUrl?: string;
  timeoutMs?: number;
};

export class HttpOwnedMiddleware implements OwnedMiddleware {
  readonly #authToken: string;
  readonly #fetch: typeof fetch;
  readonly #productionBaseUrl: string;
  readonly #timeoutMs: number;

  constructor(options: HttpOwnedMiddlewareOptions = {}) {
    this.#authToken = options.authToken ?? process.env.AMD_API_TOKEN ?? "";
    this.#fetch = options.fetch ?? fetch;
    this.#productionBaseUrl =
      options.productionBaseUrl ??
      process.env.AMD_API_URL ??
      DEFAULT_PRODUCTION_BASE_URL;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
  }

  async resolvePatient(request: {
    office: string;
    identity: PatientIdentity;
    fallbackPhone?: string | null;
    signal?: AbortSignal;
  }): Promise<PatientResolveResult> {
    const transport = await this.#post(
      "/api/patient/resolve",
      request.office,
      request.identity,
      { signal: request.signal },
    );
    if (!transport.ok) return transport.failure;
    return normalizePatientResolveResponse(transport.value, {
      fallbackPhone: request.fallbackPhone,
    }) as PatientResolveResult;
  }

  async getAvailability(request: {
    office: string;
    date: string;
    dob?: string;
    routing?: string;
    preauthRequired?: boolean;
    preferences?: AvailabilityPreference[];
    signal?: AbortSignal;
  }): Promise<AvailabilityResult> {
    const transport = await this.#post(
      "/api/scheduler/availability",
      request.office,
      {
        date: request.date,
        ...(request.dob ? { dob: request.dob } : {}),
        ...(request.routing ? { routing: request.routing } : {}),
        ...(request.preauthRequired ? { preauthRequired: true } : {}),
        ...(request.preferences !== undefined
          ? { preferences: request.preferences }
          : {}),
      },
      { signal: request.signal },
    );
    if (!transport.ok) return transport.failure;

    const result = normalizeAvailability(transport.value);
    if (result.status === "error") return result;
    if (
      request.preferences !== undefined &&
      result.selectionPolicy !== RANKED_AVAILABILITY_SELECTION_POLICY
    ) {
      return {
        status: "error",
        reason: "invalid_response",
      };
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
    return transport.ok
      ? normalizeCreatedPatient(transport.value, {
          dob: request.patient.dob,
          phone: request.patient.phone,
        })
      : transport.failure;
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
    return transport.ok
      ? normalizeBookedAppointment(transport.value)
      : transport.failure;
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
    return transport.ok
      ? normalizeCancelledAppointment(transport.value)
      : transport.failure;
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
    return transport.ok
      ? normalizeUpdatedInsurance(transport.value)
      : transport.failure;
  }

  #baseUrl(officePhone: string): string {
    const office = getOfficeProfileByPhone(officePhone);
    return office
      .middlewareBaseUrl(this.#productionBaseUrl)
      .replace(/\/+$/, "");
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
    { ok: true; value: unknown } | { ok: false; failure: MiddlewareFailure }
  > {
    const payload =
      options.includeOffice === false ? body : { ...body, office };
    let baseUrl: string;
    try {
      baseUrl = this.#baseUrl(office);
    } catch {
      return {
        ok: false,
        failure: {
          status: "error",
          reason: "unsupported_office",
        },
      };
    }
    try {
      const response = await this.#fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: this.#authToken,
        },
        body: JSON.stringify(payload),
        signal: this.#requestSignal(options.signal),
      });
      if (!response.ok) {
        return {
          ok: false,
          failure: {
            status: "error",
            reason: "middleware_error",
          },
        };
      }
      try {
        return { ok: true, value: await response.json() };
      } catch {
        return {
          ok: false,
          failure: {
            status: "error",
            reason: "invalid_response",
          },
        };
      }
    } catch {
      return {
        ok: false,
        failure: {
          status: "error",
          reason: options.signal?.aborted ? "cancelled" : "network_error",
        },
      };
    }
  }

  #requestSignal(signal?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
  }
}

export type InMemoryOwnedMiddlewareResponses = {
  resolvePatient?: Array<PatientResolveResult | Promise<PatientResolveResult>>;
  getAvailability?: Array<AvailabilityResult | Promise<AvailabilityResult>>;
  createPatient?: Array<CreatePatientResult | Promise<CreatePatientResult>>;
  bookAppointment?: Array<
    BookAppointmentResult | Promise<BookAppointmentResult>
  >;
  cancelAppointment?: Array<
    CancelAppointmentResult | Promise<CancelAppointmentResult>
  >;
  updateInsurance?: Array<
    UpdateInsuranceResult | Promise<UpdateInsuranceResult>
  >;
};

export class InMemoryOwnedMiddleware implements OwnedMiddleware {
  readonly #responses: InMemoryOwnedMiddlewareResponses;
  readonly operations: Array<{
    name: keyof InMemoryOwnedMiddlewareResponses;
    request: unknown;
  }> = [];
  readonly requests = {
    resolvePatient: [] as Array<
      Parameters<OwnedMiddleware["resolvePatient"]>[0]
    >,
    getAvailability: [] as Array<
      Parameters<OwnedMiddleware["getAvailability"]>[0]
    >,
    createPatient: [] as Array<Parameters<OwnedMiddleware["createPatient"]>[0]>,
    bookAppointment: [] as Array<
      Parameters<OwnedMiddleware["bookAppointment"]>[0]
    >,
    cancelAppointment: [] as Array<
      Parameters<OwnedMiddleware["cancelAppointment"]>[0]
    >,
    updateInsurance: [] as Array<
      Parameters<OwnedMiddleware["updateInsurance"]>[0]
    >,
  };

  constructor(responses: InMemoryOwnedMiddlewareResponses = {}) {
    this.#responses = responses;
  }

  async resolvePatient(
    request: Parameters<OwnedMiddleware["resolvePatient"]>[0],
  ): Promise<PatientResolveResult> {
    this.requests.resolvePatient.push(request);
    this.operations.push({ name: "resolvePatient", request });
    const result = await this.#responses.resolvePatient?.shift();
    if (!result) {
      return {
        status: "error",
        reason: "invalid_response",
      };
    }
    return result;
  }

  async getAvailability(
    request: Parameters<OwnedMiddleware["getAvailability"]>[0],
  ): Promise<AvailabilityResult> {
    this.requests.getAvailability.push(request);
    this.operations.push({ name: "getAvailability", request });
    return (
      (await this.#responses.getAvailability?.shift()) ?? {
        status: "error",
        reason: "invalid_response",
      }
    );
  }

  async createPatient(
    request: Parameters<OwnedMiddleware["createPatient"]>[0],
  ): Promise<CreatePatientResult> {
    this.requests.createPatient.push(request);
    this.operations.push({ name: "createPatient", request });
    return (
      (await this.#responses.createPatient?.shift()) ?? {
        status: "error",
        reason: "invalid_response",
      }
    );
  }

  async bookAppointment(
    request: Parameters<OwnedMiddleware["bookAppointment"]>[0],
  ): Promise<BookAppointmentResult> {
    this.requests.bookAppointment.push(request);
    this.operations.push({ name: "bookAppointment", request });
    return (
      (await this.#responses.bookAppointment?.shift()) ?? {
        status: "error",
        reason: "invalid_response",
      }
    );
  }

  async cancelAppointment(
    request: Parameters<OwnedMiddleware["cancelAppointment"]>[0],
  ): Promise<CancelAppointmentResult> {
    this.requests.cancelAppointment.push(request);
    this.operations.push({ name: "cancelAppointment", request });
    return (
      (await this.#responses.cancelAppointment?.shift()) ?? {
        status: "error",
        reason: "invalid_response",
      }
    );
  }

  async updateInsurance(
    request: Parameters<OwnedMiddleware["updateInsurance"]>[0],
  ): Promise<UpdateInsuranceResult> {
    this.requests.updateInsurance.push(request);
    this.operations.push({ name: "updateInsurance", request });
    return (
      (await this.#responses.updateInsurance?.shift()) ?? {
        status: "error",
        reason: "invalid_response",
      }
    );
  }
}

function normalizeAvailability(raw: unknown): AvailabilityResult {
  const outcome = isRecord(raw) ? stringValue(raw.outcome) : null;
  if (hasFailureStatus(raw) && outcome !== "availability_search_incomplete") {
    return {
      status: "error",
      reason: "middleware_error",
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
    ...(stringValue(raw.selectionPolicy) ===
    RANKED_AVAILABILITY_SELECTION_POLICY
      ? { selectionPolicy: RANKED_AVAILABILITY_SELECTION_POLICY }
      : {}),
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
    case null:
    case "availability_found":
      return "found" as const;
    case "no_availability":
    case "no_eligible_providers":
      return "none" as const;
    case "availability_search_incomplete":
      return "incomplete" as const;
    default:
      return null;
  }
}

function normalizeCreatedPatient(
  raw: unknown,
  fallback: { dob: string; phone: string },
): CreatePatientResult {
  if (hasFailureStatus(raw)) {
    return {
      status: "error",
      reason: "middleware_error",
    };
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
    dob: stringValue(raw.dob) ?? fallback.dob,
    phone: stringValue(raw.phone) ?? fallback.phone,
    insuranceCarrier: stringValue(raw.insuranceCarrier),
    insPlanId: stringValue(raw.insPlanId),
    respPartyId: stringValue(raw.respPartyId),
    routing: stringValue(raw.routing),
    allowedProviders: Array.isArray(raw.allowedProviders)
      ? raw.allowedProviders.filter(
          (provider): provider is string => typeof provider === "string",
        )
      : [],
    routingAmbiguous: raw.routingAmbiguous === true,
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
    outcome === "booking_token_required"
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
    return {
      status: status === "partial" ? "partial" : "booked",
      appointmentId,
      ...(appointmentTypeId !== null ? { appointmentTypeId } : {}),
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
    ? {
        status: "error",
        reason: "middleware_error",
      }
    : invalidBookingResult();
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
  return {
    status: "error",
    reason: hasFailureStatus(raw) ? "middleware_error" : "invalid_response",
  };
}

function normalizeUpdatedInsurance(raw: unknown): UpdateInsuranceResult {
  if (isRecord(raw) && stringValue(raw.status)?.toLowerCase() === "updated") {
    return {
      status: "updated",
      newInsurance: stringValue(raw.newInsurance),
      routing: stringValue(raw.routing),
      allowedProviders: Array.isArray(raw.allowedProviders)
        ? raw.allowedProviders.filter(
            (provider): provider is string => typeof provider === "string",
          )
        : [],
      routingAmbiguous: raw.routingAmbiguous === true,
      preauthRequired: raw.preauthRequired === true,
    };
  }
  return {
    status: "error",
    reason: hasFailureStatus(raw) ? "middleware_error" : "invalid_response",
  };
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
