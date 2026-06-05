import { llm } from "@livekit/agents";
import { z } from "zod";
import { callApi } from "../clients/advancedmd-client.js";
import {
  activePatientDob,
  activeRoutingContext,
  applySchedulingLaneToState,
  type SchedulingAppointmentLane,
  type CallState,
} from "../state/call-state.js";
import { storeAvailabilitySlots } from "./availability-slots.js";
import {
  ensureRoutineVisionOffice,
  getAmdOfficeForToolCall,
  routingForAvailability,
} from "./scheduling.js";
import { getState } from "./session.js";
import { ensureAvailabilityContext } from "./turn-context-guard.js";

type AvailabilityLookupArgs = {
  date?: string;
  appointmentLane?: SchedulingAppointmentLane;
};

export const get_availability = llm.tool({
  description:
    "Search appointment availability from a start date. " +
    "For new appointments, pass appointmentLane after the visit reason is clear. Use medical_md for medical ophthalmology, or routine_od for routine vision, glasses, contacts, or optometry. " +
    "For reschedules, omit appointmentLane only when the existing appointment to move is already identified. " +
    "If the caller uses a relative date like today, tomorrow, next week, or Friday, call get_current_datetime before choosing the YYYY-MM-DD date.",
  parameters: z.object({
    date: z.string().trim().min(1).describe("Start date in YYYY-MM-DD format."),
    appointmentLane: z
      .enum(["medical_md", "routine_od"])
      .optional()
      .describe(
        "Required for new appointment searches. Use medical_md for medical ophthalmology, or routine_od for routine vision, glasses, contacts, or optometry. Omit only for reschedules when the loaded appointment supplies the lane.",
      ),
  }),
  execute: async ({ date, appointmentLane }, { ctx }) => {
    const state = getState(ctx);
    const request = buildAvailabilityLookupRequestForState(state, {
      date,
      appointmentLane,
    });
    const lookupNotice = ctx.session.say(availabilityLookupNotice());
    const result = await callApi(
      "/api/scheduler/availability",
      request.body,
      getAmdOfficeForToolCall(state),
    );
    await lookupNotice.waitForPlayout();
    return storeAvailabilitySlots(state, result, request.routing);
  },
});

function availabilityLookupNotice(): string {
  const notices = [
    "One moment while I check availability.",
    "Let me check what times are open.",
    "I'll look up available appointments now.",
    "Give me a second to check the schedule.",
  ];
  return notices[Math.floor(Math.random() * notices.length)] ?? notices[0];
}

function buildAvailabilityLookupRequestForState(
  state: CallState,
  args: AvailabilityLookupArgs,
) {
  const date = args.date?.trim();
  if (!date) {
    throw new llm.ToolError(
      "Ask what date or starting day the caller wants before checking availability.",
    );
  }

  if (args.appointmentLane) {
    applySchedulingLaneToState(state, args.appointmentLane);
  }
  ensureAvailabilityContext(state, "checking availability");
  ensureRoutineVisionOffice(state);
  const effectiveRouting = routingForAvailability(state);
  const body: Record<string, unknown> = { date };
  const dob = activePatientDob(state);
  if (dob) body.dob = dob;
  if (effectiveRouting) body.routing = effectiveRouting;
  if (activeRoutingContext(state).preauthRequired) body.preauthRequired = true;
  return { body, date, routing: effectiveRouting };
}
