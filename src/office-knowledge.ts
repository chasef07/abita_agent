import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getOfficeProfile, type OfficeKey } from "./customers/abita/profile.js";

const WORKSPACE = join(import.meta.dirname, "..", "workspace");
export const OFFICE_KNOWLEDGE_SCHEMA_VERSION =
  "abita-office-knowledge/v1" as const;
export type OfficeKnowledgeSchemaVersion =
  typeof OFFICE_KNOWLEDGE_SCHEMA_VERSION;
const CANONICAL_HEADINGS = [
  "Emergency and Urgency",
  "Location and Contact",
  "Hours",
  "After Hours",
  "Scope of Services",
  "Providers",
  "Optical and Glasses",
  "Contact Lenses",
  "Repairs and Warranty",
  "Insurance and Referrals",
  "Payments",
  "Billing",
  "Self-Pay Pricing",
  "What to Bring",
  "Appointment Expectations",
  "Social Follow-Up",
  "Limitations",
] as const;
const officeKnowledgeContextCache = new Map<
  OfficeKey,
  OfficeKnowledgeContext
>();

export type OfficeKnowledgeContext = {
  content: string;
  documentHash: string;
  officeKey: OfficeKey;
  schemaVersion: OfficeKnowledgeSchemaVersion;
};

export function officeKnowledgeContext(
  officeKey: OfficeKey,
): OfficeKnowledgeContext {
  const cached = officeKnowledgeContextCache.get(officeKey);
  if (cached) return cached;

  const profile = getOfficeProfile(officeKey);
  const content = readFileSync(
    join(WORKSPACE, profile.knowledgeSource),
    "utf-8",
  ).trim();
  validateOfficeKnowledgeDocument(profile.knowledgeSource, content);

  const context = {
    content,
    documentHash: createHash("sha256").update(content).digest("hex"),
    officeKey,
    schemaVersion: OFFICE_KNOWLEDGE_SCHEMA_VERSION,
  } satisfies OfficeKnowledgeContext;
  officeKnowledgeContextCache.set(officeKey, context);
  return context;
}

export function validateOfficeKnowledgeDocument(
  source: string,
  content: string,
): void {
  const lines = content.split(/\r?\n/);
  if (!lines[0]?.startsWith("# Office Knowledge: ")) {
    throw new Error(
      `Invalid Office Knowledge document ${source}: expected title`,
    );
  }
  if (lines[1] !== `Schema: ${OFFICE_KNOWLEDGE_SCHEMA_VERSION}`) {
    throw new Error(
      `Invalid Office Knowledge document ${source}: expected schema ${OFFICE_KNOWLEDGE_SCHEMA_VERSION}`,
    );
  }

  const matches = [...content.matchAll(/^## (.+)$/gm)];
  const headings = matches.map((match) => match[1]);
  if (
    headings.length !== CANONICAL_HEADINGS.length ||
    headings.some((heading, index) => heading !== CANONICAL_HEADINGS[index])
  ) {
    throw new Error(
      `Invalid Office Knowledge document ${source}: expected canonical headings in canonical order`,
    );
  }

  matches.forEach((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? content.length;
    const section = content.slice(start, end).trim();
    const sectionLines = section
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const statusLines = sectionLines.filter((line) =>
      line.startsWith("Status:"),
    );
    if (
      statusLines.length !== 1 ||
      sectionLines[0] !== statusLines[0] ||
      !/^Status: (available|not-offered|not-supplied)$/.test(statusLines[0]!)
    ) {
      throw new Error(
        `Invalid Office Knowledge document ${source}: ${match[1]} needs one status as its first line`,
      );
    }
    if (sectionLines.length === 1) {
      throw new Error(
        `Invalid Office Knowledge document ${source}: ${match[1]} needs explanatory content`,
      );
    }
  });
}
