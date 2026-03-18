// prompt.ts — Assembles system prompt from workspace files
// Loads SOUL.md, TOOLS.md, VOICE.md, KNOWLEDGE.md and injects runtime variables.

import { readFileSync, existsSync } from "fs";
import { join } from "path";

const WORKSPACE = join(import.meta.dirname, "..", "workspace");

const FILES = ["SOUL.md", "TOOLS.md", "VOICE.md", "KNOWLEDGE.md"];

export function buildPrompt(): string {
  const sections: string[] = [];

  for (const file of FILES) {
    const path = join(WORKSPACE, file);
    if (existsSync(path)) {
      sections.push(readFileSync(path, "utf-8").trim());
    }
  }

  let prompt = sections.join("\n\n---\n\n");

  // Inject runtime variables
  const now = new Date();
  prompt = prompt
    .replace(/\{\{current_date\}\}/g, now.toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    }))
    .replace(/\{\{current_time\}\}/g, now.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }));

  return prompt;
}
