import { llm } from "@livekit/agents";
import { z } from "zod";
import { callApi } from "../clients/advancedmd-client.js";
import {
  activeInsuranceContext,
  activePatientDob,
  activeRoutingContext,
  type CallState,
} from "../state/call-state.js";
import { storeAvailabilitySlots } from "./availability-slots.js";
import {
  ensureRoutineVisionOffice,
  getAmdOfficeForToolCall,
  routingForAvailability,
} from "./scheduling.js";
import { getState } from "./session.js";

type AvailabilityLookupArgs = {
  date?: string;
};

export const get_availability = llm.tool({
  description:
    "Search appointment availability from a start date. " +
    "Call after visit reason and scheduling lane are known. " +
    "If the caller uses a relative date like today, tomorrow, next week, or Friday, call get_current_datetime before choosing the YYYY-MM-DD date.",
  parameters: z.object({
    date: z.string().trim().min(1).describe("Start date in YYYY-MM-DD format."),
  }),
  execute: async ({ date }, { ctx }) => {
    const state = getState(ctx);
    const request = buildAvailabilityLookupRequestForState(state, { date });
    void ctx.session.say(availabilityLookupNotice());
    const result = await callApi(
      "/api/scheduler/availability",
      request.body,
      getAmdOfficeForToolCall(state),
    );
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

  ensureAvailabilityVisitContext(state);
  ensureRoutineVisionOffice(state);
  const effectiveRouting = routingForAvailability(state);
  const body: Record<string, unknown> = { date };
  const dob = activePatientDob(state);
  if (dob) body.dob = dob;
  if (effectiveRouting) body.routing = effectiveRouting;
  if (activeRoutingContext(state).preauthRequired) body.preauthRequired = true;
  return { body, date, routing: effectiveRouting };
}

function ensureAvailabilityVisitContext(state: CallState): void {
  if (state.scheduling.visitType) return;

  const knownCoverageType =
    state.scheduling.coverageType ?? activeInsuranceContext(state).coverageType;

  const visitType =
    knownCoverageType === "routine_vision" ||
    activeRoutingContext(state).routing === "optical_only"
      ? "routine_vision"
      : "medical";

  state.scheduling.visitType = visitType;
}
