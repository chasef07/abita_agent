import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildToolsForTrunk } from "../agent.js";
import { loadKnowledgeReference } from "../knowledge-rules.js";
import { buildPrompt } from "../prompt.js";
import {
  BEACON_OPTICAL_OFFICE_PHONE,
  getOfficeKeyByPhone,
  OPTICAL_EYEWORKS_OFFICE_PHONE,
  SPRING_HILL_OFFICE_PHONE,
} from "../offices.js";
import {
  getAmdOfficeForToolCall,
  getSpringHillOfficePhone,
  resolveKnowledgeFileForOffice,
} from "../tools.js";

describe("office routing helpers", () => {
  it("maps trunk numbers to office keys", () => {
    expect(getOfficeKeyByPhone("+13523202007")).toBe("crystal-river");
    expect(getOfficeKeyByPhone(BEACON_OPTICAL_OFFICE_PHONE)).toBe(
      "beacon-optical",
    );
    expect(getOfficeKeyByPhone(OPTICAL_EYEWORKS_OFFICE_PHONE)).toBe(
      "optical-eyeworks",
    );
    expect(getOfficeKeyByPhone(SPRING_HILL_OFFICE_PHONE)).toBe("spring-hill");
  });

  it("rejects unsupported trunk numbers", () => {
    expect(() => getOfficeKeyByPhone("+19999999999")).toThrow(
      "Unsupported trunk phone number",
    );
    expect(() => buildToolsForTrunk("+19999999999")).toThrow(
      "Unsupported trunk phone number",
    );
  });

  it("uses the hardcoded Spring Hill AMD office phone", () => {
    expect(getSpringHillOfficePhone()).toBe(SPRING_HILL_OFFICE_PHONE);
  });

  it("uses the AMD office override when present", () => {
    expect(
      getAmdOfficeForToolCall({
        officeKey: "crystal-river",
        amdOfficePhone: SPRING_HILL_OFFICE_PHONE,
      }),
    ).toBe(SPRING_HILL_OFFICE_PHONE);

    expect(
      getAmdOfficeForToolCall({
        officeKey: "crystal-river",
        amdOfficePhone: "",
      }),
    ).toBe("+13523202007");
  });

  it("maps Crystal River trunks to the Eye Radiance knowledge file", () => {
    expect(resolveKnowledgeFileForOffice("crystal-river")).toBe(
      "KNOWLEDGE_EYERADIANCE.json",
    );
    expect(resolveKnowledgeFileForOffice("optical-eyeworks")).toBe(
      "KNOWLEDGE_OPTICAL_EYEWORKS.json",
    );
    expect(resolveKnowledgeFileForOffice("beacon-optical")).toBe(
      "KNOWLEDGE_BEACON_OPTICAL.json",
    );
    expect(resolveKnowledgeFileForOffice("spring-hill")).toBe(
      "KNOWLEDGE_SPRINGHILL.json",
    );
  });

  it("only exposes Spring Hill routing on Crystal River calls", () => {
    expect(buildToolsForTrunk("+13523202007")).toHaveProperty(
      "route_to_spring_hill",
    );
    expect(
      buildToolsForTrunk(OPTICAL_EYEWORKS_OFFICE_PHONE),
    ).not.toHaveProperty("route_to_spring_hill");
    expect(
      buildToolsForTrunk(BEACON_OPTICAL_OFFICE_PHONE),
    ).not.toHaveProperty("route_to_spring_hill");
    expect(buildToolsForTrunk(SPRING_HILL_OFFICE_PHONE)).not.toHaveProperty(
      "route_to_spring_hill",
    );
  });
});

describe("Crystal River prompt guidance", () => {
  it("keeps office-specific facts in the Crystal River knowledge file, not a special prompt block", () => {
    const prompt = buildPrompt(undefined, "+13523202007");
    const crystalRiverKnowledge = readFileSync(
      join(
        import.meta.dirname,
        "..",
        "..",
        "workspace",
        "KNOWLEDGE_EYERADIANCE.json",
      ),
      "utf-8",
    );

    expect(prompt).not.toContain("route_to_spring_hill");
    expect(prompt).not.toContain("do not transfer just for that");
    expect(crystalRiverKnowledge).toContain(
      "does not see pediatric ophthalmology",
    );
    expect(crystalRiverKnowledge).toContain(
      "does not schedule cataract evaluations",
    );
  });

  it("tells new-patient flows to confirm the inbound caller number before recollecting digits", () => {
    const prompt = buildPrompt(undefined, SPRING_HILL_OFFICE_PHONE);

    expect(prompt).toContain(
      `is the number you're calling from a good one on file?`,
    );
  });

  it("stores the Optical Eyeworks knowledge base as structured JSON", () => {
    const knowledge = loadKnowledgeReference("KNOWLEDGE_OPTICAL_EYEWORKS.json");

    expect(knowledge.officeLabel).toBe("Optical Eyeworks");
    expect(knowledge.sections.some((section) => section.key === "frames")).toBe(
      true,
    );
    expect(
      knowledge.sections.some((section) =>
        section.lines.some((line) => line.includes("patients as young as 7")),
      ),
    ).toBe(true);
  });

  it("stores the Beacon Optical knowledge base as structured JSON", () => {
    const knowledge = loadKnowledgeReference("KNOWLEDGE_BEACON_OPTICAL.json");

    expect(knowledge.officeLabel).toBe("Beacon Optical");
    expect(
      knowledge.sections.some((section) => section.key === "frames"),
    ).toBe(true);
    expect(
      knowledge.sections.some((section) =>
        section.lines.some((line) => line.includes("patients as young as 7")),
      ),
    ).toBe(true);
  });
});
