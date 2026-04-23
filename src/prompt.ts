// prompt.ts — Assembles system prompt from workspace files
// Shared prompt helpers for the router and future task/task-group prompts.

import { readFileSync } from "fs";
import { join } from "path";
import type { PhoneLookupResult } from "./tools.js";
import {
  type OfficeKey,
  getOfficeConfig,
  getOfficeConfigByPhone,
} from "./offices.js";

const WORKSPACE = join(
  import.meta.dirname,
  "..",
  process.env.PROMPT_WORKSPACE || "workspace",
);

const BASE_FILES: { file: string; tag: string }[] = [
  { file: "SOUL.md", tag: "role" },
  { file: "VOICE.md", tag: "voice" },
];

const ROUTER_FILES: { file: string; tag: string }[] = [
  { file: "ROUTER.md", tag: "router" },
];

/** Office-specific routing hints injected into the per-call context block.
 *  Lives here (not RUNBOOK) so each office only sees rules that apply to it.
 */
function buildOfficeRoutingHints(trunkPhone: string): string {
  const office = getOfficeConfigByPhone(trunkPhone);
  return buildOfficeRoutingHintsForOfficeKey(office.key);
}

function buildOfficeRoutingHintsForOfficeKey(officeKey: OfficeKey): string {
  const office = getOfficeConfig(officeKey);
  if (office.key !== "crystal-river") return "";
  return [
    "**Crystal River routing rules.** If the caller is trying to schedule one of these visit types, explain that Spring Hill handles it, get their agreement, then route to Spring Hill:",
    "- A child, son, daughter, kid, or anyone implied to be under 18 — Crystal River does not see pediatric ophthalmology",
    "- Cataract evaluation, cataract surgery, cataract consult — handled at Spring Hill",
    "- Routine eye exam, annual exam, vision check, glasses prescription — Crystal River is ophthalmology only",
    "",
    "Do not route just because those words are mentioned in a FAQ, confirmation, or other non-scheduling context.",
    "Use the routing tool, not the transfer tool. Routing keeps the caller on the line with you so you can continue scheduling them at Spring Hill after they agree. Transferring sends them to a human, which is the wrong outcome here.",
  ].join("\n");
}

function buildTaskOfficeContext(args: {
  officeKey?: OfficeKey;
  effectiveOfficeKey?: OfficeKey;
}): string | null {
  if (!args.officeKey) return null;

  const inboundOffice = getOfficeConfig(args.officeKey);
  const effectiveOffice = getOfficeConfig(
    args.effectiveOfficeKey ?? args.officeKey,
  );
  const lines: string[] = [];

  if (effectiveOffice.key === inboundOffice.key) {
    lines.push(`Current office: ${effectiveOffice.displayName}.`);
  } else {
    lines.push(
      `Inbound office: ${inboundOffice.displayName}. Scheduling tools are already routed to ${effectiveOffice.displayName}.`,
    );
  }

  if (
    inboundOffice.features.routeToSpringHill &&
    effectiveOffice.key !== "spring-hill"
  ) {
    lines.push("");
    lines.push(buildOfficeRoutingHintsForOfficeKey(inboundOffice.key));
    lines.push(
      "If routing becomes necessary after the workflow has already started, use the routing tool before continuing with verification, registration, or availability.",
    );
  }

  return lines.join("\n");
}

function readPromptFile(file: string): string {
  return readFileSync(join(WORKSPACE, file), "utf-8").trim();
}

function buildPromptSections(files: { file: string; tag: string }[]): string {
  return files
    .map(({ file, tag }) => `<${tag}>\n${readPromptFile(file)}\n</${tag}>`)
    .join("\n\n");
}

export function buildBasePrompt(): string {
  return buildPromptSections(BASE_FILES);
}

export function buildRouterPrompt(
  phoneLookup?: PhoneLookupResult,
  trunkPhone?: string,
): string {
  if (!trunkPhone) {
    throw new Error("buildRouterPrompt requires a trunk phone number");
  }

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

  return [
    buildBasePrompt(),
    buildPromptSections(ROUTER_FILES),
    `<context>\nToday is ${date}. The current time is ${time}.\n\n${buildCallerContext(phoneLookup ?? null)}${officeBlock}\n</context>`,
  ].join("\n\n");
}

export function buildTaskPrompt(args: {
  mode:
    | "identify"
    | "register"
    | "schedule"
    | "reschedule"
    | "confirm"
    | "cancel";
  stateSummary: string;
  officeKey?: OfficeKey;
  effectiveOfficeKey?: OfficeKey;
}): string {
  const sectionByMode: Record<typeof args.mode, string> = {
    identify: "IDENTIFY_REGISTER.md",
    register: "IDENTIFY_REGISTER.md",
    schedule: "SCHEDULE_RESCHEDULE.md",
    reschedule: "SCHEDULE_RESCHEDULE.md",
    confirm: "APPOINTMENT_CHANGES.md",
    cancel: "APPOINTMENT_CHANGES.md",
  };

  const officeContext = buildTaskOfficeContext({
    officeKey: args.officeKey,
    effectiveOfficeKey: args.effectiveOfficeKey,
  });

  return [
    buildBasePrompt(),
    `<task_mode>\n${args.mode}\n</task_mode>`,
    `<task_instructions>\n${readPromptFile(sectionByMode[args.mode])}\n</task_instructions>`,
    ...(officeContext
      ? [`<office_context>\n${officeContext}\n</office_context>`]
      : []),
    `<working_state>\n${args.stateSummary}\n</working_state>`,
  ].join("\n\n");
}

/** Build the full system prompt with caller-specific data baked in. */
export function buildPrompt(
  phoneLookup?: PhoneLookupResult,
  trunkPhone?: string,
): string {
  return buildRouterPrompt(phoneLookup, trunkPhone);
}

/** Build the caller context block injected into the RUNBOOK. */
function buildCallerContext(lookup: PhoneLookupResult): string {
  if (lookup?.status === "verified") {
    const lines: string[] = [];
    lines.push(`**SINGLE MATCH — Session state is pre-loaded.**`);
    if (lookup.routingAmbiguous) {
      lines.push(`Routing is ambiguous — needs plan type clarification.`);
    }
    if (lookup.appointments && lookup.appointments.length > 0) {
      lines.push(`Upcoming appointments are on file in hidden state.`);
    } else {
      lines.push(`No appointments on file.`);
    }
    lines.push(``);
    lines.push(
      `Do NOT use or say the patient's name before they say it. Ask: "can I get your first name?" If it matches the likely patient already loaded in hidden state, treat that patient as the active one. If they give a different name (child, spouse), identify that person instead.`,
    );
    return lines.join("\n");
  }

  if (lookup?.status === "multiple_matches") {
    const lines: string[] = [];
    lines.push(
      `**MULTIPLE MATCHES (${lookup.matches.length} patients on this number).**`,
    );
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

  const lines: string[] = [];
  lines.push(`**NO MATCH — This number is not in the system.**`);
  lines.push(
    `Ask "have you been seen here before?" early in the call. If no, move into the identify or scheduling workflow so it can safely allow registration. If yes, collect their first name, last name, and date of birth and try verify_patient in case they're calling from a different phone. If not found, lead into registration from the identity flow.`,
  );
  return lines.join("\n");
}
