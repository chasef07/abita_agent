// prompt.ts — Assembles system prompt from workspace files
// Order matters for LLM attention (U-shaped curve):
//   Top = identity (sets the frame)
//   Middle = reference data + speech style (retrieved on demand)

import { readFileSync } from "fs";
import { join } from "path";
import { getOfficeConfigByPhone } from "./customers/profile.js";
import type { PhoneLookupResult } from "./state/call-state.js";

const WORKSPACE = join(
  import.meta.dirname,
  "..",
  process.env.PROMPT_WORKSPACE || "workspace",
);

const SPRING_HILL_POLICY = {
  file: "SPRING_HILL_STAFF_TASKS.md",
  tag: "office_policy",
};

/** Build the static system prompt. Pre-call facts stay in backend state. */
export function buildPrompt(
  phoneLookup?: PhoneLookupResult,
  trunkPhone?: string,
): string {
  const sections: string[] = [];
  if (!trunkPhone) {
    throw new Error("buildPrompt requires a trunk phone number");
  }

  const office = getOfficeConfigByPhone(trunkPhone);
  const promptFiles = [
    { file: office.roleFile ?? "SOUL.md", tag: "role" },
    { file: "VOICE.md", tag: "voice" },
  ];

  for (const { file, tag } of promptFiles) {
    const content = readFileSync(join(WORKSPACE, file), "utf-8").trim();
    sections.push(`<${tag}>\n${content}\n</${tag}>`);
  }

  if (office.key === "spring-hill") {
    const { file, tag } = SPRING_HILL_POLICY;
    const content = readFileSync(join(WORKSPACE, file), "utf-8").trim();
    sections.push(`<${tag}>\n${content}\n</${tag}>`);
  }

  const identityHint = callerIdentityHint(phoneLookup);
  if (identityHint) {
    sections.push(
      `<caller_identity_hint>\n${identityHint}\n</caller_identity_hint>`,
    );
  }

  return sections.join("\n\n");
}

function callerIdentityHint(phoneLookup?: PhoneLookupResult): string | null {
  if (!phoneLookup) return null;

  switch (phoneLookup.status) {
    case "verified":
      return "Caller identity hint: one likely patient record was found from this phone number.";
    case "multiple_matches":
      return "Caller identity hint: multiple possible patient records were found from this phone number.";
    case "no_match":
      return "Caller identity hint: no matching patient record was found from this phone number.";
    case "lookup_failed":
      return "Caller identity hint: phone lookup failed before the call.";
  }
}
