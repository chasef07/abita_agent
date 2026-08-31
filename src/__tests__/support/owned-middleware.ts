import type {
  AvailabilityResult,
  BookAppointmentResult,
  CancelAppointmentResult,
  CreatePatientResult,
  InsuranceCheckResult,
  OwnedMiddleware,
  PatientResolveResult,
  UpdateInsuranceResult,
} from "../../clients/owned-middleware.js";
import { getOfficeProfileByPhone } from "../../customers/abita/profile.js";
import { matchInsurancePlanForOffice } from "../../insurance-rules.js";

export type InMemoryOwnedMiddlewareResponses = {
  checkInsurance?: Array<InsuranceCheckResult | Promise<InsuranceCheckResult>>;
  resolvePatient?: Array<
    PatientResolveResult | Error | Promise<PatientResolveResult>
  >;
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
    checkInsurance: [] as Array<
      Parameters<OwnedMiddleware["checkInsurance"]>[0]
    >,
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

  async checkInsurance(
    request: Parameters<OwnedMiddleware["checkInsurance"]>[0],
  ): Promise<InsuranceCheckResult> {
    this.requests.checkInsurance.push(request);
    this.operations.push({ name: "checkInsurance", request });
    return (
      (await this.#responses.checkInsurance?.shift()) ?? {
        ...matchInsurancePlanForOffice(
          getOfficeProfileByPhone(request.office).key,
          request.plan,
          request.coverageType,
        ),
        authoritative: false,
      }
    );
  }

  async resolvePatient(
    request: Parameters<OwnedMiddleware["resolvePatient"]>[0],
  ): Promise<PatientResolveResult> {
    this.requests.resolvePatient.push(request);
    this.operations.push({ name: "resolvePatient", request });
    const result = await this.#responses.resolvePatient?.shift();
    if (result instanceof Error) throw result;
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
