import { currentAppointmentReferences } from "./appointments.js";
import { activePatientId, type CallState } from "../state/call-state.js";
import { tool } from "@livekit/agents";
import { z } from "zod";
import { getState } from "../tools/session.js";
import type { SchedulingMiddleware } from "./middleware.js";
import { systemSchedulingClock, type SchedulingClock } from "./clock.js";
import { returnSchedulingInputRequired } from "./input-required.js";
import { SchedulingWorkflow } from "./workflow.js";

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
        "Opaque list_available_appointments reference for the caller-confirmed slot.",
      ),
    appointmentReason: z
      .string()
      .trim()
      .min(1)
      .describe(
        "Caller-provided routine purpose, or symptom or concern plus one useful detail such as eye or onset. Record caller facts only; do not diagnose.",
      ),
    referringDoctor: z
      .string()
      .trim()
      .min(1)
      .describe(
        'Caller-provided referring doctor. If not already answered, ask "Did a doctor refer you?" and, if yes, ask for the name. Use internal value "none" only when the caller says they have no referring doctor. Do not ask whether to put or mark none, or narrate the internal value.',
      ),
    readBack: z
      .literal(true)
      .nullable()
      .describe(
        "True only after the caller confirms the date, time, and provider read-back; otherwise null.",
      ),
  })
  .strict();

const loadedAppointmentParameters = z
  .object({
    appointmentRef: z
      .string()
      .trim()
      .min(1)
      .describe(
        "Opaque call-scoped reference for the exact confirmed loaded appointment.",
      ),
  })
  .strict();

const rescheduleAppointmentParameters = bookAppointmentParameters
  .extend({
    oldAppointmentRef:
      loadedAppointmentParameters.shape.appointmentRef.describe(
        "Opaque reference of the caller-confirmed existing appointment to move.",
      ),
    appointmentSlotRef:
      bookAppointmentParameters.shape.appointmentSlotRef.describe(
        "Opaque list_available_appointments reference for the confirmed new slot.",
      ),
    appointmentReason:
      bookAppointmentParameters.shape.appointmentReason.describe(
        "Caller-provided reason for the new appointment.",
      ),
    readBack: bookAppointmentParameters.shape.readBack.describe(
      "True only after the caller confirms the new date, time, and provider read-back; otherwise null.",
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
    startDate: z.iso
      .date()
      .nullable()
      .default(null)
      .describe(
        "First date of a 14-calendar-day window, YYYY-MM-DD in Eastern time; tomorrow or later only. Omit or pass null for tomorrow. For a future date, start there directly. To search later, use the day after the loaded window ends. Reuse the loaded list for day/time preferences within its window.",
      ),
    visitType: z
      .enum(["medical", "routine_vision"])
      .describe(
        "Visit type for this availability: medical or routine_vision, for either a new booking or a reschedule.",
      ),
  };
  const officeField = z
    .enum(["hollywood", "sweetwater"])
    .describe(
      "Caller-selected Hollywood or Sweetwater office; ask before searching.",
    );
  const availabilityParameters = z
    .object(
      availabilityOfficeMode === "required"
        ? { ...availabilityFields, office: officeField }
        : availabilityFields,
    )
    .strict();
  const list_available_appointments = tool({
    name: "list_available_appointments",
    description:
      "Load eligible appointments after triage for one 14-calendar-day window. " +
      "Offer only returned slots, at most two at a time. Match follow-up preferences from the loaded list. " +
      "Pass the appropriate medical or routine_vision visitType for either booking or rescheduling. " +
      "Book the confirmed reference with book_appointment, or reschedule_appointment for an existing visit.",
    parameters: availabilityParameters,
    execute: async (args, { ctx, abortSignal }): Promise<string> => {
      ctx.disallowInterruptions();
      const office = "office" in args ? args.office : undefined;
      return returnSchedulingInputRequired(() =>
        workflow.getAvailability(
          getState(ctx),
          {
            startDate: args.startDate ?? undefined,
            ...(office ? { office } : {}),
            visitType: args.visitType,
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
      "Book a new appointment using a caller-confirmed slot from list_available_appointments; use reschedule_appointment to move an existing appointment. " +
      "Call only after confirmation of the exact date, time, and provider and after learning who referred the caller or that no doctor referred them. " +
      "Claim booking success only from this tool's successful result; duplicate calls are rejected.",
    parameters: bookAppointmentParameters,
    execute: async (args, { ctx, toolCallId }): Promise<string> => {
      ctx.disallowInterruptions();
      const state = getState(ctx);
      return withCurrentAppointments(state, () =>
        returnSchedulingInputRequired(() =>
          workflow.bookAppointment(
            state,
            {
              ...args,
              readBack: args.readBack ?? undefined,
            },
            toolCallId,
          ),
        ),
      );
    },
  });

  const cancel_appointment = tool({
    name: "cancel_appointment",
    onDuplicate: "reject",
    description:
      "Cancel a loaded appointment only after patient verification and confirmation of the exact appointment. " +
      "Pass its opaque call-scoped appointmentRef; the tool validates it against current state. " +
      "Claim cancellation success only from this tool's result, and do not retry a completed cancellation.",
    parameters: loadedAppointmentParameters,
    execute: async (args, { ctx, toolCallId }): Promise<string> => {
      ctx.disallowInterruptions();
      const state = getState(ctx);
      return withCurrentAppointments(state, () =>
        returnSchedulingInputRequired(() =>
          workflow.cancelAppointment(state, args, toolCallId),
        ),
      );
    },
  });

  const reschedule_appointment = tool({
    name: "reschedule_appointment",
    onDuplicate: "reject",
    description:
      "Move a verified patient's loaded appointment to a caller-confirmed slot from list_available_appointments after learning who referred the caller or that no doctor referred them. " +
      "Require confirmation of the old appointment and a read-back of the new date, time, and provider; use only opaque call-scoped references. " +
      "This tool books first, then cancels the old appointment; report partial success if cancellation fails, and never retry the booking.",
    parameters: rescheduleAppointmentParameters,
    execute: async (args, { ctx, toolCallId }): Promise<string> => {
      ctx.disallowInterruptions();
      const state = getState(ctx);
      return withCurrentAppointments(state, () =>
        returnSchedulingInputRequired(() =>
          workflow.rescheduleAppointment(
            state,
            {
              ...args,
              readBack: args.readBack ?? undefined,
            },
            toolCallId,
          ),
        ),
      );
    },
  });

  return {
    list_available_appointments,
    book_appointment,
    cancel_appointment,
    reschedule_appointment,
  };
}

async function withCurrentAppointments(
  state: CallState,
  execute: () => Promise<string>,
): Promise<string> {
  const patientId = activePatientId(state);
  const transitionVersion = state.identity.transitionVersion;
  const result = await execute();
  if (
    !patientId ||
    activePatientId(state) !== patientId ||
    state.identity.transitionVersion !== transitionVersion
  )
    return result;
  const references = currentAppointmentReferences(state);
  return references ? `${result}\n${references}` : result;
}
