import { getOfficeProfileByPhone } from "../customers/abita/profile.js";
import {
  isRecord,
  normalizePatientResolveResponse,
  stringValue,
  type PatientResolveResult as LegacyPatientResolveResult,
  type PatientResolveVerified,
} from "./owned-middleware-patient.js";

const DEFAULT_PRODUCTION_BASE_URL =
  "https://advancedmd-token-management-production.up.railway.app";

export type { PatientResolveVerified };

export type MiddlewareFailureReason =
  | "middleware_error"
  | "network_error"
  | "invalid_response"
  | "unsupported_office"
  | "cancelled";

export type MiddlewareFailure = {
  status: "error";
  reason: MiddlewareFailureReason;
  message: string;
};

export type PatientResolveResult =
  Exclude<LegacyPatientResolveResult, { status: "error" }> | MiddlewareFailure;

export type PatientIdentity =
  { phone: string } | { firstName: string; lastName: string; dob: string };

export type AvailabilitySlot = {
  provider: string;
  date: string;
  time: string;
  datetime: string;
  bookingToken?: string;
};

export type AvailabilityResult =
  | {
      status: "found" | "none" | "incomplete";
      slots: AvailabilitySlot[];
      requestedDate?: string;
      actualDate?: string;
      searchedFrom?: string;
      searchedThrough?: string;
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

export type CreatePatientResult =
  | {
      status: "created";
      patientId: string;
      name: string | null;
      phone: string | null;
      insuranceCarrier: string | null;
      insPlanId: string | null;
      respPartyId: string | null;
      routing: string | null;
      allowedProviders: string[];
      routingAmbiguous: boolean;
      preauthRequired: boolean;
    }
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
      message: string;
    }
  | {
      status: "rejected";
      reason: "invalid_booking_token" | "booking_token_required";
      message: string;
    }
  | MiddlewareFailure;

export type CancelAppointmentResult =
  { status: "cancelled"; message: string | null } | MiddlewareFailure;

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
  }): Promise<PatientResolveResult>;
  getAvailability(request: {
    office: string;
    date: string;
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
  cancelAppointment(request: {
    office: string;
    appointmentId: number;
    patientId: string;
  }): Promise<CancelAppointmentResult>;
  updateInsurance(request: {
    office: string;
    update: UpdateInsuranceInput;
  }): Promise<UpdateInsuranceResult>;
}

let activeOwnedMiddleware: OwnedMiddleware | undefined;

export function ownedMiddleware(): OwnedMiddleware {
  return activeOwnedMiddleware ?? new HttpOwnedMiddleware();
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
  }): Promise<PatientResolveResult> {
    const transport = await this.#post(
      "/api/patient/resolve",
      request.office,
      request.identity,
      { failureMessage: "Patient lookup failed." },
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
      },
      {
        failureMessage: "I'm having trouble checking availability.",
        signal: request.signal,
      },
    );
    return transport.ok
      ? normalizeAvailability(transport.value)
      : transport.failure;
  }

  async createPatient(request: {
    office: string;
    patient: CreatePatientInput;
  }): Promise<CreatePatientResult> {
    const transport = await this.#post(
      "/api/add-patient",
      request.office,
      request.patient,
      { failureMessage: "The patient chart was not created." },
    );
    return transport.ok
      ? normalizeCreatedPatient(transport.value)
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
        failureMessage: "The appointment was not booked.",
        includeOffice: false,
      },
    );
    return transport.ok
      ? normalizeBookedAppointment(transport.value)
      : transport.failure;
  }

  async cancelAppointment(request: {
    office: string;
    appointmentId: number;
    patientId: string;
  }): Promise<CancelAppointmentResult> {
    const transport = await this.#post(
      "/api/appointment/cancel",
      request.office,
      {
        appointmentId: request.appointmentId,
        patientId: request.patientId,
      },
      { failureMessage: "The appointment was not cancelled." },
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
      { failureMessage: "Insurance was not updated." },
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
      failureMessage: string;
      includeOffice?: boolean;
      signal?: AbortSignal;
    },
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
          message: options.failureMessage,
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
            message: options.failureMessage,
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
            message: options.failureMessage,
          },
        };
      }
    } catch {
      return {
        ok: false,
        failure: {
          status: "error",
          reason: options.signal?.aborted ? "cancelled" : "network_error",
          message: options.failureMessage,
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
        message: "Patient lookup failed.",
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
        message: "Availability returned an invalid response.",
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
        message: "The patient chart was not created.",
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
        message: "The appointment was not booked.",
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
        message: "The appointment was not cancelled.",
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
        message: "Insurance was not updated.",
      }
    );
  }
}

