import { tool } from "@livekit/agents";
import { z } from "zod";
import { getState } from "../tools/session.js";
import {
  productionSchedulingMiddleware,
  type SchedulingMiddleware,
} from "./middleware.js";
import { systemSchedulingClock, type SchedulingClock } from "./temporal.js";
import { SchedulingWorkflow } from "./workflow.js";

const bookAppointmentParameters = z
  .object({
    appointmentSlotRef: z
      .string()
      .trim()
      .min(1)
      .describe(
        "Slot reference from get_availability for the caller-confirmed slot; this is not a backend ID.",
      ),
    appointmentReason: z
      .string()
      .trim()
      .min(1)
      .describe(
        "Concise caller-provided reason with enough detail for staff to prepare appropriate diagnostic testing. For an eye problem, include the symptom or concern plus one useful detail, such as which eye or when it started. For routine care, state the routine purpose. Do not diagnose or add details the caller did not provide.",
      ),
    referringDoctor: z
      .string()
      .trim()
      .min(1)
      .describe(
        'Caller-provided referring doctor, or "none" if the caller has no referring doctor.',
      ),
    readBack: z
      .boolean()
      .optional()
      .describe(
        "Set to true only after reading back the selected appointment date, time, and provider and the caller confirms the appointment details are correct.",
      ),
  })
  .strict();

const cancelAppointmentParameters = z
  .object({
    appointmentRef: z
      .string()
      .trim()
      .min(1)
      .describe(
        "Opaque appointment reference associated with the exact loaded appointment confirmed by the caller; this is not a backend ID.",
      ),
  })
  .strict();

const rescheduleAppointmentParameters = z
  .object({
    appointmentSlotRef: z
      .string()
      .trim()
      .min(1)
      .describe(
        "Slot reference from get_availability for the caller-confirmed new appointment slot.",
      ),
    appointmentReason: z
      .string()
      .trim()
      .min(1)
      .describe("Caller-provided reason for the new appointment."),
    referringDoctor: z
      .string()
      .trim()
      .min(1)
      .describe(
        'Caller-provided referring doctor, or "none" if the caller has no referring doctor.',
      ),
    readBack: z
      .boolean()
      .optional()
      .describe(
        "Set to true only after reading back the selected new appointment date, time, and provider and the caller confirms the new appointment details are correct.",
      ),
    oldAppointmentRef: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        "Loaded appointment reference returned by reschedule_appointment when multiple old appointments are loaded. Omit when exactly one old appointment is loaded.",
      ),
  })
  .strict();

export function createSchedulingTools(
  middleware: SchedulingMiddleware,
  clock: SchedulingClock = systemSchedulingClock,
) {
  const workflow = new SchedulingWorkflow(middleware, clock);

  const get_availability = tool({
    name: "get_availability",
    description:
      "Search appointment availability using the caller's own date and time words. " +
      "Pass those words unchanged in when, such as tomorrow morning or next Tuesday around 3 PM; do not calculate or convert them to a date or time. " +
      "If the caller asks for the soonest, next available, any day, or only gives a time preference, pass those words unchanged so the workflow can search from the earliest allowed date. " +
      "For new appointments, call after the visit reason and lane are clear; for reschedules, call only after the existing appointment to move is identified. " +
      "If a routine exam caller also mentions an eye problem or symptom, ask whether the appointment is mainly for glasses or contacts or for the eye problem before choosing appointmentLane. " +
      "On Hollywood or Sweetwater calls, ask which office the caller wants; never infer it from the number called. " +
      "Offer only the returned slots. This tool does not book; only claim success after book_appointment succeeds.",
    parameters: z
      .object({
        when: z
          .string()
          .trim()
          .min(1)
          .describe(
            "The caller's own date and time phrase, forwarded without converting it, such as tomorrow, next Tuesday around 3 PM, June 16 in the morning, or next available.",
          ),
        appointmentLane: z
          .enum(["medical_md", "routine_od"])
          .optional()
          .describe(
            "Required for new appointment searches. Use medical_md for medical or eye-problem visits, routine_od for routine vision. Omit only for reschedules when the loaded appointment supplies the lane.",
          ),
        office: z
          .enum(["hollywood", "sweetwater"])
          .optional()
          .describe(
            "Required on Hollywood and Sweetwater calls after asking which office the caller wants. Do not infer it from the number called. Omit for every other office.",
          ),
      })
      .strict(),
    execute: async (args, { ctx, abortSignal }) => {
      ctx.disallowInterruptions();
      return workflow.getAvailability(getState(ctx), args, abortSignal);
    },
  });

  const book_appointment = tool({
    name: "book_appointment",
    onDuplicate: "reject",
    description:
      "Book a caller-confirmed new appointment using a slot returned by get_availability; do not use for reschedules or other appointment changes. " +
      "Call only after the caller confirms the exact offered slot and provides a referring doctor or says they have none. " +
      "Only after this tool returns a successful booking may you tell the caller they are booked, scheduled, or all set. " +
      "After a successful booking, if the caller asks whether they will receive confirmation, say yes, a confirmation email will be sent.",
    parameters: bookAppointmentParameters,
    execute: async (args, { ctx }) => {
      ctx.disallowInterruptions();
      return workflow.bookAppointment(getState(ctx), args);
    },
  });

  const cancel_appointment = tool({
    name: "cancel_appointment",
    onDuplicate: "reject",
    description:
      "Cancel a loaded appointment. " +
      "Call this after the patient is verified and the caller confirms the exact appointment to cancel. " +
      "Pass the matching appointmentRef shown with that loaded appointment. " +
      "Do not pass backend patient IDs or appointment IDs. " +
      "Do not pass appointment dates or times; the tool resolves appointmentRef only against current loaded appointment state.",
    parameters: cancelAppointmentParameters,
    execute: async (args, { ctx }) => {
      ctx.disallowInterruptions();
      return workflow.cancelAppointment(getState(ctx), args);
    },
  });

  const reschedule_appointment = tool({
    name: "reschedule_appointment",
    onDuplicate: "reject",
    description:
      "Reschedule a loaded appointment. " +
      "Call only after the patient is verified, the caller confirms the exact old appointment to move, get_availability returns an appointmentSlotRef, the caller confirms the exact new slot, and the caller provides a referring doctor or says they have none. " +
      "Pass appointmentSlotRef for the caller-confirmed new slot. Do not pass backend patient IDs or appointment IDs. Do not pass old appointment dates or old appointment times; the tool selects the old appointment from loaded appointment state. " +
      "If more than one old appointment is loaded, call once without oldAppointmentRef, ask the caller which listed appointment to move, then do not call this tool again until you can pass the matching oldAppointmentRef. " +
      "Before booking the new appointment, read back the selected new appointment date, time, and provider, then get caller confirmation. " +
      "This tool books the new appointment first and cancels the old appointment only after booking succeeds.",
    parameters: rescheduleAppointmentParameters,
    execute: async (args, { ctx }) => {
      ctx.disallowInterruptions();
      return workflow.rescheduleAppointment(getState(ctx), args);
    },
  });

  return {
    get_availability,
    book_appointment,
    cancel_appointment,
    reschedule_appointment,
  };
}

export const {
  get_availability,
  book_appointment,
  cancel_appointment,
  reschedule_appointment,
} = createSchedulingTools(productionSchedulingMiddleware);
