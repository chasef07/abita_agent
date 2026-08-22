import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  validateOfficeKnowledgeDocument,
  validateOfficeKnowledgeSources,
} from "../office-knowledge.js";

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
];

describe("Office Knowledge Context", () => {
  it("validates the same canonical document contract for every office", () => {
    const sources = validateOfficeKnowledgeSources(readKnowledgeSource);

    expect(sources).toHaveLength(8);
    expect(sources.every(({ sectionCount }) => sectionCount === 17)).toBe(true);
    for (const { source } of sources) {
      const content = readKnowledgeSource(source);
      expect(
        [...content.matchAll(/^## (.+)$/gm)].map((match) => match[1]),
      ).toEqual(CANONICAL_HEADINGS);
      expect(
        content.match(/^Status: (available|not-offered|not-supplied)$/gm),
      ).toHaveLength(CANONICAL_HEADINGS.length);
    }
  });

  it("rejects malformed section status and content structure", () => {
    const valid = readKnowledgeSource("KNOWLEDGE_SPRINGHILL.md");

    expect(() =>
      validateOfficeKnowledgeDocument(
        "misplaced.md",
        valid.replace(
          "## Payments\nStatus: available\n\n",
          "## Payments\nPayment details.\nStatus: available\n\n",
        ),
      ),
    ).toThrow(/Payments needs one status as its first line/);
    expect(() =>
      validateOfficeKnowledgeDocument(
        "duplicate.md",
        valid.replace(
          "## Payments\nStatus: available\n\n",
          "## Payments\nStatus: available\nStatus: not-supplied\n\n",
        ),
      ),
    ).toThrow(/Payments needs one status as its first line/);
    expect(() =>
      validateOfficeKnowledgeDocument(
        "empty.md",
        valid.replace(
          /## Payments\nStatus: available\n\n[\s\S]*?\n## Billing/,
          "## Payments\nStatus: available\n\n## Billing",
        ),
      ),
    ).toThrow(/Payments needs explanatory content/);
  });
});

function readKnowledgeSource(source: string): string {
  return readFileSync(
    join(import.meta.dirname, "..", "..", "workspace", source),
    "utf8",
  );
}
