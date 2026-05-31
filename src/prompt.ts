// prompt.ts — Assembles system prompt from workspace files
// Order matters for LLM attention (U-shaped curve):
//   Top = identity (sets the frame)
//   Middle = reference data + speech style (retrieved on demand)

import { readFileSync } from "fs";
import { join } from "path";
import type { PhoneLookupResult } from "./state/call-state.js";

const WORKSPACE = join(
  import.meta.dirname,
  "..",
  process.env.PROMPT_WORKSPACE || "workspace",
);

const BASE_FILES: { file: string; tag: string }[] = [
  { file: "SOUL.md", tag: "role" },
  { file: "VOICE.md", tag: "voice" },
];

/** Build the static system prompt. Pre-call facts stay in backend state. */
export function buildPrompt(
  _phoneLookup?: PhoneLookupResult,
  trunkPhone?: string,
): string {
  const sections: string[] = [];
  if (!trunkPhone) {
    throw new Error("buildPrompt requires a trunk phone number");
  }

  for (const { file, tag } of BASE_FILES) {
    const content = readFileSync(join(WORKSPACE, file), "utf-8").trim();
    sections.push(`<${tag}>\n${content}\n</${tag}>`);
  }

  return sections.join("\n\n");
}
