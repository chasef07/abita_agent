// prompt.ts — Assembles system prompt from workspace files
// Order matters for LLM attention (U-shaped curve):
//   Top = identity (sets the frame)
//   Middle = reference data + speech style (retrieved on demand)
//   Bottom = tool logic + flows (highest attention, most critical per-turn)

import { readFileSync, existsSync } from "fs";
import { join } from "path";

const WORKSPACE = join(import.meta.dirname, "..", "workspace");

const FILES: { file: string; tag: string }[] = [
  { file: "SOUL.md", tag: "role" },
  { file: "VOICE.md", tag: "voice" },
  { file: "TOOLS.md", tag: "tools" },
];

export function buildPrompt(): string {
  const sections: string[] = [];

  for (const { file, tag } of FILES) {
    const path = join(WORKSPACE, file);
    if (existsSync(path)) {
      const content = readFileSync(path, "utf-8").trim();
      sections.push(`<${tag}>\n${content}\n</${tag}>`);
    }
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
