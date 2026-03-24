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
  { file: "TOOLS.md", tag: "tools" },
];

/** Build the base system prompt (no caller-specific data). */
export function buildPrompt(): string {
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

  return prompt;
}

/** Build caller context message from phone lookup result. Injected as a developer message into chatCtx. */
export function buildCallerContext(lookup: PhoneLookupResult): string {
  if (lookup?.status === "verified") {
    const lines: string[] = [];
    lines.push(`PHONE LOOKUP: Single patient match.`);
    lines.push(`Name: ${lookup.name}`);
    lines.push(`DOB: ${lookup.dob}`);
    lines.push(`Patient ID: ${lookup.patientId}`);
    lines.push(`Insurance: ${lookup.insuranceCarrier}`);
    lines.push(`Routing: ${lookup.routing}`);
    lines.push(`Allowed providers: ${lookup.allowedProviders.join(", ")}`);
    if (lookup.routingAmbiguous) {
      lines.push(`Routing is ambiguous — ask what type of plan they have.`);
    }
    if (lookup.appointments && lookup.appointments.length > 0) {
      lines.push(`Upcoming appointments:`);
      for (const appt of lookup.appointments) {
        lines.push(`  - ${appt.date} at ${appt.time} with ${appt.provider} (${appt.type})`);
      }
    }
    const firstName = lookup.name.split(",")[1]?.trim() ?? lookup.name.split(" ")[0];
    lines.push(``);
    lines.push(`After the caller states why they're calling, confirm their identity: "can I get your first name?" If they say "${firstName}" (or close), this is the patient — they are verified. Skip verify_patient entirely and go straight to what they need using the data above.`);
    lines.push(`If they give a different name, they may be calling for someone else (child, spouse). In that case, run the normal verify_patient flow for that person.`);
    return lines.join("\n");
  }

  if (lookup?.status === "multiple_matches") {
    const names = lookup.matches.map(m => m.firstName);
    const uniqueNames = [...new Set(names)];
    const lines: string[] = [];
    lines.push(`PHONE LOOKUP: Multiple patients on this number (${names.length} matches).`);
    lines.push(`Known first names: ${uniqueNames.join(", ")}.`);
    lines.push(`Do not read the names back — that's a HIPAA violation.`);
    lines.push(`Be natural about it: "I see a few patients associated with this number, can I get your first name and date of birth?"`);
    lines.push(`Once they answer, run verify_patient with their first name and DOB to pull up the right record. Say something like "one sec, let me pull you up" while it runs.`);
    lines.push(`If the name doesn't match anyone on file, they're likely a new patient — lead into the registration flow.`);
    return lines.join("\n");
  }

  // No match
  const lines: string[] = [];
  lines.push(`PHONE LOOKUP: No patient found for this number.`);
  lines.push(`This caller is likely a new patient. After they state their intent, try verify_patient first in case they're calling from a different phone. If verify comes back empty, lead straight into registration — "ok let me get you set up as a new patient."`);
  return lines.join("\n");
}
