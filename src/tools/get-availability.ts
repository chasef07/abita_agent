import { llm, voice } from "@livekit/agents";
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
import { storeAvailabilitySlots } from "./availability-slots.js";
import {
  ensureRoutineVisionOffice,
  getAmdOfficeForToolCall,
  routingForAvailability,
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
};

type AvailabilityLookupBlockedResponse = {
  result: "missing_patient" | "missing_availability_context";
  reply: string;
  next:
    | "resolve_or_create_patient"
    | "pass_appointment_lane"
    | "confirm_loaded_appointment_or_pass_lane"
    | "resolve_patient_or_pass_lane";
  slots: [];
};

type GeneratedSpeechHandle = ReturnType<
  voice.RunContext["session"]["generateReply"]
>;

const AVAILABILITY_STATUS_DELAY_MS = 500;
const AVAILABILITY_STATUS_INSTRUCTIONS =
  "Briefly tell the caller that you're checking appointment availability now. " +
  "Use the same language the caller is using. Do not mention tools or systems.";

const isoDateSchema = z
  .string()
  .trim()
  .regex(
    /^\d{4}-\d{2}-\d{2}$/,
    "Use an exact date in YYYY-MM-DD format. Call get_current_datetime first for relative dates.",
  );

export const get_availability = llm.tool({
  description:
    "Search appointment availability from a start date. " +
    "For new appointments, pass appointmentLane after the visit reason is clear. Use medical_md for symptom-driven eye care, medical ophthalmology, or any eye problem or concern. Use routine_od only for glasses, contacts, prescription updates, contact lens fittings, or routine eye exams with no active eye problem. " +
    "For reschedules, omit appointmentLane only when the existing appointment to move is already identified. " +
    "Do not call for same-day or past dates; ask for tomorrow or a later date. " +
    "For explicit calendar dates like June 16, June 16 2026, or 2026-06-16, choose the exact YYYY-MM-DD date and call this tool directly. " +
    "If the caller uses a relative date like today, tomorrow, next week, or Friday, call get_current_datetime before choosing the YYYY-MM-DD date. Do not pass relative phrases like next Wednesday here.",
  parameters: z.object({
    date: isoDateSchema.describe("Start date in YYYY-MM-DD format."),
    appointmentLane: z
      .enum(["medical_md", "routine_od"])
      .optional()
      .describe(
        "Required for new appointment searches. Use medical_md for symptom-driven eye care or any eye problem; use routine_od only for glasses, contacts, prescription updates, contact lens fittings, or routine eye exams with no active eye problem. Omit only for reschedules when the loaded appointment supplies the lane.",
      ),
  }),
  execute: async ({ date, appointmentLane }, { ctx }) => {
    const state = getState(ctx);
    const request = buildAvailabilityLookupRequestForState(state, {
      date,
      appointmentLane,
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

    const statusUpdate = startAvailabilityStatusUpdate(ctx);
    let result: unknown;
    try {
      result = await callApi(
        "/api/scheduler/availability",
        request.body,
        officePhone,
      );
    } finally {
      statusUpdate.cancel();
    }
    const response = storeAvailabilitySlots(state, result, request.routing);
    if (isCacheableAvailabilityResponse(response)) {
      setAvailabilitySearchResult(state, request.signature, response);
    }
    return response;
  },
});

function startAvailabilityStatusUpdate(ctx: voice.RunContext): {
  cancel: () => void;
} {
  let cancelled = false;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let statusHandle: GeneratedSpeechHandle | null = null;

  timeout = setTimeout(() => {
    timeout = null;
    void (async () => {
      try {
        await ctx.waitForPlayout();
        if (cancelled) return;
        statusHandle = ctx.session.generateReply({
          instructions: AVAILABILITY_STATUS_INSTRUCTIONS,
          allowInterruptions: true,
          toolChoice: "none",
        });
        await statusHandle.waitForPlayout();
      } catch (err) {
        if (!cancelled) {
          console.warn("[tools] Availability status update failed:", err);
        }
      }
    })();
  }, AVAILABILITY_STATUS_DELAY_MS);

  return {
    cancel: () => {
      cancelled = true;
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      if (statusHandle && !statusHandle.interrupted && !statusHandle.done()) {
        statusHandle.interrupt();
      }
    },
  };
}

function isCacheableAvailabilityResponse(response: unknown): boolean {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    return false;
  }
  const record = response as Record<string, unknown>;
  return (
    (record.result === "slots_found" && record.next === "offer_slot") ||
    (record.result === "no_slots_found" &&
      record.next === "ask_next_search_or_new_preference")
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
    }
  | { blocked: AvailabilityLookupBlockedResponse } {
  const date = args.date?.trim();
  if (!date) {
    throw new llm.ToolError(
      "Ask what date or starting day the caller wants before checking availability.",
    );
  }
  if (!activePatientId(state)) {
    return {
      blocked: {
        result: "missing_patient",
        reply: "Verify or create the patient before checking availability.",
        next: "resolve_or_create_patient",
        slots: [],
      },
    };
  }

  prepareAvailabilityLookupContext(state, args.appointmentLane);
  const contextRecovery = availabilityContextRecovery(state);
  if (contextRecovery) {
    return { blocked: contextRecovery };
  }
  ensureAvailabilityContext(state, "checking availability");
  ensureRoutineVisionOffice(state);
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
      patientId: activePatientId(state),
      routing: effectiveRouting,
    }),
  };
}

function availabilitySearchSignature(
  state: CallState,
  input: {
    body: Record<string, unknown>;
    date: string;
    patientId: string | null;
    routing: string | null;
  },
): string {
  const turn = state.workflow.current;
  return JSON.stringify({
    patientId: input.patientId,
    office: getAmdOfficeForToolCall(state),
    intent: turn?.intent ?? null,
    appointmentLane: turn?.appointmentLane ?? null,
    date: input.date,
    dob: typeof input.body.dob === "string" ? input.body.dob : null,
    routing: input.routing,
    preauthRequired: input.body.preauthRequired === true,
  });
}

function invalidAvailabilityDateResponse(requestedDate: string): {
  result: "invalid_date";
  reply: string;
  next: "ask_future_date";
  earliestDate: string;
  slots: [];
} | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) return null;
  const today = clinicTodayIso();
  if (requestedDate > today) return null;

  return {
    result: "invalid_date",
    reply:
      "Same-day and past-date appointments are not available. Ask for tomorrow or a later date.",
    next: "ask_future_date",
    earliestDate: nextIsoDate(today),
    slots: [],
  };
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
