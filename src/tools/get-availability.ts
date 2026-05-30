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
    "Call after visit reason and scheduling lane are known; patient, routing, insurance, and preauth context come from session state. " +
    "Date must be YYYY-MM-DD. Returns speech-ready reply, next, and slots with slotId. " +
    "Use slotId for book_appt; never mention booking tokens or AMD appointment type IDs.",
  parameters: z.object({
    date: z.string().describe("Start date to search, formatted YYYY-MM-DD"),
  }),
  execute: async ({ date }, { ctx }) => {
    const state = getState(ctx);
    const request = buildAvailabilityLookupRequestForState(state, { date });
    if ("outcome" in request) return request;
    const result = await callApi(
      "/api/scheduler/availability",
      request.body,
      getAmdOfficeForToolCall(state),
    );
    return storeAvailabilitySlots(state, result, request.routing);
  },
});

function buildAvailabilityLookupRequestForState(
  state: CallState,
  args: AvailabilityLookupArgs,
) {
  const date = args.date?.trim();
  if (!date) {
    return {
      outcome: "needs_clarification",
      speak:
        "Ask what date or starting day the caller wants before checking availability.",
      facts: { reason: "availability_requires_date" },
      retryable: true,
    };
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
