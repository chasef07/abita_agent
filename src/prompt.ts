// prompt.ts — Assembles system prompt from workspace files
// Order matters for LLM attention (U-shaped curve):
//   Top = identity (sets the frame)
//   Middle = reference data + speech style (retrieved on demand)
//   Bottom = tool logic + flows (highest attention, most critical per-turn)

import { readFileSync } from "fs";
import { join } from "path";
import type { PhoneLookupResult } from "./tools.js";
import { getOfficeConfigByPhone } from "./offices.js";

const WORKSPACE = join(import.meta.dirname, "..", "workspace");

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
    "- Routine eye exam, annual exam, vision check, glasses prescription — Crystal River is ophthalmology only",
    "",
    "Do not route just because those words are mentioned in a FAQ, confirmation, or other non-scheduling context.",
    "Use the routing tool, not the transfer tool. Routing keeps the caller on the line with you so you can continue scheduling them at Spring Hill after they agree. Transferring sends them to a human, which is the wrong outcome here.",
  ].join("\n");
}

const FILES: { file: string; tag: string }[] = [
  { file: "SOUL.md", tag: "role" },
  { file: "VOICE.md", tag: "voice" },
  { file: "RUNBOOK.md", tag: "runbook" },
];

/** Build the full system prompt with caller-specific data baked in. */
export function buildPrompt(
  phoneLookup?: PhoneLookupResult,
  trunkPhone?: string,
): string {
  const sections: string[] = [];
  if (!trunkPhone) {
    throw new Error("buildPrompt requires a trunk phone number");
  }

  for (const { file, tag } of FILES) {
    const content = readFileSync(join(WORKSPACE, file), "utf-8").trim();
    sections.push(`<${tag}>\n${content}\n</${tag}>`);
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

  return prompt;
}

/** Build the caller context block injected into the RUNBOOK. */
function buildCallerContext(lookup: PhoneLookupResult): string {
  if (lookup?.status === "verified") {
    const firstName =
      lookup.name.split(",")[1]?.trim() ?? lookup.name.split(" ")[0];
    const lines: string[] = [];
    lines.push(`**SINGLE MATCH — Session state is pre-loaded.**`);
    lines.push(`Name: ${lookup.name} (first name: ${firstName})`);
    lines.push(`DOB: ${lookup.dob}`);
    lines.push(`Insurance: ${lookup.insuranceCarrier}`);
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
          lines.push(
            `  - [ID: ${appt.id}] ${appt.date} at ${appt.time} with ${appt.provider} (${appt.type})`,
          );
        }
      } else {
        lines.push(`No upcoming appointments.`);
      }
      if (past.length > 0) {
        lines.push(`Past appointments (cannot be cancelled or modified):`);
        for (const appt of past) {
          lines.push(
            `  - ${appt.date} at ${appt.time} with ${appt.provider} (${appt.type})`,
          );
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

  const lines: string[] = [];
  lines.push(`**NO MATCH — This number is not in the system.**`);
  lines.push(
    `Ask "have you been seen here before?" early in the call. If no, go straight to new patient registration — no need to try verify_patient. If yes, collect their first name, last name, and date of birth and try verify_patient in case they're calling from a different phone. If not found, lead into registration.`,
  );
  return lines.join("\n");
}
