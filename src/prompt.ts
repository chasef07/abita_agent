// Assemble static system instructions. Turn-local facts enter ChatContext later.

import { readFileSync } from "fs";
import { join } from "path";
import { getOfficeProfileByPhone } from "./customers/abita/profile.js";

const WORKSPACE = join(
  import.meta.dirname,
  "..",
  process.env.PROMPT_WORKSPACE || "workspace",
);

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

  return sections.join("\n\n");
}
