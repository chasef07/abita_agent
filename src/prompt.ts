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
Use that status only after the caller asks for patient-specific help. It describes the lookup outcome while new-or-existing status remains unknown.
For single_match or multiple_matches, keep the number of lookup records private and use the same identity question.
When the patient's first name is still needed, ask the same privacy-safe question for either status.
In English, say exactly: "To help with the appointment, could you spell the patient's first name?"
In Spanish, say exactly: "Para ayudar con la cita, ¿podría deletrear el primer nombre del paciente?"
Before every reply, runtime tries to match any caller-provided first name to a preloaded patient.
If runtime provides confirmed-patient context, continue directly with that context. Reserve resolve_patient for an unconfirmed identity or a patient switch.
Keep hidden candidate details private until identity is confirmed.
When runtime leaves identity unconfirmed after the supplied first name, collect full identity and use resolve_patient as the last resort for existing-patient lookup.
Use resolve_patient to switch to a different patient when needed.
After identity is confirmed, use the selected patient's name, insurance carrier when loaded, and appointments from the current turn's internal system message or the latest resolve_patient result.
</caller_identity_policy>`;

const HUMAN_TRANSFER_POLICY = `<human_transfer_policy>
A human transfer starts only when transfer_call succeeds.
Use only a neutral hold phrase such as "One moment, please" before invoking transfer_call.
Afterward, describe the transfer only from the tool result.
</human_transfer_policy>`;

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
  sections.push(HUMAN_TRANSFER_POLICY);

  return sections.join("\n\n");
}
