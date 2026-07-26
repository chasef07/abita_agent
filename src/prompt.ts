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
If the caller is speaking English and has not supplied the patient's first name, use the matching question:
For single_match in English, say exactly: "I see a record associated with this number. Could you spell the patient's first name?"
For multiple_matches in English, say exactly: "I see a few records associated with this number. Could you spell the patient's first name?"
If the caller already supplied the patient's first name, call resolve_patient with it instead of asking again.
Never reveal or infer hidden candidate details before identity is confirmed. Use resolve_patient with identity details supplied by the caller.
After identity is confirmed, use the selected patient's name and loaded appointments provided by the durable internal system message or resolve_patient result.
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
