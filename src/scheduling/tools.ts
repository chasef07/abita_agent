import { tool } from "@livekit/agents";
import { z } from "zod";
import { getState } from "../tools/session.js";
import {
  productionSchedulingMiddleware,
  type SchedulingMiddleware,
} from "./middleware.js";
import {
  systemSchedulingClock,
  type SchedulingClock,
} from "./availability-when.js";
import { SchedulingWorkflow } from "./workflow.js";

const APPOINTMENT_LANE_BY_VISIT_TYPE = {
  medical: "medical_md",
  routine_vision: "routine_od",
} as const;

const bookAppointmentParameters = z
  .object({
    appointmentSlotRef: z
      .string()
      .trim()
      .min(1)
      .describe(
        "Opaque slot reference from get_availability for the caller-confirmed slot.",
      ),
    appointmentReason: z
      .string()
      .trim()
      .min(1)
      .describe(
        "Concise caller-provided reason with enough detail for staff to prepare appropriate diagnostic testing. For an eye problem, include the symptom or concern plus one caller-provided detail, such as which eye or when it started. For routine care, state the routine purpose. Leave diagnosis to clinical staff and use caller-provided details only.",
      ),
    referringDoctor: z
      .string()
      .trim()
      .min(1)
      .describe(
        'Caller-provided referring doctor. When the caller reports no referring doctor, acknowledge briefly and continue. Pass "none" only as this tool\'s internal value and use natural caller-facing wording.',
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
        "Opaque call-scoped appointment reference associated with the exact loaded appointment confirmed by the caller.",
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
        'Caller-provided referring doctor. When the caller reports no referring doctor, acknowledge briefly and continue. Pass "none" only as this tool\'s internal value and use natural caller-facing wording.',
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
      "Pass those words verbatim in when, such as tomorrow morning or next Tuesday around 3 PM. " +
      "If the caller asks for the soonest, next available, any day, or only gives a time preference, pass those words unchanged so the workflow can search from the earliest allowed date. " +
      "For new appointments, call after appointment triage has established the visit type; for reschedules, call only after the existing appointment to move is identified. " +
      "On Hollywood or Sweetwater calls, ask which office the caller wants and use that answer as the office selection. " +
      "Offer only the returned slots. Treat this tool as a search and claim booking success only after book_appointment succeeds.",
    parameters: z
      .object({
        when: z
          .string()
          .trim()
          .min(1)
          .describe(
            "The caller's own date and time phrase, forwarded verbatim, such as tomorrow, next Tuesday around 3 PM, June 16 in the morning, or next available.",
          ),
        visitType: z
          .enum(["medical", "routine_vision"])
          .optional()
          .describe(
            "Visit type established by appointment triage. Required for new appointment searches; pass medical or routine_vision. " +
              "Omit only for reschedules when the loaded appointment supplies the visit type.",
          ),
        office: z
          .enum(["hollywood", "sweetwater"])
          .optional()
          .describe(
            "Required on Hollywood and Sweetwater calls after asking which office the caller wants. Use the caller's answer as the office value. Omit for every other office.",
          ),
      })
      .strict(),
    execute: async (args, { ctx, abortSignal }) => {
      ctx.disallowInterruptions();
      const { visitType, ...lookup } = args;
      return workflow.getAvailability(
        getState(ctx),
        {
          ...lookup,
          appointmentLane: visitType
            ? APPOINTMENT_LANE_BY_VISIT_TYPE[visitType]
            : undefined,
        },
        abortSignal,
      );
    },
  });

  const book_appointment = tool({
    name: "book_appointment",
    onDuplicate: "reject",
    description:
      "Book a caller-confirmed new appointment using a slot returned by get_availability. Use reschedule_appointment for appointment changes. " +
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
      "Pass only the matching call-scoped appointmentRef shown with that loaded appointment. The tool resolves it against current loaded appointment state.",
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
      "Pass appointmentSlotRef for the caller-confirmed new slot and use call-scoped references from loaded appointment state. The tool selects the old appointment from that state. " +
      "If more than one old appointment is loaded, make the first call with oldAppointmentRef omitted, ask the caller which listed appointment to move, then make the next call after you can pass the matching oldAppointmentRef. " +
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
