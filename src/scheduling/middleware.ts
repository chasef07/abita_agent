import type { OwnedMiddleware } from "../clients/owned-middleware.js";

export type SchedulingMiddleware = Pick<
  OwnedMiddleware,
  | "getAvailability"
  | "bookAppointment"
  | "cancelAppointment"
  | "rescheduleAppointment"
>;
