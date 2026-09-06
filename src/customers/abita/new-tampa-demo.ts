import {
  completedBookingForPatient,
  completedRescheduleForPatient,
} from "../../state/appointments.js";
import { spokenSlot } from "../../scheduling/booking.js";
import { createSchedulingTools } from "../../scheduling/tools.js";
import type { SchedulingMiddleware } from "../../scheduling/middleware.js";
import type { SchedulingClock } from "../../scheduling/clock.js";
import { selectedAvailabilitySlot } from "../../scheduling/availability.js";
import { check_insurance } from "../../tools/check-insurance.js";
import { isToolset, tool, type ToolContextEntry } from "@livekit/agents";
import { z } from "zod";
import { activePatientId, type CallState } from "../../state/call-state.js";
import { clearAvailabilitySelection } from "../../scheduling/state.js";
import { getState } from "../../tools/session.js";
import {
  DEMO_TRANSFER_NUMBER,
  MENTAL_HEALTH_DEMO_TRUNK_PHONE,
  normalizePhoneNumber,
  type OfficeCare,
} from "./profile.js";

const PROVIDERS = {
  gretta: { name: "Doctor Gretta Fridman", aliases: ["gretta fridman"] },
  scott: { name: "Doctor Scott Friedman", aliases: ["scott friedman"] },
  small: { name: "Doctor Laurie Small", aliases: ["laurie small"] },
  khan: { name: "Doctor Hirah Khan", aliases: ["hirah khan"] },
  smur: {
    name: "Doctor Bradley Smur",
    aliases: ["bradley smur", "bradley smurr"],
  },
} as const;
type ProviderId = keyof typeof PROVIDERS;
type DemoTriage = {
  patientGeneration: number;
  visitType: OfficeCare;
  providers: ProviderId[];
  message: string;
};
// Demo-only state is scoped to the call without changing production CallState.
const triageByCall = new WeakMap<CallState, DemoTriage>();

const PROVIDERS_BY_PURPOSE = {
  routine_vision: ["smur"],
  cataract: ["gretta"],
  glaucoma: ["gretta", "khan"],
  retina: ["scott"],
  eyelid: ["small"],
} as const satisfies Record<string, readonly ProviderId[]>;

export function isNewTampaDemo(state: CallState): boolean {
  return (
    normalizePhoneNumber(state.runtime.trunkPhone) ===
    MENTAL_HEALTH_DEMO_TRUNK_PHONE
  );
}

function identifiesProvider(value: string, provider: ProviderId): boolean {
  const words = value
    .toLowerCase()
    .replace(/[^a-z]+/g, " ")
    .trim()
    .split(/\s+/);
  return PROVIDERS[provider].aliases.some((alias) =>
    alias.split(" ").every((word) => words.includes(word)),
  );
}

export const triage_eye_care = tool({
  name: "triage_eye_care",
  description:
    "New Tampa demo only. Route the caller's stated scheduling purpose and provider preference before availability, after resolving the patient. Do not diagnose. Re-run when patient, purpose, or preference changes. Urgent calls transfer without intake.",
  parameters: z
    .object({
      purpose: z.enum([
        "routine_vision",
        "cataract",
        "glaucoma",
        "retina",
        "eyelid",
        "unclear",
        "urgent",
      ]),
      requestedProvider: z
        .string()
        .trim()
        .min(1)
        .nullable()
        .describe(
          "Caller-requested provider, or null for no preference. Do not invent consent to a substitute.",
        ),
    })
    .strict(),
  execute: async ({ purpose, requestedProvider }, { ctx }): Promise<string> => {
    ctx.disallowInterruptions();
    const state = getState(ctx);
    if (!isNewTampaDemo(state))
      return "This tool is only available for the New Tampa demo.";
    clearAvailabilitySelection(state, {
      invalidateReads: "scheduling_context_changed",
    });
    const triage: DemoTriage = {
      patientGeneration: state.identity.transitionVersion,
      visitType:
        purpose === "routine_vision"
          ? ("routine_vision" as const)
          : ("medical" as const),
      providers: [],
      message: "",
    };
    triageByCall.set(state, triage);
    const blocked = (message: string) => {
      triage.message = message;
      return message;
    };
    if (purpose === "urgent")
      return blocked(
        "Stop scheduling. Call transfer_call now; do not delay for patient or insurance intake. For an explicitly after-hours scenario use notify_after_hours_physician, report the simulation honestly, then transfer. A true emergency requires 911 or the nearest emergency room without waiting for a callback.",
      );
    if (purpose === "unclear")
      return blocked(
        "Clarify whether this is a routine exam, cataract, glaucoma, retina, or eyelid visit. Do not diagnose symptoms; transfer to staff if clinical guidance is needed.",
      );
    if (!activePatientId(state))
      return blocked(
        "Resolve or create the patient, then call triage_eye_care again before scheduling.",
      );

    const eligible: readonly ProviderId[] = PROVIDERS_BY_PURPOSE[purpose];
    const requested = requestedProvider
      ? (Object.keys(PROVIDERS) as ProviderId[]).filter((id) =>
          identifiesProvider(requestedProvider, id),
        )
      : [];
    if (requestedProvider && requested.length !== 1) {
      return blocked(
        "Clarify the provider's full name. Doctor Gretta Fridman handles glaucoma and cataracts; Doctor Scott Friedman handles retina. For routine eye exams, offer Doctor Bradley Smur, our optometrist, and ask whether that works for the caller.",
      );
    }
    const preferred = requested[0];
    if (preferred && !eligible.includes(preferred)) {
      return blocked(
        purpose === "routine_vision"
          ? `I understand you'd like to see ${PROVIDERS[preferred].name}. For a routine eye exam, we have Doctor Bradley Smur, our optometrist. ${preferred === "scott" ? "Doctor Scott Friedman specializes in retina care. " : ""}Acknowledge prior visits only if the caller mentioned them. Ask whether Doctor Smur works for them; triage again with their agreed preference. If this is specialist follow-up, clarify the purpose. If they insist on the specialist, offer transfer_call.`
          : `The requested provider does not match this demo's ${purpose} service. Offer ${eligible.map((id) => PROVIDERS[id].name).join(" or ")} with caller agreement, clarify specialist-directed follow-up, or transfer to staff. Do not book a substitute without agreement.`,
      );
    }
    triage.providers = preferred ? [preferred] : [...eligible];
    return `Scheduling guidance: ${triage.providers.map((id) => PROVIDERS[id].name).join(" or ")}; visitType ${triage.visitType}. Check insurance for that coverage type, then list_available_appointments. Offer only matching returned providers; no matching slot means staff must help. This routing is demo service guidance, not clinical clearance.`;
  },
});

