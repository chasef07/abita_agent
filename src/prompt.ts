import {
  usesPortalKnowledge,
  PORTAL_KNOWLEDGE_INSTRUCTIONS,
} from "./runtime/portal-knowledge.js";
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

  if (usesPortalKnowledge(office.key)) {
    sections.push(PORTAL_KNOWLEDGE_INSTRUCTIONS);
  } else if (
    [
      "spring-hill",
      "crystal-river",
      "hollywood",
      "sweetwater",
      "north-miami-beach-optical",
    ].includes(office.key)
  ) {
    if (office.key !== "north-miami-beach-optical") {
      sections.push("We are closed on weekends.");
    }
    sections.push("We are closed on Labor Day, Monday, September 7, 2026.");
  }

  if (
    !usesPortalKnowledge(office.key) &&
    office.promptSources().some((source) => source.file === "SOUL.md")
  ) {
    sections.push(
      'If a caller asks whether ordered glasses are ready, say: "Check your texts. A readiness text confirms your glasses are ready for pickup. Please wait for that text before coming in."',
    );
  }

  return sections.join("\n\n");
}
