import type {
  AvailabilityResult,
  BookAppointmentResult,
  CancelAppointmentResult,
  CreatePatientResult,
  OwnedMiddleware,
  PatientResolveResult,
  UpdateInsuranceResult,
} from "../../clients/owned-middleware.js";

export type InMemoryOwnedMiddlewareResponses = {
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

// Explicit candidate-only response for tests of first-name/DOB search + ID load.
export function candidateSearchResult(
  ...patients: Array<Extract<PatientResolveResult, { status: "verified" }>>
): Extract<PatientResolveResult, { status: "candidates" }> {
  return {
    status: "candidates",
    source: "first_name",
    complete: true,
    matches: patients.map((patient) => {
      const name = patient.name ?? "";
      const comma = name.split(",");
      const firstName =
        comma.length > 1 ? comma[1]!.trim() : name.split(" ")[0]!;
      const lastName =
        comma.length > 1
          ? comma[0]!.trim()
          : name.split(" ").slice(1).join(" ");
      return {
        status: "candidate",
        patientId: patient.patientId,
        firstName,
        lastName,
        dob: patient.dob ?? "",
      };
    }),
  };
}