export function newTampaSchedulingBlock(
  state: CallState,
  visitType?: OfficeCare,
): string | null {
  if (!isNewTampaDemo(state)) return null;
  const triage = triageByCall.get(state);
  if (
    !triage ||
    triage.patientGeneration !== state.identity.transitionVersion
  ) {
    return "Call triage_eye_care for the current patient and their stated purpose before scheduling.";
  }
  if (!triage.providers.length) return triage.message;
  if (visitType && triage.visitType !== visitType)
    return "The visit type changed. Call triage_eye_care again for the current purpose before scheduling.";
  return null;
}

export function newTampaProviderAllowed(
  state: CallState,
  provider: string,
): boolean {
  if (!isNewTampaDemo(state)) return true;
  if (newTampaSchedulingBlock(state)) return false;
  return triageByCall
    .get(state)!
    .providers.some((id) => identifiesProvider(provider, id));
}

export const notify_after_hours_physician = tool({
  name: "notify_after_hours_physician",
  description:
    "New Tampa demo only: simulate an after-hours physician text for an explicitly after-hours urgent caller. No SMS is sent. Report the simulation honestly, then transfer to the demo team. Never delay emergency care for a notification.",
  parameters: z.object({ afterHoursUrgent: z.literal(true) }).strict(),
  execute: async (_, { ctx }): Promise<string> => {
    ctx.disallowInterruptions();
    const state = getState(ctx);
    if (!isNewTampaDemo(state))
      return "No physician notification was sent. This simulation is only available for the New Tampa demo.";
    clearAvailabilitySelection(state, {
      invalidateReads: "scheduling_context_changed",
    });
    triageByCall.set(state, {
      patientGeneration: state.identity.transitionVersion,
      providers: [],
      visitType: "medical",
      message:
        "After-hours urgent concern: stop scheduling and call transfer_call now. Do not wait for a physician callback.",
    });
    return `DEMO SIMULATION COMPLETE: a physician text alert was simulated. No real SMS was sent and no physician was contacted. Say: "For this demo, I've simulated a text alert to the after-hours physician." Call transfer_call now for the demo team. If the caller wants a number, offer ${DEMO_TRANSFER_NUMBER} explicitly as the demo callback line, not a real on-call physician number. For a true emergency, advise 911 or the nearest emergency room now; do not wait for a callback.`;
  },
});

