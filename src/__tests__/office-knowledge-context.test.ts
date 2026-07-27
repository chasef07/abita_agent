import { describe, expect, it } from "vitest";
import {
  officeKnowledgeContext,
  validateOfficeKnowledgeDocument,
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
  it("returns the complete canonical document for the active office", () => {
    const context = officeKnowledgeContext("spring-hill");

    expect(context).toMatchObject({
      officeKey: "spring-hill",
      schemaVersion: "abita-office-knowledge/v1",
    });
    expect(context.documentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(
      [...context.content.matchAll(/^## (.+)$/gm)].map((match) => match[1]),
    ).toEqual(CANONICAL_HEADINGS);
    expect(
      context.content.match(/^Status: (available|not-offered|not-supplied)$/gm),
    ).toHaveLength(CANONICAL_HEADINGS.length);
  });

  it("validates the same canonical document contract for every office", () => {
    const officeKeys = [
      "crystal-river",
      "dev",
      "hollywood",
      "north-miami-beach-optical",
      "spring-hill",
      "sweetwater",
    ] as const;

    const contexts = officeKeys.map(officeKnowledgeContext);

    expect(contexts.map(({ officeKey }) => officeKey)).toEqual(officeKeys);
    expect(
      contexts.map(({ content }) =>
        [...content.matchAll(/^## (.+)$/gm)].map((match) => match[1]),
      ),
    ).toEqual(officeKeys.map(() => CANONICAL_HEADINGS));
  });

  it("rejects malformed section status and content structure", () => {
    const valid = officeKnowledgeContext("spring-hill").content;

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
