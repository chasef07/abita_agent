// prompt.ts — Assembles system prompt from workspace files
// Order matters for LLM attention (U-shaped curve):
//   Top = identity (sets the frame)
//   Middle = reference data + speech style (retrieved on demand)
//   Bottom = tool logic + flows (highest attention, most critical per-turn)

import { readFileSync } from "fs";
import { join } from "path";
import type { PhoneLookupResult } from "./tooling/call-state.js";
import {
  getOfficeConfigByPhone,
  isFlowHarnessEnabledForTrunk,
} from "./customer/profile.js";

const WORKSPACE = join(
  import.meta.dirname,
  "..",
  process.env.PROMPT_WORKSPACE || "workspace",
);

/** Office-specific routing hints injected into the per-call context block.
 *  Lives here (not RUNBOOK) so each office only sees rules that apply to it.
 */
function buildOfficeRoutingHints(trunkPhone: string): string {
  const office = getOfficeConfigByPhone(trunkPhone);
  if (office.key !== "crystal-river") return "";
  return [
    "**Crystal River routing rules.** If the caller is trying to schedule one of these visit types, explain that Spring Hill handles it, get their agreement, then route to Spring Hill:",
    "- A child, son, daughter, kid, or anyone implied to be under 18 — Crystal River does not see pediatric ophthalmology",
    "- Cataract evaluation, cataract surgery, cataract consult — handled at Spring Hill",
    "- Routine eye exam, annual exam, vision check, glasses prescription, contact lens prescription — use the Spring Hill routine-vision lane",
    "",
    "Do not route just because those words are mentioned in a FAQ, confirmation, or other non-scheduling context.",
    "Use the routing tool, not the transfer tool. Routing keeps the caller on the line with you so you can continue scheduling them at Spring Hill after they agree. Transferring sends them to a human, which is the wrong outcome here.",
    "For routine vision, ask whether this is a routine eye exam or glasses/contact lens prescription using accepted vision coverage or self-pay, run check_insurance with coverageType routine_vision, then schedule with routing optical_only.",
  ].join("\n");
}

function normalizeMeridiemSpacing(text: string): string {
  return text.replace(
    /\b(\d{1,2})(?::(\d{2}))?\s*([AaPp])\.?\s*([Mm])\.?\b/g,
    (_match, hour: string, minute: string | undefined, period: string) =>
      `${hour}${minute ? `:${minute}` : ""} ${period.toUpperCase()}M`,
  );
}

function formatAppointmentContextLine(
  appointment: NonNullable<
    Extract<PhoneLookupResult, { status: "verified" }>["appointments"]
  >[number],
  includeId: boolean,
): string {
  const idPrefix = includeId ? `[ID: ${appointment.id}] ` : "";
  const facility = appointment.facility?.trim()
    ? ` at ${appointment.facility.trim()}`
    : "";
  return `  - ${idPrefix}${appointment.date} at ${normalizeMeridiemSpacing(appointment.time)} with ${appointment.provider} (${appointment.type})${facility}`;
}

const BASE_FILES: { file: string; tag: string }[] = [
  { file: "SOUL.md", tag: "role" },
  { file: "VOICE.md", tag: "voice" },
];

const LEGACY_FILES: { file: string; tag: string }[] = [
  { file: "RUNBOOK.md", tag: "runbook" },
];

const FLOW_HARNESS_FILE = {
  file: "FLOW_HARNESS_RUNBOOK.md",
  tag: "flow_harness_runbook",
};