function normalizeAvailability(raw: unknown): AvailabilityResult {
  if (hasFailureStatus(raw)) {
    return {
      status: "error",
      reason: "middleware_error",
      message: "I'm having trouble checking availability.",
    };
  }
  if (
    isRecord(raw) &&
    stringValue(raw.outcome) &&
    ![
      "availability_found",
      "no_availability",
      "availability_search_incomplete",
    ].includes(stringValue(raw.outcome) ?? "")
  ) {
    return {
      status: "error",
      reason: "middleware_error",
      message: "I'm having trouble checking availability.",
    };
  }
  if (!isRecord(raw) || !Array.isArray(raw.slots)) {
    return {
      status: "error",
      reason: "invalid_response",
      message: "Availability returned an invalid response.",
    };
  }
  if (!raw.slots.every(isAvailabilitySlot)) {
    return {
      status: "error",
      reason: "invalid_response",
      message: "Availability returned an invalid response.",
    };
  }
  const slots = raw.slots.map((slot) => ({
    provider: stringValue(slot.provider) ?? "",
    date: stringValue(slot.date) ?? "",
    time: stringValue(slot.time) ?? "",
    datetime: stringValue(slot.datetime) ?? "",
    ...(stringValue(slot.bookingToken)
      ? { bookingToken: stringValue(slot.bookingToken) ?? undefined }
      : {}),
  }));
  const outcome = stringValue(raw.outcome);
  const status =
    outcome === "no_availability"
      ? "none"
      : outcome === "availability_search_incomplete"
        ? "incomplete"
        : "found";
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
    dateShifted: raw.dateShifted === true,
    shouldRetrySameSearch: raw.shouldRetrySameSearch === true,
    ...(stringValue(raw.message)
      ? { message: stringValue(raw.message) ?? undefined }
      : {}),
  };
}

function normalizeCreatedPatient(raw: unknown): CreatePatientResult {
  if (hasFailureStatus(raw)) {
    return {
      status: "error",
      reason: "middleware_error",
      message: "The patient chart was not created.",
    };
  }
  if (!isRecord(raw) || !stringValue(raw.patientId)) {
    return {
      status: "error",
      reason: "invalid_response",
      message: "The patient chart was not created.",
    };
  }
  return {
    status: "created",
    patientId: stringValue(raw.patientId) ?? "",
    name: stringValue(raw.name),
    phone: stringValue(raw.phone),
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
  if (outcome === "slot_unavailable") {
    return {
      status: "unavailable",
      reason: "slot_unavailable",
      message: "That appointment time is no longer available.",
    };
  }
  if (
    outcome === "invalid_booking_token" ||
    outcome === "booking_token_required"
  ) {
    return {
      status: "rejected",
      reason: outcome,
      message: "Check availability again before booking.",
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
      message:
        "I could not confirm the booking because the appointment ID was missing. Check availability again before booking.",
    };
  }
  return hasFailureStatus(raw)
    ? {
        status: "error",
        reason: "middleware_error",
        message: "The appointment was not booked.",
      }
    : invalidBookingResult();
}

function normalizeCancelledAppointment(raw: unknown): CancelAppointmentResult {
  if (isRecord(raw) && stringValue(raw.status)?.toLowerCase() === "cancelled") {
    return {
      status: "cancelled",
      message: stringValue(raw.message),
    };
  }
  return {
    status: "error",
    reason: hasFailureStatus(raw) ? "middleware_error" : "invalid_response",
    message: "The appointment was not cancelled.",
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
    message: "Insurance was not updated.",
  };
}

function invalidBookingResult(): BookAppointmentResult {
  return {
    status: "error",
    reason: "invalid_response",
    message: "The appointment was not booked.",
  };
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
    stringValue(value.date) !== null &&
    stringValue(value.time) !== null &&
    stringValue(value.datetime) !== null
  );
}

function hasFailureStatus(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const status = stringValue(value.status)?.toLowerCase();
  return status === "error" || status === "failed" || status === "failure";
}
