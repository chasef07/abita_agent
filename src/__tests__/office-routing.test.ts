import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildToolsForTrunk } from "../agent.js";
import { buildPrompt } from "../prompt.js";
import {
  DEV_OFFICE_PHONE,
  getOfficeConfig,
  getOfficeKeyByPhone,
  normalizePhoneNumber,
  SPRING_HILL_OFFICE_PHONE,
} from "../offices.js";
import {
  getAmdOfficeForToolCall,
  getBaseUrlForOfficePhone,
  getSpringHillOfficePhone,
  resolveKnowledgeFileForOffice,
} from "../tools.js";

describe("office routing helpers", () => {
  it("maps trunk numbers to office keys", () => {
    expect(getOfficeKeyByPhone("+13523202007")).toBe("crystal-river");
    expect(getOfficeKeyByPhone(SPRING_HILL_OFFICE_PHONE)).toBe("spring-hill");
    expect(getOfficeKeyByPhone(DEV_OFFICE_PHONE)).toBe("dev");
  });

  it("normalizes LiveKit phone attributes without a plus prefix", () => {
    expect(normalizePhoneNumber("14843989071")).toBe(DEV_OFFICE_PHONE);
    expect(getOfficeKeyByPhone("14843989071")).toBe("dev");
    expect(getBaseUrlForOfficePhone("14843989071")).toBe(
      "https://advancedmd-token-management-dev.up.railway.app",
    );
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

    expect(
      getAmdOfficeForToolCall({
        officeKey: "dev",
        amdOfficePhone: "",
      }),
    ).toBe(DEV_OFFICE_PHONE);
  });

  it("uses the dev middleware for the dev trunk", () => {
    expect(getBaseUrlForOfficePhone(DEV_OFFICE_PHONE)).toBe(
      "https://advancedmd-token-management-dev.up.railway.app",
    );
  });

  it("maps Crystal River trunks to the Eye Radiance knowledge file", () => {
    expect(resolveKnowledgeFileForOffice("crystal-river")).toBe(
      "KNOWLEDGE_EYERADIANCE.md",
    );
    expect(resolveKnowledgeFileForOffice("spring-hill")).toBe(
      "KNOWLEDGE_SPRINGHILL.md",
    );
    expect(resolveKnowledgeFileForOffice("dev")).toBe(
      "KNOWLEDGE_SPRINGHILL.md",
    );
  });

  it("uses the Eye Radiance human transfer number for Crystal River", () => {
    expect(getOfficeConfig("crystal-river").transferNumber).toBe("+19546097250");
    expect(getOfficeConfig("spring-hill").transferNumber).toBe("+18667968908");
  });

  it("only exposes Spring Hill routing on Crystal River calls", () => {
    expect(buildToolsForTrunk("+13523202007")).toHaveProperty(
      "route_to_spring_hill",
    );
    expect(buildToolsForTrunk(SPRING_HILL_OFFICE_PHONE)).not.toHaveProperty(
      "route_to_spring_hill",
    );
    expect(buildToolsForTrunk(DEV_OFFICE_PHONE)).not.toHaveProperty(
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
        "KNOWLEDGE_EYERADIANCE.md",
      ),
      "utf-8",
    );

    expect(prompt).not.toContain("route_to_spring_hill");
    expect(prompt).not.toContain("do not transfer just for that");
    expect(crystalRiverKnowledge).toContain(
      "does **not** see pediatric ophthalmology",
    );
    expect(crystalRiverKnowledge).toContain(
      "does **not** schedule cataract evaluations",
    );
  });

  it("tells new-patient flows to confirm the inbound caller number before recollecting digits", () => {
    const prompt = buildPrompt(undefined, SPRING_HILL_OFFICE_PHONE);

    expect(prompt).toContain(
      `is the number you're calling from a good one on file?`,
    );
  });

  it("allows registration to continue when a new patient has no email", () => {
    const prompt = buildPrompt(undefined, SPRING_HILL_OFFICE_PHONE);

    expect(prompt).toContain("Email is optional");
    expect(prompt).toContain("continue registration without it");
  });

  it("tells the agent to convert relative dates silently", () => {
    const prompt = buildPrompt(undefined, SPRING_HILL_OFFICE_PHONE);

    expect(prompt).toContain("Convert dates silently");
    expect(prompt).toContain("Do not explain the date math out loud");
    expect(prompt).not.toContain("Do the math");
  });

  it("prioritizes emergency and urgent eye symptoms before routine scheduling", () => {
    const prompt = buildPrompt(undefined, SPRING_HILL_OFFICE_PHONE);

    expect(prompt).toContain("Urgent / Emergency Calls");
    expect(prompt).toContain("retinal tear");
    expect(prompt).toContain("lightning bolts");
    expect(prompt).toContain("Do not finish normal registration");
  });
});
