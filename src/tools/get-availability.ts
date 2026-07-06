import { ToolError, tool } from "@livekit/agents";
import { z } from "zod";
import { callApi } from "../clients/advancedmd-client.js";
import {
  activePatientDob,
  activePatientId,
  activeRoutingContext,
  cachedAvailabilitySearchResult,
  clearAvailabilitySelection,
  setAvailabilitySearchResult,
  type CallState,
  type SchedulingAppointmentLane,
} from "../state/call-state.js";
import {
  storeAvailabilitySlots,
  type AvailabilityTimePreference,
} from "./availability-slots.js";
import {
  getAmdOfficeForToolCall,
  medicalSchedulingUnavailable,
  routingForAvailability,
  routineVisionSchedulingUnavailable,
} from "./scheduling.js";
import { getState } from "./session.js";
import {
  availabilityContextRecovery,
  ensureAvailabilityContext,
  prepareAvailabilityLookupContext,
} from "./turn-context-guard.js";

type AvailabilityLookupArgs = {
  date?: string;
  appointmentLane?: SchedulingAppointmentLane;
  timePreference?: AvailabilityTimePreference;
};

const AVAILABILITY_UPDATE = "Checking appointment availability now.";
const AVAILABILITY_FILLER_DELAY_MS = 5_000;
const AVAILABILITY_FILLER_INTERVAL_MS = 8_000;
const AVAILABILITY_FILLER_MAX_STEPS = 2;

const isoDateSchema = z
  .string()
  .trim()
  .regex(
    /^\d{4}-\d{2}-\d{2}$/,
    "Use an exact date in YYYY-MM-DD format. Call get_current_datetime first for relative dates.",
  );

export const get_availability = tool({
  name: "get_availability",
  description:
    "Search appointment availability from an exact YYYY-MM-DD start date. " +
    "For new appointments, pass appointmentLane after the visit reason is clear; for reschedules, omit it only when the existing appointment to move is already identified. " +
    "Use timePreference to rank morning, afternoon, or no-preference requests. " +
    "Do not call for same-day or past dates. Call get_current_datetime before using relative dates, and do not pass relative phrases here. " +
    "This tool returns plain instructions with at most two appointmentSlotRef values; offer only those returned slots and do not invent other times.",
  parameters: z.object({
    date: isoDateSchema.describe("Start date in YYYY-MM-DD format."),
    appointmentLane: z
      .enum(["medical_md", "routine_od"])
      .optional()
      .describe(
        "Required for new appointment searches. Use medical_md for medical or eye-problem visits, routine_od for routine vision. Omit only for reschedules when the loaded appointment supplies the lane.",
      ),
    timePreference: z
      .enum(["morning", "afternoon", "none"])
      .optional()
      .describe(
        "Caller time-of-day preference for ranking returned slots. Use morning for AM or before-noon requests, afternoon for PM or afternoon requests, and none when the caller has no time preference.",
      ),
  }),
  execute: async (
    { date, appointmentLane, timePreference },
    { ctx, abortSignal },
  ) => {
    const state = getState(ctx);
    const request = buildAvailabilityLookupRequestForState(state, {
      date,
      appointmentLane,
      timePreference,
    });
    if ("blocked" in request) return request.blocked;

    const invalidDateResponse = invalidAvailabilityDateResponse(request.date);
    if (invalidDateResponse) {
      clearAvailabilitySelection(state);
      return invalidDateResponse;
    }

    const officePhone = getAmdOfficeForToolCall(state);
    const cachedResponse = cachedAvailabilitySearchResult(
      state,
      request.signature,
    );
    if (cachedResponse) return cachedResponse;

    await ctx.update(AVAILABILITY_UPDATE);
    const result = await ctx.filler(
      () => availabilityFiller(state),
      {
        delay: AVAILABILITY_FILLER_DELAY_MS,
        interval: AVAILABILITY_FILLER_INTERVAL_MS,
        maxSteps: AVAILABILITY_FILLER_MAX_STEPS,
        signal: abortSignal,
      },
      () =>
        callApi("/api/scheduler/availability", request.body, officePhone, {
          signal: abortSignal,
        }),
    );
    if (!availabilityRequestStillCurrent(state, request)) {
      return "Availability search was superseded because the patient or appointment context changed. Check availability again with the current details.";
    }
    const response = storeAvailabilitySlots(
      state,
      result,
      request.routing,
      request.timePreference,
    );
    if (response.cacheable) {
      setAvailabilitySearchResult(state, request.signature, response.message);
    }
    return response.message;
  },
});

