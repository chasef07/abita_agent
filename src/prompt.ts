// prompt.ts — Assembles system prompt from workspace files
// Order matters for LLM attention (U-shaped curve):
//   Top = identity (sets the frame)
//   Middle = reference data + speech style (retrieved on demand)
//   Bottom = tool logic + flows (highest attention, most critical per-turn)

import { readFileSync } from "fs";
import { join } from "path";
import type { PhoneLookupResult } from "./tools.js";

const WORKSPACE = join(import.meta.dirname, "..", "workspace");

const FILES: { file: string; tag: string }[] = [
  { file: "SOUL.md", tag: "role" },
  { file: "VOICE.md", tag: "voice" },
  { file: "RUNBOOK.md", tag: "runbook" },
];

/** Build the full system prompt with caller-specific data baked in. */
export function buildPrompt(phoneLookup?: PhoneLookupResult): string {
  const sections: string[] = [];

  for (const { file, tag } of FILES) {
    const content = readFileSync(join(WORKSPACE, file), "utf-8").trim();
    sections.push(`<${tag}>\n${content}\n</${tag}>`);
  }

  let prompt = sections.join("\n\n");

  // Inject runtime variables (Eastern time — office timezone)
  const now = new Date();
  const tz = "America/New_York";
  prompt = prompt
    .replace(/\{\{current_date\}\}/g, now.toLocaleDateString("en-US", {
      timeZone: tz,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    }))
    .replace(/\{\{current_time\}\}/g, now.toLocaleTimeString("en-US", {
      timeZone: tz,
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }));

  // Inject caller context from phone lookup
  prompt = prompt.replace(/\{\{caller_context\}\}/g, buildCallerContext(phoneLookup ?? null));

  return prompt;
}

/** Build the caller context block injected into the RUNBOOK. */
function buildCallerContext(lookup: PhoneLookupResult): string {
  if (lookup?.status === "verified") {
    const firstName = lookup.name.split(",")[1]?.trim() ?? lookup.name.split(" ")[0];
    const lines: string[] = [];
    lines.push(`**SINGLE MATCH — Session state is pre-loaded.**`);
    lines.push(`Name: ${lookup.name} (first name: ${firstName})`);
    lines.push(`DOB: ${lookup.dob}`);
    lines.push(`Insurance: ${lookup.insuranceCarrier}`);
    if (lookup.routingAmbiguous) {
      lines.push(`Routing is ambiguous — needs plan type clarification.`);
    }
    if (lookup.appointments && lookup.appointments.length > 0) {
      lines.push(`Upcoming appointments:`);
      for (const appt of lookup.appointments) {
        lines.push(`  - ${appt.date} at ${appt.time} with ${appt.provider} (${appt.type})`);
      }
    } else {
      lines.push(`No upcoming appointments on file.`);
    }
    lines.push(``);
    lines.push(`Confirm their first name: "can I get your first name?" If they say "${firstName}" (or close), they are verified — skip verify_patient entirely and go straight to what they need. If they give a different name (child, spouse), run verify_patient for that person.`);
    return lines.join("\n");
  }

  if (lookup?.status === "multiple_matches") {
    const names = lookup.matches.map(m => m.firstName);
    const uniqueNames = [...new Set(names)];
    const lines: string[] = [];
    lines.push(`**MULTIPLE MATCHES (${names.length} patients on this number).**`);
    lines.push(`Known first names: ${uniqueNames.join(", ")}.`);
    lines.push(``);
    lines.push(`You MUST say: "I see a few patients associated with this number, can I get your first and last name and date of birth?"`);
    lines.push(`Do NOT ask generically as if you don't know anything about this caller. Do NOT skip asking for the last name — verify_patient requires firstName, lastName, and dob.`);
    lines.push(`Do NOT read back the names on file (HIPAA). Run verify_patient with their answer. If no match, lead into registration.`);
    return lines.join("\n");
  }

  const lines: string[] = [];
  lines.push(`**NO MATCH — This number is not in the system.**`);
  lines.push(`The caller is likely a new patient. Collect their first name, last name, and date of birth. Try verify_patient in case they're calling from a different phone. If not found, lead into registration.`);
  return lines.join("\n");
}
