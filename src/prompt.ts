// prompt.ts — Assembles system prompt from workspace files
// Order matters for LLM attention (U-shaped curve):
//   Top = identity (sets the frame)
//   Middle = turn-local reference data + speech style

import { readFileSync } from "fs";
import { join } from "path";
import { getOfficeProfileByPhone } from "./customers/abita/profile.js";

const WORKSPACE = join(
  import.meta.dirname,
  "..",
  process.env.PROMPT_WORKSPACE || "workspace",
);

const CALLER_IDENTITY_POLICY = `<caller_identity_policy>
The initial system chat context contains exactly one pre-call phone lookup status: single_match, multiple_matches, no_match, or lookup_failed.
Use that status only after the caller asks for patient-specific help. It describes the lookup outcome, not whether the caller is a new or existing patient.
For single_match or multiple_matches, do not reveal whether the phone lookup found one record or several.
If the caller has not supplied the patient's first name, ask the same privacy-safe question for either status.
In English, say exactly: "To help with the appointment, could you spell the patient's first name?"
In Spanish, say exactly: "Para ayudar con la cita, ¿podría deletrear el primer nombre del paciente?"
Before every reply, runtime tries to match any caller-provided first name to a preloaded patient.
If runtime provides confirmed-patient context, use it and do not call resolve_patient.
Never reveal or infer hidden candidate details before identity is confirmed.
If runtime cannot confirm from the supplied first name, collect full identity and use resolve_patient as the last resort for existing-patient lookup.
Use resolve_patient to switch to a different patient when needed.
After identity is confirmed, use the selected patient's name, insurance carrier when loaded, and appointments from the current turn's internal system message or the latest resolve_patient result.
</caller_identity_policy>`;

/** Build the static system prompt. Per-call facts stay out of instructions. */
export function buildPrompt(trunkPhone: string): string {
  const sections: string[] = [];
  if (!trunkPhone) {
    throw new Error("buildPrompt requires a trunk phone number");
  }

  const office = getOfficeProfileByPhone(trunkPhone);

  for (const { file, tag } of office.promptSources()) {
    const content = readFileSync(join(WORKSPACE, file), "utf-8").trim();
    sections.push(`<${tag}>\n${content}\n</${tag}>`);
  }

  sections.push(CALLER_IDENTITY_POLICY);

  return sections.join("\n\n");
}
