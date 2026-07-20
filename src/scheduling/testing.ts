import type {
  AvailabilityRequest,
  AvailabilityResult,
  BookingRequest,
  BookingResult,
  CancellationRequest,
  CancellationResult,
  SchedulingMiddleware,
} from "./middleware.js";

type SchedulingResult<T> = T | Error | Promise<T>;

export type SchedulingOperation =
  | {
      kind: "availability";
      request: AvailabilityRequest;
      office: string;
    }
  | {
      kind: "book";
      request: BookingRequest;
      office: string;
    }
  | {
      kind: "cancel";
      request: CancellationRequest;
      office: string;
    };

export class InMemorySchedulingMiddleware implements SchedulingMiddleware {
  readonly operations: SchedulingOperation[] = [];

  readonly #availability: Array<SchedulingResult<AvailabilityResult>>;
  readonly #bookings: Array<SchedulingResult<BookingResult>>;
  readonly #cancellations: Array<SchedulingResult<CancellationResult>>;

  constructor(
    outcomes: {
      availability?: Array<SchedulingResult<AvailabilityResult>>;
      bookings?: Array<SchedulingResult<BookingResult>>;
      cancellations?: Array<SchedulingResult<CancellationResult>>;
    } = {},
  ) {
    this.#availability = [...(outcomes.availability ?? [])];
    this.#bookings = [...(outcomes.bookings ?? [])];
    this.#cancellations = [...(outcomes.cancellations ?? [])];
  }

  async getAvailability(input: {
    request: AvailabilityRequest;
    office: string;
  }): Promise<AvailabilityResult> {
    this.operations.push({ kind: "availability", ...input });
    return nextResult(this.#availability, "availability");
  }

  async bookAppointment(input: {
    request: BookingRequest;
    office: string;
  }): Promise<BookingResult> {
    this.operations.push({ kind: "book", ...input });
    return nextResult(this.#bookings, "booking");
  }

  async cancelAppointment(input: {
    request: CancellationRequest;
    office: string;
  }): Promise<CancellationResult> {
    this.operations.push({ kind: "cancel", ...input });
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