/** Only the 320 registry branch installs these tools. Shared tools are unchanged. */
export function createNewTampaDemoTools(
  middleware: SchedulingMiddleware,
  clock?: SchedulingClock,
) {
  const base = createSchedulingTools(middleware, clock);
  const outsideDemo = "This tool is only available for the New Tampa demo.";
  const list_available_appointments = tool({
    ...base.list_available_appointments,
    execute: async (args, options): Promise<string> => {
      options.ctx.disallowInterruptions();
      const state = getState(options.ctx);
      if (!isNewTampaDemo(state)) return outsideDemo;
      const blocked = newTampaSchedulingBlock(state, args.visitType);
      if (blocked) return blocked;
      const triage = triageByCall.get(state);
      const scoped = createSchedulingTools(
        {
          getAvailability: async (input) => {
            const result = await middleware.getAvailability(input);
            if (result.status !== "found" && result.status !== "none")
              return result;
            const slots = result.slots.filter((slot) =>
              newTampaProviderAllowed(state, slot.provider),
            );
            return {
              ...result,
              status: slots.length ? ("found" as const) : ("none" as const),
              slots,
            };
          },
          bookAppointment: (input) => middleware.bookAppointment(input),
          cancelAppointment: (input) => middleware.cancelAppointment(input),
        },
        clock,
      );
      const response = await scoped.list_available_appointments.execute(
        args,
        options,
      );
      if (
        triageByCall.get(state) === triage &&
        !newTampaSchedulingBlock(state) &&
        response.startsWith("I couldn't find any openings")
      ) {
        return "No matching New Tampa provider opening is confirmed in this demo search. Offer transfer_call so staff can help. If the caller needs urgent attention, transfer immediately; do not ask them to wait or keep expanding the calendar.";
      }
      return response;
    },
  });
  const bookingBlock = (state: CallState, ref: string): string | null => {
    if (!isNewTampaDemo(state)) return outsideDemo;
    const blocked = newTampaSchedulingBlock(state);
    if (blocked) return blocked;
    const slot = selectedAvailabilitySlot(state, ref);
    if (!slot) return null; // The existing tool owns invalid/expired references.
    return (
      newTampaSchedulingBlock(
        state,
        slot.routing === "optical_only" ? "routine_vision" : "medical",
      ) ??
      (newTampaProviderAllowed(state, slot.provider)
        ? null
        : "This provider does not match the current New Tampa triage. Check appropriate availability or transfer to staff.")
    );
  };
  const book_appointment = tool({
    ...base.book_appointment,
    execute: async (args, options): Promise<string> => {
      options.ctx.disallowInterruptions();
      const state = getState(options.ctx);
      if (!isNewTampaDemo(state)) return outsideDemo;
      const patientId = activePatientId(state);
      // Replays report authoritative completed work without starting a new mutation.
      if (patientId && completedBookingForPatient(state, patientId)) {
        return base.book_appointment.execute(args, options);
      }
      return (
        bookingBlock(state, args.appointmentSlotRef) ??
        base.book_appointment.execute(args, options)
      );
    },
  });
  const reschedule_appointment = tool({
    ...base.reschedule_appointment,
    execute: async (args, options): Promise<string> => {
      options.ctx.disallowInterruptions();
      const state = getState(options.ctx);
      if (!isNewTampaDemo(state)) return outsideDemo;
      const patientId = activePatientId(state);
      const completed = patientId
        ? completedRescheduleForPatient(state, patientId)
        : null;
      const ref = args.oldAppointmentRef.trim();
      const cached = selectedAvailabilitySlot(state, args.appointmentSlotRef);
      // Match the shared workflow's replay eligibility; a different move still needs triage.
      if (
        ref &&
        completed &&
        (completed.status === "needs_human_cancellation" ||
          completed.originalAppointmentRef === ref ||
          completed.replacementAppointmentRef === ref) &&
        (completed.status === "needs_human_cancellation" ||
          !cached ||
          completed.appointmentDescription === spokenSlot(cached))
      ) {
        return base.reschedule_appointment.execute(args, options);
      }
      return (
        bookingBlock(state, args.appointmentSlotRef) ??
        base.reschedule_appointment.execute(args, options)
      );
    },
  });
  const demoInsurance = tool({
    ...check_insurance,
    execute: async (args, options): Promise<string> => {
      options.ctx.disallowInterruptions();
      if (!isNewTampaDemo(getState(options.ctx))) return outsideDemo;
      const response = await check_insurance.execute(args, options);
      return `For this demo only: ${response} Actual New Tampa insurance participation and requirements are unverified.`;
    },
  });
  return {
    ...base,
    list_available_appointments,
    book_appointment,
    reschedule_appointment,
    check_insurance: demoInsurance,
    triage_eye_care,
    notify_after_hours_physician,
  };
}

export function withNewTampaDemoTools(
  entries: readonly ToolContextEntry<CallState>[],
  middleware: SchedulingMiddleware,
): readonly ToolContextEntry<CallState>[] {
  const replacements = createNewTampaDemoTools(middleware);
  const byName = new Map<string, ToolContextEntry<CallState>>(
    Object.values(replacements).map((entry) => [entry.id, entry]),
  );
  return [
    ...entries.map((entry) =>
      isToolset(entry) ? entry : (byName.get(entry.id) ?? entry),
    ),
    triage_eye_care,
    notify_after_hours_physician,
  ];
}
