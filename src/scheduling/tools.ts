import { tool } from "@livekit/agents";
import { z } from "zod";
import { getState } from "../tools/session.js";
import type { SchedulingMiddleware } from "./middleware.js";
import {
  systemSchedulingClock,
  type SchedulingClock,
} from "./availability-when.js";
import { returnSchedulingInputRequired } from "./input-required.js";
import { SchedulingWorkflow } from "./workflow.js";

const APPOINTMENT_LANE_BY_VISIT_TYPE = {
  medical: "medical_md",
  routine_vision: "routine_od",
} as const;

type AvailabilityOfficeMode = "omitted" | "required";

type SchedulingToolOptions = {
  availabilityOfficeMode: AvailabilityOfficeMode;
};

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
      .literal(true)
      .nullable()
      .describe(
        "Set to true only after reading back the selected appointment date, time, and provider and the caller confirms the appointment details are correct. Pass null until confirmed.",
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
      .literal(true)
      .nullable()
      .describe(
        "Set to true only after reading back the selected new appointment date, time, and provider and the caller confirms the new appointment details are correct. Pass null until confirmed.",
      ),
    oldAppointmentRef: z
      .string()
      .trim()
      .min(1)
      .nullable()
      .describe(
        "Loaded appointment reference returned by reschedule_appointment when multiple old appointments are loaded. Pass null when one loaded appointment is unambiguous or on the initial multiple-appointment clarification call before a reference is available.",
      ),
  })
  .strict();

export function createSchedulingTools(
  middleware: SchedulingMiddleware,
  clock: SchedulingClock = systemSchedulingClock,
  options: SchedulingToolOptions = { availabilityOfficeMode: "omitted" },
) {
  const workflow = new SchedulingWorkflow(middleware, clock);
  const { availabilityOfficeMode } = options;

  const availabilityFields = {
    when: z
      .string()
      .trim()
      .min(1)
      .describe(
        "The caller's own date and time phrase, forwarded verbatim, such as tomorrow, next Tuesday around 3 PM, June 16 in the morning, or next available.",
      ),
    visitType: z
      .enum(["medical", "routine_vision"])
      .nullable()
      .describe(
        "Visit type established by appointment triage. Required for new appointment searches; pass medical or routine_vision. " +
          "Pass null only for reschedules when the loaded appointment supplies the visit type.",
      ),
    oldAppointmentRef: z
      .string()
      .trim()
      .min(1)
      .nullable()
      .describe(
        "For reschedules, pass the appointmentRef for the exact loaded appointment the caller confirmed they want to move. Pass null when the sole loaded appointment applies or for new appointments.",
      ),
  };
  const officeField = z
    .enum(["hollywood", "sweetwater"])
    .describe(
      "Required on Hollywood and Sweetwater calls after asking which office the caller wants. Use the caller's answer as the office value.",
    );
  const availabilityParameters = z
    .object(
      availabilityOfficeMode === "required"
        ? { ...availabilityFields, office: officeField }
        : availabilityFields,
    )
    .strict();
  const availabilityOfficeInstructions =
    availabilityOfficeMode === "required"
      ? "Ask whether the caller wants Hollywood or Sweetwater, then pass that selection in office. "
      : "Use the office selected by the inbound call. ";

  const get_availability = tool({
    name: "get_availability",
    description:
      "Search appointment availability using the caller's own date and time words. " +
      "Pass those words verbatim in when, such as tomorrow morning or next Tuesday around 3 PM. " +
      "If the caller asks for the soonest, next available, any day, or only gives a time preference, pass those words unchanged so the workflow can search from the earliest allowed date. " +
      "For new appointments, call after appointment triage has established the visit type and pass visitType even when appointments are loaded. For reschedules, identify the existing appointment to move, pass its oldAppointmentRef when multiple appointments are loaded, and pass visitType as null. " +
      availabilityOfficeInstructions +
      "Offer only the returned slots. Treat this tool as a search and claim booking success only after book_appointment succeeds.",
    parameters: availabilityParameters,
    execute: async (args, { ctx, abortSignal }) => {
      ctx.disallowInterruptions();
      const office = "office" in args ? args.office : undefined;
      return returnSchedulingInputRequired(() =>
        workflow.getAvailability(
          getState(ctx),
          {
            when: args.when,
            ...(office ? { office } : {}),
            ...(args.oldAppointmentRef
              ? { oldAppointmentRef: args.oldAppointmentRef }
              : {}),
            appointmentLane: args.visitType
              ? APPOINTMENT_LANE_BY_VISIT_TYPE[args.visitType]
              : undefined,
          },
          abortSignal,
        ),
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
      return returnSchedulingInputRequired(() =>
        workflow.bookAppointment(getState(ctx), {
          ...args,
          readBack: args.readBack ?? undefined,
        }),
      );
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
      return returnSchedulingInputRequired(() =>
        workflow.cancelAppointment(getState(ctx), args),
      );
    },
  });

  const reschedule_appointment = tool({
    name: "reschedule_appointment",
    onDuplicate: "reject",
    description:
      "Reschedule a loaded appointment. " +
      "Call after the patient is verified, the caller confirms the exact old appointment to move, get_availability returns an appointmentSlotRef, the caller confirms the exact new slot, and the caller provides a referring doctor or says they have none. The sole exception to exact old-appointment confirmation is the initial multiple-appointment clarification call described below. " +
      "Pass appointmentSlotRef for the caller-confirmed new slot and use call-scoped references from loaded appointment state. The tool selects the old appointment from that state. " +
      "If more than one old appointment is loaded, make the first call with oldAppointmentRef as null, ask the caller which listed appointment to move, then make the next call after you can pass the matching oldAppointmentRef. " +
      "Before booking the new appointment, read back the selected new appointment date, time, and provider, then get caller confirmation. " +
      "This tool books the new appointment first and cancels the old appointment only after booking succeeds.",
    parameters: rescheduleAppointmentParameters,
    execute: async (args, { ctx }) => {
      ctx.disallowInterruptions();
      return returnSchedulingInputRequired(() =>
        workflow.rescheduleAppointment(getState(ctx), {
          ...args,
          oldAppointmentRef: args.oldAppointmentRef ?? undefined,
          readBack: args.readBack ?? undefined,
        }),
      );
    },
  });

  return {
    get_availability,
    book_appointment,
    cancel_appointment,
    reschedule_appointment,
  };
}
