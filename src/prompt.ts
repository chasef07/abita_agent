// prompt.ts — Assembles system prompt from workspace files
// Order matters for LLM attention (U-shaped curve):
//   Top = identity (sets the frame)
//   Middle = reference data + speech style (retrieved on demand)
//   Bottom = tool logic + flows (highest attention, most critical per-turn)

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type { PhoneLookupResult } from "./tools.js";

const WORKSPACE = join(import.meta.dirname, "..", "workspace");

const FILES: { file: string; tag: string }[] = [
  { file: "SOUL.md", tag: "role" },
  { file: "VOICE.md", tag: "voice" },
  { file: "TOOLS.md", tag: "tools" },
];

export function buildPrompt(lookup?: PhoneLookupResult): string {
  const sections: string[] = [];

  for (const { file, tag } of FILES) {
    const path = join(WORKSPACE, file);
    if (existsSync(path)) {
      const content = readFileSync(path, "utf-8").trim();
      sections.push(`<${tag}>\n${content}\n</${tag}>`);
    }
  }

  // Inject caller context from pre-call phone lookup
  if (lookup?.status === "verified") {
    const lines: string[] = [];
    lines.push(`The caller's phone number matched a patient in the system.`);
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
    lines.push(``);
    lines.push(`This might be the patient, or they might be calling for someone else (child, spouse, etc). Don't assume — confirm who the appointment is for. If it's for themselves, skip verify_patient entirely — you already have their patient ID, name, DOB, routing, and insurance. Go straight to what they need.`);
    sections.push(`<caller_context>\n${lines.join("\n")}\n</caller_context>`);
  } else if (lookup?.status === "multiple_matches") {
    const names = lookup.matches.map(m => m.firstName).join(", ");
    const lines: string[] = [];
    lines.push(`The caller's phone number matched multiple patients on this number.`);
    lines.push(`Do not read the names back — that's a HIPAA violation. Just ask for their first name, then match it against: ${names}.`);
    sections.push(`<caller_context>\n${lines.join("\n")}\n</caller_context>`);
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