function availabilityFiller(state: CallState): string {
  if (state.runtime.voiceLanguage?.current === "es") {
    return "Sigo buscando disponibilidad.";
  }
  return "Still checking appointment availability.";
}

function availabilityRequestStillCurrent(
  state: CallState,
  request: {
    body: Record<string, unknown>;
    date: string;
    routing: string | null;
    signature: string;
    timePreference: AvailabilityTimePreference;
  },
): boolean {
  return (
    availabilitySearchSignature(state, {
      body: request.body,
      date: request.date,
      patientId: activePatientId(state),
      routing: request.routing,
      timePreference: request.timePreference,
    }) === request.signature
  );
}

function buildAvailabilityLookupRequestForState(
  state: CallState,
  args: AvailabilityLookupArgs,
):
  | {
      body: Record<string, unknown>;
      date: string;
      routing: string | null;
      signature: string;
      timePreference: AvailabilityTimePreference;
    }
  | { blocked: string } {
  const date = args.date?.trim();
  const timePreference = args.timePreference ?? "none";
  if (!date) {
    throw new ToolError(
      "Ask what date or starting day the caller wants before checking availability.",
    );
  }
  const patientId = activePatientId(state);
  if (!patientId) {
    return {
      blocked: "Verify or create the patient before checking availability.",
    };
  }

  prepareAvailabilityLookupContext(state, args.appointmentLane);
  const contextRecovery = availabilityContextRecovery(state);
  if (contextRecovery) {
    return { blocked: contextRecovery };
  }
  ensureAvailabilityContext(state, "checking availability");
  const unsupportedMedicalScheduling = medicalSchedulingUnavailable(state);
  if (unsupportedMedicalScheduling)
    return { blocked: unsupportedMedicalScheduling };
  const unsupportedRoutineVisionScheduling =
    routineVisionSchedulingUnavailable(state);
  if (unsupportedRoutineVisionScheduling)
    return { blocked: unsupportedRoutineVisionScheduling };
  const effectiveRouting = routingForAvailability(state);
  const body: Record<string, unknown> = { date };
  const dob = activePatientDob(state);
  if (dob) body.dob = dob;
  if (effectiveRouting) body.routing = effectiveRouting;
  if (activeRoutingContext(state).preauthRequired) body.preauthRequired = true;
  return {
    body,
    date,
    routing: effectiveRouting,
    signature: availabilitySearchSignature(state, {
      body,
      date,
      patientId,
      routing: effectiveRouting,
      timePreference,
    }),
    timePreference,
  };
}

function availabilitySearchSignature(
  state: CallState,
  input: {
    body: Record<string, unknown>;
    date: string;
    patientId: string | null;
    routing: string | null;
    timePreference: AvailabilityTimePreference;
  },
): string {
  const turn = state.workflow.current;
  return JSON.stringify({
    patientId: input.patientId,
    office: getAmdOfficeForToolCall(state),
    intent: turn?.intent ?? null,
    appointmentLane: turn?.appointmentLane ?? null,
    date: input.date,
    timePreference: input.timePreference,
    dob: typeof input.body.dob === "string" ? input.body.dob : null,
    routing: input.routing,
    preauthRequired: input.body.preauthRequired === true,
  });
}

function invalidAvailabilityDateResponse(requestedDate: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) return null;
  const today = clinicTodayIso();
  if (requestedDate > today) return null;

  return `Same-day and past-date appointments are not available. Ask for tomorrow or a later date; the earliest date to check is ${nextIsoDate(today)}.`;
}

function clinicTodayIso(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function nextIsoDate(date: string): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + 1);
  return parsed.toISOString().slice(0, 10);
}