/** Build the full system prompt with caller-specific data baked in. */
export function buildPrompt(
  phoneLookup?: PhoneLookupResult,
  trunkPhone?: string,
): string {
  const sections: string[] = [];
  if (!trunkPhone) {
    throw new Error("buildPrompt requires a trunk phone number");
  }
  const flowHarnessEnabled = isFlowHarnessEnabledForTrunk(trunkPhone);

  for (const { file, tag } of BASE_FILES) {
    const content = readFileSync(join(WORKSPACE, file), "utf-8").trim();
    sections.push(`<${tag}>\n${content}\n</${tag}>`);
  }
  if (flowHarnessEnabled) {
    sections.push(buildHarnessOperatingContract());
    const content = readFileSync(
      join(WORKSPACE, FLOW_HARNESS_FILE.file),
      "utf-8",
    ).trim();
    sections.push(
      `<${FLOW_HARNESS_FILE.tag}>\n${content}\n</${FLOW_HARNESS_FILE.tag}>`,
    );
  } else {
    for (const { file, tag } of LEGACY_FILES) {
      const content = readFileSync(join(WORKSPACE, file), "utf-8").trim();
      sections.push(`<${tag}>\n${content}\n</${tag}>`);
    }
  }

  let prompt = sections.join("\n\n");

  // Append dynamic context at the end so the static prefix is cacheable
  const now = new Date();
  const tz = "America/New_York";
  const date = now.toLocaleDateString("en-US", {
    timeZone: tz,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const time = now.toLocaleTimeString("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  const officeHints = buildOfficeRoutingHints(trunkPhone);
  const officeBlock = officeHints ? `\n\n${officeHints}` : "";

  prompt += `\n\n<context>\nToday is ${date}. The current time is ${time}.\n\n${buildCallerContext(phoneLookup ?? null)}${officeBlock}\n</context>`;
  if (flowHarnessEnabled) {
    prompt += `\n\n<state_memory_contract>\nThe reducer records obvious caller intent before each model turn and injects a compact turn_state. Treat suggestedTool as guidance, not as the safety boundary. Concrete tool state is authoritative: if the required patient, availability, appointment, and confirmation facts are already present, call the workflow tool directly. Side effects still require explicit caller confirmation and a successful tool result before you say they are done.\n</state_memory_contract>`;
  }

  return prompt;
}

function buildHarnessOperatingContract(): string {
  return [
    "<harness_operating_contract>",
    "The TypeScript flow harness owns workflow state, task phase, missing facts, and side-effect safety. Use the latest <turn_state> and <context_capsules> injected after each caller turn as guidance over any general habit or example.",
    "The reducer records obvious caller intent before planning. Use the compact task state as guidance: phase, known facts, missing facts, next, suggestedTool, and blockedSideEffects. Treat suggestedTool as the recommended frontier, not as a hard allow-list.",
    "Use tool descriptions for exact schemas. You may call a workflow tool whenever concrete state has the required patient, availability, appointment, and confirmation facts. Read-only tools can run when their prerequisites are met; side-effect tools require explicit caller confirmation and policy approval.",
    "Keep spoken responses to 1-3 concise sentences and ask one question at a time.",
    "</harness_operating_contract>",
  ].join("\n");
}

/** Build the caller context block injected into the prompt. */
function buildCallerContext(lookup: PhoneLookupResult): string {
  if (lookup?.status === "verified") {
    const firstName =
      lookup.name.split(",")[1]?.trim() ?? lookup.name.split(" ")[0];
    const lines: string[] = [];
    lines.push(`**SINGLE MATCH — Session state is pre-loaded.**`);
    lines.push(`Name: ${lookup.name} (first name: ${firstName})`);
    lines.push(`DOB: ${lookup.dob}`);
    if (lookup.insuranceCarrier) {
      lines.push(`Insurance: ${lookup.insuranceCarrier}`);
    } else {
      lines.push(`Insurance: not on file.`);
    }
    if (lookup.routingAmbiguous) {
      lines.push(`Routing is ambiguous — needs plan type clarification.`);
    }
    if (lookup.appointments && lookup.appointments.length > 0) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const upcoming: typeof lookup.appointments = [];
      const past: typeof lookup.appointments = [];
      for (const appt of lookup.appointments) {
        const apptDate = new Date(appt.date);
        if (!isNaN(apptDate.getTime()) && apptDate >= today) {
          upcoming.push(appt);
        } else {
          past.push(appt);
        }
      }
      if (upcoming.length > 0) {
        lines.push(`Upcoming appointments:`);
        for (const appt of upcoming) {
          lines.push(formatAppointmentContextLine(appt, true));
        }
      } else {
        lines.push(`No upcoming appointments.`);
      }
      if (past.length > 0) {
        lines.push(`Past appointments (cannot be cancelled or modified):`);
        for (const appt of past) {
          lines.push(formatAppointmentContextLine(appt, false));
        }
      }
    } else {
      lines.push(`No appointments on file.`);
    }
    lines.push(``);
    lines.push(
      `Do NOT use or say the patient's name before they say it. Ask: "can I get your first name?" If they say "${firstName}" (or close), they are verified — skip verify_patient entirely and go straight to what they need. If they give a different name (child, spouse), run verify_patient for that person.`,
    );
    return lines.join("\n");
  }

  if (lookup?.status === "multiple_matches") {
    const names = lookup.matches.map((m) => m.firstName);
    const uniqueNames = [...new Set(names)];
    const lines: string[] = [];
    lines.push(
      `**MULTIPLE MATCHES (${names.length} patients on this number).**`,
    );
    lines.push(`Known first names: ${uniqueNames.join(", ")}.`);
    lines.push(``);
    lines.push(
      `You MUST say: "I see a few patients associated with this number, can I get the patient's first name?"`,
    );
    lines.push(
      `Do NOT ask for last name or DOB upfront — just the first name is enough. Run verify_patient with firstName and usePhone: true. The phone is injected automatically from the session.`,
    );
    lines.push(
      `Do NOT read back the names on file (HIPAA). If no match, ask for last name and DOB and try again.`,
    );
    return lines.join("\n");
  }

  if (lookup?.status === "lookup_failed") {
    return buildLookupFailedContext(lookup);
  }

  const lines: string[] = [];
  lines.push(`**NO MATCH — This number is not in the system.**`);
  lines.push(
    `Ask "have you been seen here before?" early in the call. If no, go straight to new patient registration — no need to try verify_patient. If yes, collect their first name, last name, and date of birth and try verify_patient in case they're calling from a different phone. If not found, lead into registration.`,
  );
  return lines.join("\n");
}

function buildLookupFailedContext(
  lookup: Extract<PhoneLookupResult, { status: "lookup_failed" }>,
): string {
  return [
    `**PHONE LOOKUP UNAVAILABLE — Identity is not preloaded.**`,
    `The pre-call lookup failed before the session started. Do not tell the caller technical details and do not say they are new just because lookup failed.`,
    `Ask what they need first. If they are an existing patient, collect first name, last name, and DOB, then use verify_patient. If they say they are new, continue into registration after visit-type and insurance triage.`,
    `Lookup failure reason for internal routing only: ${lookup.reason}.`,
  ].join("\n");
}
