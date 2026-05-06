import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildToolsForTrunk } from "../agent.js";
import { buildPrompt } from "../prompt.js";
import {
  DEV_OFFICE_PHONE,
  getOfficeConfig,
  getOfficeConfigByPhone,
  getOfficeKeyByPhone,
  normalizePhoneNumber,
  SPRING_HILL_813_TRUNK_PHONE,
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
    expect(getOfficeKeyByPhone(SPRING_HILL_813_TRUNK_PHONE)).toBe(
      "spring-hill",
    );
    expect(getOfficeKeyByPhone(DEV_OFFICE_PHONE)).toBe("dev");
  });

  it("routes the Spring Hill 813 trunk through the canonical AMD office phone", () => {
    const office = getOfficeConfigByPhone(SPRING_HILL_813_TRUNK_PHONE);

    expect(office.key).toBe("spring-hill");
    expect(office.amdOfficePhone).toBe(SPRING_HILL_OFFICE_PHONE);
    expect(buildToolsForTrunk(SPRING_HILL_813_TRUNK_PHONE)).not.toHaveProperty(
      "route_to_spring_hill",
    );
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

  it("uses office-specific human transfer numbers for live offices", () => {
    expect(getOfficeConfig("crystal-river").transferNumber).toBe(
      "+13527941244",
    );
    expect(getOfficeConfig("spring-hill").transferNumber).toBe("+16182265883");
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
    expect(crystalRiverKnowledge).toContain(
      "routine eye exams/glasses/contact lens prescriptions",
    );
  });

  it("teaches Spring Hill routine vision without the old optometry denial", () => {
    const prompt = buildPrompt(undefined, SPRING_HILL_OFFICE_PHONE);
    const springHillKnowledge = readFileSync(
      join(
        import.meta.dirname,
        "..",
        "..",
        "workspace",
        "KNOWLEDGE_SPRINGHILL.md",
      ),
      "utf-8",
    );

    expect(prompt).toContain("an eye care practice");
    expect(prompt).toContain("Visit Type Triage");
    expect(prompt).toContain(
      "Before choosing a path, checking insurance, or searching availability",
    );
    expect(prompt).toContain(
      `If the caller starts with a bare insurance question like "do you take Care Plus?"`,
    );
    expect(prompt).toContain(
      "Medical and routine vision insurance lookups can have different answers for the same plan name",
    );
    expect(prompt).toContain(
      "Reason for visit — classify medical/surgical vs routine vision",
    );
    expect(prompt).toContain(
      'triage first: "is this for a routine eye exam or glasses/contact lens prescription, or for a medical eye visit?"',
    );
    expect(prompt).toContain("Spring Hill routine-vision lane");
    expect(prompt).toContain("routing `optical_only`");
    expect(prompt).not.toContain("1010");
    expect(prompt).not.toContain("3364");
    expect(prompt).not.toContain("4244");
    expect(prompt).not.toContain("4245");
    expect(prompt).not.toContain("6167");
    expect(prompt).not.toContain("6169");
    expect(prompt).not.toContain("6168");
    expect(springHillKnowledge).toContain("routine-vision scheduling lane");
    expect(springHillKnowledge).toContain("Routine optometry is age 10+");
    expect(springHillKnowledge).toContain("Retina care is available");
    expect(springHillKnowledge).toContain("YSL, Ferragamo, Gucci");
    expect(springHillKnowledge).toContain("Sherry is the licensed optician");
    expect(springHillKnowledge).toContain("10 business days");
    expect(springHillKnowledge).toContain("1930 Land O Lakes Boulevard");
    expect(prompt).not.toContain("do **not** perform routine eye exams");
    expect(springHillKnowledge).not.toContain(
      "do **not** perform routine eye exams",
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

  it("keeps appointment times TTS-safe with spaced AM and PM", () => {
    const prompt = buildPrompt(
      {
        status: "verified",
        patientId: "patient-1",
        name: "Santos, Maria",
        dob: "01/01/1980",
        phone: "+17275551212",
        insuranceCarrier: "Aetna",
        insPlanId: "plan-1",
        respPartyId: "resp-1",
        routing: "all_three",
        allowedProviders: [],
        routingAmbiguous: false,
        appointments: [
          {
            id: 123,
            date: "2099-01-01",
            time: "9:30AM",
            provider: "Dr. Noel",
            type: "Follow-up",
            facility: "Spring Hill",
            confirmed: true,
          },
          {
            id: 124,
            date: "2099-01-02",
            time: "1pm",
            provider: "Dr. Licht",
            type: "Follow-up",
            facility: "Spring Hill",
            confirmed: true,
          },
        ],
      },
      SPRING_HILL_OFFICE_PHONE,
    );

    expect(prompt).toContain("9:30 AM");
    expect(prompt).toContain("1 PM");
    expect(prompt).not.toContain("9:30AM");
    expect(prompt).not.toContain("1pm");
    expect(prompt).toContain('Say "8:15 AM", "8 AM", or "7:00 PM"');
    expect(prompt).not.toContain("eight fifteen a m");
  });
});
