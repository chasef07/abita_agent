import {
  ownedMiddleware,
  type AvailabilityResult,
  type BookAppointmentInput,
  type BookAppointmentResult,
  type CancelAppointmentResult,
  type OwnedMiddleware,
} from "../clients/owned-middleware.js";

export type AvailabilityRequest = Omit<
  Parameters<OwnedMiddleware["getAvailability"]>[0],
  "office" | "signal"
>;
export type AvailabilitySlot = Extract<
  AvailabilityResult,
  { status: "found" | "none" | "incomplete" }
>["slots"][number];
export type { AvailabilityResult };

export type BookingRequest = BookAppointmentInput;
export type BookingResult = BookAppointmentResult;
export type BookingSuccess = Extract<
  BookAppointmentResult,
  { status: "booked" | "partial" }
>;
export type CancellationRequest = Omit<
  Parameters<OwnedMiddleware["cancelAppointment"]>[0],
  "office"
>;
export type CancellationResult = CancelAppointmentResult;

export interface SchedulingMiddleware {
  getAvailability(input: {
    request: AvailabilityRequest;
    office: string;
    signal?: AbortSignal;
  }): Promise<AvailabilityResult>;
  bookAppointment(input: {
    request: BookingRequest;
    office: string;
  }): Promise<BookingResult>;
  cancelAppointment(input: {
    request: CancellationRequest;
    office: string;
  }): Promise<CancellationResult>;
}

export const productionSchedulingMiddleware: SchedulingMiddleware = {
  getAvailability: ({ request, office, signal }) =>
    ownedMiddleware().getAvailability({ ...request, office, signal }),
  bookAppointment: ({ request, office }) =>
    ownedMiddleware().bookAppointment({ booking: request, office }),
  cancelAppointment: ({ request, office }) =>
    ownedMiddleware().cancelAppointment({ ...request, office }),
};
