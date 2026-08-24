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
        "Opaque get_availability reference for the caller-confirmed slot.",
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
        'Caller-provided referring doctor; use internal value "none" when they have none.',
      ),
    readBack: z
      .literal(true)
      .nullable()
      .describe(
        "True only after the caller confirms the date, time, and provider read-back; otherwise null.",
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
        "Opaque call-scoped reference for the exact confirmed loaded appointment.",
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
        "Opaque get_availability reference for the confirmed new slot.",
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
        'Caller-provided referring doctor; use internal value "none" when they have none.',
      ),
    readBack: z
      .literal(true)
      .nullable()
      .describe(
        "True only after the caller confirms the new date, time, and provider read-back; otherwise null.",
      ),
    oldAppointmentRef: z
      .string()
      .trim()
      .min(1)
      .nullable()
      .describe(
        "Opaque old-appointment reference when multiple appointments are loaded; otherwise null.",
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
    branches: z
      .array(
        z
          .object({
            datePhrase: z
              .string()
              .trim()
              .min(1)
              .describe(
                "Caller-derived calendar wording for this acceptable branch, such as tomorrow, Tuesday, June 16, or next available. Leave ISO-date calculation to the Scheduling Workflow.",
              ),
            time: z.discriminatedUnion("operator", [
              z.object({ operator: z.literal("any") }).strict(),
              z.object({ operator: z.literal("morning") }).strict(),
              z.object({ operator: z.literal("afternoon") }).strict(),
              z
                .object({
                  operator: z.enum(["exact", "around", "before", "after"]),
                  clockPhrase: z.string().trim().min(1),
                })
                .strict(),
            ]),
          })
          .strict(),
      )
      .min(1)
      .max(15)
      .describe(
        "Caller-derived alternatives using OR between branches and AND between each branch's date and time.",
      ),
    visitType: z
      .enum(["medical", "routine_vision"])
      .nullable()
      .describe(
        "Triaged type for new visits: medical or routine_vision; null for reschedules.",
      ),
    oldAppointmentRef: z
      .string()
      .trim()
      .min(1)
      .nullable()
      .describe(
        "Confirmed loaded appointment reference for a reschedule; otherwise null.",
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
  const get_availability = tool({
    name: "get_availability",
    description:
      "Search appointment slots after triage using caller-derived date and time branches, one per acceptable combination. " +
      "For a new visit, pass visitType; for a reschedule, identify the loaded appointment and leave visitType null. " +
      "Offer only returned slots; this tool does not book, so claim success only after book_appointment succeeds.",
    parameters: availabilityParameters,
    execute: async (args, { ctx, abortSignal }): Promise<string> => {
      ctx.disallowInterruptions();
      const office = "office" in args ? args.office : undefined;
      // Direct test invocations bypass LiveKit's strict schema validation.
      // Keep those existing seam tests usable without exposing `when` to the
      // model-visible contract.
      const legacyWhen = (args as unknown as { when?: unknown }).when;
      return returnSchedulingInputRequired(() =>
        workflow.getAvailability(
          getState(ctx),
          {
            branches: args.branches,
            ...(typeof legacyWhen === "string"
              ? { legacyWhenForDirectInvocation: legacyWhen }
              : {}),
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
      "Book a new appointment using a caller-confirmed slot from get_availability; use reschedule_appointment to move an existing appointment. " +
      "Call only after confirmation of the exact date, time, and provider and after collecting a referring doctor or none. " +
      "Claim booking success only from this tool's successful result; duplicate calls are rejected.",
    parameters: bookAppointmentParameters,
    execute: async (args, { ctx, toolCallId }): Promise<string> => {
      ctx.disallowInterruptions();
      const state = getState(ctx);
      return returnSchedulingInputRequired(() =>
        workflow.bookAppointment(
          state,
          {
            ...args,
            readBack: args.readBack ?? undefined,
          },
          toolCallId,
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
    parameters: cancelAppointmentParameters,
    execute: async (args, { ctx, toolCallId }): Promise<string> => {
      ctx.disallowInterruptions();
      const state = getState(ctx);
      return returnSchedulingInputRequired(() =>
        workflow.cancelAppointment(state, args, toolCallId),
      );
    },
  });

  const reschedule_appointment = tool({
    name: "reschedule_appointment",
    onDuplicate: "reject",
    description:
      "Move a verified patient's loaded appointment to a caller-confirmed slot from get_availability after collecting a referring doctor or none. " +
      "Require confirmation of the old appointment and a read-back of the new date, time, and provider; use only opaque call-scoped references. " +
      "This tool books first, then cancels the old appointment; report partial success if cancellation fails, and never retry the booking.",
    parameters: rescheduleAppointmentParameters,
    execute: async (args, { ctx, toolCallId }): Promise<string> => {
      ctx.disallowInterruptions();
      const state = getState(ctx);
      return returnSchedulingInputRequired(() =>
        workflow.rescheduleAppointment(
          state,
          {
            ...args,
            oldAppointmentRef: args.oldAppointmentRef ?? undefined,
            readBack: args.readBack ?? undefined,
          },
          toolCallId,
        ),
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
