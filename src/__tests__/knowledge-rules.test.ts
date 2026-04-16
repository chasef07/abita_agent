import { describe, expect, it } from "vitest";
import {
  loadKnowledgeReference,
  lookupKnowledge,
  lookupKnowledgeForOffice,
} from "../knowledge-rules.js";

describe("knowledge lookup", () => {
  it("returns the matching section for a topical question", () => {
    const reference = loadKnowledgeReference("KNOWLEDGE_OPTICAL_EYEWORKS.json");
    const result = lookupKnowledge(reference, "What frame brands do you carry?");

    expect(result.officeLabel).toBe("Optical Eyeworks");
    expect(result.matchedSectionTitles).toContain("Frame Selection");
    expect(result.sections[0]?.lines.join(" ")).toContain("Ray-Ban");
  });

  it("loads Beacon Optical topic sections and answers brand questions", () => {
    const reference = loadKnowledgeReference("KNOWLEDGE_BEACON_OPTICAL.json");
    const result = lookupKnowledge(
      reference,
      "What frame brands do you carry at Beacon?",
    );

    expect(result.officeLabel).toBe("Beacon Optical");
    expect(result.matchedSectionTitles).toContain("Frame Selection");
    expect(result.sections[0]?.lines.join(" ")).toContain("Gucci");
  });

  it("falls back to core sections when there is no alias match", () => {
    const result = lookupKnowledgeForOffice(
      "spring-hill",
      "Can you tell me about your office?",
    );

    expect(result.matchedSectionTitles).toContain("Location and Contact");
    expect(result.matchedSectionTitles).toContain("Hours");
  });

  it("returns Crystal River routing facts from the structured reference", () => {
    const result = lookupKnowledgeForOffice(
      "crystal-river",
      "Do you see kids for cataract consults?",
    );

    expect(result.matchedSectionTitles).toContain("Pediatric Visits");
    expect(result.matchedSectionTitles).toContain("Cataract Evaluations");
    expect(result.sections[0]?.lines.join(" ")).toContain(
      "does not see pediatric ophthalmology",
    );
  });

  it("matches pediatric topics without leaking photo ID content", () => {
    const springHill = lookupKnowledgeForOffice("spring-hill", "Do you see kids?");
    const crystalRiver = lookupKnowledgeForOffice(
      "crystal-river",
      "Can my daughter be seen there?",
    );

    expect(springHill.matchedSectionTitles).toContain(
      "Pediatric and Strabismus Visits",
    );
    expect(springHill.matchedSectionTitles).not.toContain("What to Bring");
    expect(crystalRiver.matchedSectionTitles).toContain("Pediatric Visits");
    expect(crystalRiver.matchedSectionTitles).not.toContain("What to Bring");
  });

  it("still answers actual photo ID questions with what-to-bring guidance", () => {
    const result = lookupKnowledgeForOffice(
      "crystal-river",
      "What ID should I bring?",
    );

    expect(result.matchedSectionTitles).toContain("What to Bring");
    expect(result.sections[0]?.lines.join(" ")).toContain("photo ID");
  });

  it("matches Beacon contact-lens onboarding questions to the contact workflow topic", () => {
    const reference = loadKnowledgeReference("KNOWLEDGE_BEACON_OPTICAL.json");
    const result = lookupKnowledge(
      reference,
      "I've never worn contacts before, when do I need to come in?",
    );

    expect(result.matchedSectionTitles).toContain("Contact Lens Workflow");
    expect(result.sections[0]?.lines.join(" ")).toContain(
      "scheduled before 4:00 PM",
    );
  });

  it("matches Beacon prescription-validity questions to the right topic", () => {
    const reference = loadKnowledgeReference("KNOWLEDGE_BEACON_OPTICAL.json");
    const result = lookupKnowledge(
      reference,
      "How long are prescriptions valid?",
    );

    expect(result.matchedSectionTitles).toContain("Prescription Validity");
    expect(result.matchedSectionTitles).not.toContain("Glasses Turnaround");
    expect(result.sections[0]?.lines.join(" ")).toContain(
      "valid for up to two years",
    );
  });
});
