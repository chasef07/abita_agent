import type {
  RescheduleAppointmentResult,
  AvailabilityResult,
  BookAppointmentResult,
  CancelAppointmentResult,
  CancelAppointmentInput,
} from "../../clients/owned-middleware.js";
import type { SchedulingMiddleware } from "../../scheduling/middleware.js";

type SchedulingResult<T> = T | Error | Promise<T>;

// Normalize recorded operations for assertions; method inputs use the owned API contract.
export type SchedulingOperation =
  | {
      kind: "reschedule";
      office: string;
      request: Parameters<
        SchedulingMiddleware["rescheduleAppointment"]
      >[0]["booking"];
    }
  | {
      kind: "availability";
      signal?: AbortSignal;
      office: string;
      request: Omit<
        Parameters<SchedulingMiddleware["getAvailability"]>[0],
        "office" | "signal"
      >;
    }
  | {
      kind: "book";
      office: string;
      request: Parameters<
        SchedulingMiddleware["bookAppointment"]
      >[0]["booking"];
    }
  | {
      kind: "cancel";
      office: string;
      request: CancelAppointmentInput;
    };

export class InMemorySchedulingMiddleware implements SchedulingMiddleware {
  readonly operations: SchedulingOperation[] = [];

  readonly #reschedules: Array<SchedulingResult<RescheduleAppointmentResult>>;
  readonly #availability: Array<SchedulingResult<AvailabilityResult>>;
  readonly #bookings: Array<SchedulingResult<BookAppointmentResult>>;
  readonly #cancellations: Array<SchedulingResult<CancelAppointmentResult>>;

  constructor(
    outcomes: {
      reschedules?: Array<SchedulingResult<RescheduleAppointmentResult>>;
      availability?: Array<SchedulingResult<AvailabilityResult>>;
      bookings?: Array<SchedulingResult<BookAppointmentResult>>;
      cancellations?: Array<SchedulingResult<CancelAppointmentResult>>;
    } = {},
  ) {
    this.#reschedules = [...(outcomes.reschedules ?? [])];
    this.#availability = [...(outcomes.availability ?? [])];
    this.#bookings = [...(outcomes.bookings ?? [])];
    this.#cancellations = [...(outcomes.cancellations ?? [])];
  }

  async getAvailability(
    input: Parameters<SchedulingMiddleware["getAvailability"]>[0],
  ): Promise<AvailabilityResult> {
    const { office, signal, ...request } = input;
    this.operations.push({
      kind: "availability",
      office,
      request,
      ...(signal ? { signal } : {}),
    });
    return nextResult(this.#availability, "availability");
  }

  async bookAppointment(
    input: Parameters<SchedulingMiddleware["bookAppointment"]>[0],
  ): Promise<BookAppointmentResult> {
    this.operations.push({
      kind: "book",
      office: input.office,
      request: input.booking,
    });
    return nextResult(this.#bookings, "booking");
  }

  async rescheduleAppointment(
    input: Parameters<SchedulingMiddleware["rescheduleAppointment"]>[0],
  ): Promise<RescheduleAppointmentResult> {
    this.operations.push({
      kind: "reschedule",
      office: input.office,
      request: input.booking,
    });
    return nextResult(this.#reschedules, "reschedule");
  }

  async cancelAppointment(
    input: Parameters<SchedulingMiddleware["cancelAppointment"]>[0],
  ): Promise<CancelAppointmentResult> {
    const { office, ...request } = input;
    this.operations.push({ kind: "cancel", office, request });
    return nextResult(this.#cancellations, "cancellation");
  }
}

function nextResult<T>(
  results: Array<SchedulingResult<T>>,
  operation: string,
): T | Promise<T> {
  if (results.length === 0) {
    throw new Error(`No in-memory ${operation} outcome remains.`);
  }
  const result = results.shift();
  if (result instanceof Error) throw result;
  return result as T;
}
