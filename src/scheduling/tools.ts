import { tool } from "@livekit/agents";
import { z } from "zod";
import { getState } from "../tools/session.js";
import {
  productionSchedulingMiddleware,
  type SchedulingMiddleware,
} from "./middleware.js";
import { SchedulingWorkflow } from "./workflow.js";

const isoDateSchema = z
  .string()
  .trim()
  .regex(
    /^\d{4}-\d{2}-\d{2}$/,
    "Use an exact date in YYYY-MM-DD format. Call get_current_datetime first for relative dates.",
  );

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
    appointmentDate: z
      .string()
      .optional()
      .describe(
        'Date the caller used to identify a loaded appointment, such as "June 2", "June 2nd", or "2026-06-02".',
      ),
    appointmentTime: z
      .string()
      .optional()
      .describe(
        'Time the caller used to identify a loaded appointment, such as "10 AM" or "2:30 PM". Use with appointmentDate when needed.',
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

export function createSchedulingTools(middleware: SchedulingMiddleware) {
  const workflow = new SchedulingWorkflow(middleware);

  const get_availability = tool({
    name: "get_availability",
    description:
      "Search appointment availability from an exact YYYY-MM-DD start date. " +
      "For new appointments, pass appointmentLane after the visit reason is clear; for reschedules, omit it only when the existing appointment to move is already identified. " +
      "If the caller requests a routine exam but also mentions an eye problem or symptom, ask whether the appointment is mainly for glasses or contacts or for the eye problem before choosing appointmentLane. " +
      "On Hollywood or Sweetwater calls, ask which of those two offices the caller wants and pass office; never infer the scheduling office from the number they called. " +
      "Use timePreference to rank morning, afternoon, or no-preference requests. " +
      "Do not call for same-day or past dates. Call get_current_datetime before using relative dates, and do not pass relative phrases here. " +
      "This tool returns plain instructions with at most two appointmentSlotRef values; offer only those returned slots and do not invent other times. " +
      "This tool only finds possible slots; do not say the caller is booked, scheduled, or all set until book_appointment returns a successful booking.",
    parameters: z.object({
      date: isoDateSchema.describe("Start date in YYYY-MM-DD format."),
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
      timePreference: z
        .enum(["morning", "afternoon", "none"])
        .optional()
        .describe(
          "Caller time-of-day preference for ranking returned slots. Use morning for AM or before-noon requests, afternoon for PM or afternoon requests, and none when the caller has no time preference.",
        ),
    }),
    execute: async (args, { ctx, abortSignal }) => {
      ctx.disallowInterruptions();
      return workflow.getAvailability(getState(ctx), args, abortSignal);
    },
  });

  const book_appointment = tool({
    name: "book_appointment",
    onDuplicate: "reject",
    description:
      "Book a caller-confirmed appointment slot. " +
      "Use only for new appointments after get_availability recorded appointmentLane; do not use for reschedules or other appointment changes. " +
      "Pass an appointmentReason with enough caller-provided detail for staff to prepare appropriate diagnostic testing; do not diagnose or add details the caller did not provide. " +
      "Call only after get_availability returns an appointmentSlotRef for the right appointment lane, the caller confirms the exact offered slot, and the caller provides a referring doctor or says they have none. " +
      "Before booking, read back the selected appointment date, time, and provider, then get caller confirmation. " +
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
      "Pass appointmentDate and appointmentTime when the caller identifies the appointment by date or time. " +
      "Do not pass backend patient IDs or appointment IDs; the tool selects the appointment from loaded appointment state. " +
      "Omit all appointment selectors only for the latest booked appointment or exactly one loaded appointment.",
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
