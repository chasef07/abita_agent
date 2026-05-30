import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildToolsForTrunk } from "../agent.js";
import { buildPrompt } from "../prompt.js";
import {
  CRYSTAL_RIVER_OFFICE_PHONE,
  DEV_OFFICE_PHONE,
  getOfficeConfig,
  getOfficeConfigByPhone,
  getOfficeHandoffTarget,
  getOfficeKeyByPhone,
  HOLLYWOOD_OFFICE_PHONE,
  normalizeHandoffTarget,
  normalizePhoneNumber,
  SPRING_HILL_813_TRUNK_PHONE,
  SPRING_HILL_OFFICE_PHONE,
  SWEETWATER_OFFICE_PHONE,
  SWEETWATER_TRUNK_PHONES,
} from "../customer/profile.js";
import {
  add_patient,
  get_availability,
  verify_patient,
} from "../tools/index.js";
import { getBaseUrlForOfficePhone } from "../clients/advancedmd-client.js";
import { resolveKnowledgeFileForOffice } from "../tools/knowledge.js";

describe("office routing helpers", () => {
  afterEach(() => {
    delete process.env.SPRING_HILL_HANDOFF_TARGET;
    delete process.env.HOLLYWOOD_HANDOFF_TARGET;
    delete process.env.SWEETWATER_HANDOFF_TARGET;
    delete process.env.TELNYX_VOICE_API_HANDOFF_TARGET;
  });

  it("maps trunk numbers to office keys", () => {
    expect(getOfficeKeyByPhone("+13523202007")).toBe("crystal-river");
    expect(getOfficeKeyByPhone(SPRING_HILL_OFFICE_PHONE)).toBe("spring-hill");
    expect(getOfficeKeyByPhone(SPRING_HILL_813_TRUNK_PHONE)).toBe(
      "spring-hill",
    );
    expect(getOfficeKeyByPhone(HOLLYWOOD_OFFICE_PHONE)).toBe("hollywood");
    for (const phone of SWEETWATER_TRUNK_PHONES) {
      expect(getOfficeKeyByPhone(phone)).toBe("sweetwater");
    }
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

  it("routes Hollywood and Sweetwater trunks through their canonical AMD office phones", () => {
    const hollywood = getOfficeConfigByPhone(HOLLYWOOD_OFFICE_PHONE);

    expect(hollywood.key).toBe("hollywood");
    expect(hollywood.amdOfficePhone).toBe(HOLLYWOOD_OFFICE_PHONE);
    expect(buildToolsForTrunk(HOLLYWOOD_OFFICE_PHONE)).not.toHaveProperty(
      "route_to_spring_hill",
    );

    for (const phone of SWEETWATER_TRUNK_PHONES) {
      const sweetwater = getOfficeConfigByPhone(phone);

      expect(sweetwater.key).toBe("sweetwater");
      expect(sweetwater.amdOfficePhone).toBe(SWEETWATER_OFFICE_PHONE);
      expect(buildToolsForTrunk(phone)).not.toHaveProperty(
        "route_to_spring_hill",
      );
    }
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

  it("uses the dev middleware for the dev trunk", () => {
    expect(getBaseUrlForOfficePhone(DEV_OFFICE_PHONE)).toBe(
      "https://advancedmd-token-management-dev.up.railway.app",
    );
  });

  it("maps offices to their knowledge files", () => {
    expect(resolveKnowledgeFileForOffice("crystal-river")).toBe(
      "KNOWLEDGE_EYERADIANCE.md",
    );
    expect(resolveKnowledgeFileForOffice("hollywood")).toBe(
      "KNOWLEDGE_HOLLYWOOD.md",
    );
    expect(resolveKnowledgeFileForOffice("sweetwater")).toBe(
      "KNOWLEDGE_SWEETWATER.md",
    );
    expect(resolveKnowledgeFileForOffice("spring-hill")).toBe(
      "KNOWLEDGE_SPRINGHILL.md",
    );
    expect(resolveKnowledgeFileForOffice("dev")).toBe(
      "KNOWLEDGE_SPRINGHILL.md",
    );
  });

  it("uses office-specific human handoff targets for live offices", () => {
    expect(getOfficeConfig("crystal-river").handoffTarget).toBe(
      "tel:+13527941244",
    );
    expect(getOfficeConfig("spring-hill").handoffTarget).toBe(
      "tel:+16182265883",
    );
    expect(getOfficeConfig("hollywood").handoffTarget).toBe("tel:+16184220360");
    expect(getOfficeConfig("sweetwater").handoffTarget).toBe(
      "tel:+16184220360",
    );
    expect(getOfficeHandoffTarget("hollywood")).toBe("tel:+16184220360");
    expect(getOfficeHandoffTarget("sweetwater")).toBe("tel:+16184220360");
  });

  it("introduces the Abita receptionist as AI and scheduling-capable", () => {
    const greeting =
      "Thanks for calling Abita Eye Group. This is David, the AI receptionist. I'm here to help with scheduling, appointment changes, and quick questions. How can I help?";

    expect(getOfficeConfig("spring-hill").greeting).toBe(greeting);
    expect(getOfficeConfig("dev").greeting).toBe(greeting);
    expect(getOfficeConfig("crystal-river").greeting).toBe(
      "Thank you for calling Eye Radiance powered by Abeeta Eye Group. This is David, the AI receptionist. I'm here to help with scheduling, appointment changes, and quick questions. How can I help?",
    );
    expect(getOfficeConfig("hollywood").greeting).toBe(
      "Thanks for calling Abita Eye Group Hollywood. This is David, the AI receptionist. I'm here to help with scheduling, appointment changes, and quick questions. How can I help?",
    );
    expect(getOfficeConfig("sweetwater").greeting).toBe(
      "Thanks for calling Abita Eye Group Sweetwater. This is David, the AI receptionist. I'm here to help with scheduling, appointment changes, and quick questions. How can I help?",
    );
  });

  it("normalizes handoff targets while allowing SIP URIs directly", () => {
    expect(normalizeHandoffTarget("+16182265883")).toBe("tel:+16182265883");
    expect(normalizeHandoffTarget("16182265883")).toBe("tel:+16182265883");
    expect(normalizeHandoffTarget("tel:+16182265883")).toBe("tel:+16182265883");
    expect(normalizeHandoffTarget("sip:office@sip.telnyx.com")).toBe(
      "sip:office@sip.telnyx.com",
    );
  });

  it("allows Spring Hill to use a Voice API SIP handoff target", () => {
    process.env.SPRING_HILL_HANDOFF_TARGET =
      "sip:+16182265883@livekitappacuity.sip.telnyx.com";

    expect(getOfficeHandoffTarget("spring-hill")).toBe(
      "sip:+16182265883@livekitappacuity.sip.telnyx.com",
    );
    expect(getOfficeHandoffTarget("crystal-river")).toBe("tel:+13527941244");
  });

  it("supports a shared Voice API env override for Spring Hill only", () => {
    process.env.TELNYX_VOICE_API_HANDOFF_TARGET =
      "sip:+16182265883@livekitappacuity.sip.telnyx.com";

    expect(getOfficeHandoffTarget("spring-hill")).toBe(
      "sip:+16182265883@livekitappacuity.sip.telnyx.com",
    );
    expect(getOfficeHandoffTarget("crystal-river")).toBe("tel:+13527941244");
  });

  it("supports office-specific handoff overrides for Hollywood and Sweetwater", () => {
    process.env.HOLLYWOOD_HANDOFF_TARGET = "9545550100";
    process.env.SWEETWATER_HANDOFF_TARGET =
      "sip:sweetwater@livekitappacuity.sip.telnyx.com";

    expect(getOfficeHandoffTarget("hollywood")).toBe("tel:+19545550100");
    expect(getOfficeHandoffTarget("sweetwater")).toBe(
      "sip:sweetwater@livekitappacuity.sip.telnyx.com",
    );
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
    expect(buildToolsForTrunk(HOLLYWOOD_OFFICE_PHONE)).not.toHaveProperty(
      "route_to_spring_hill",
    );
    for (const phone of SWEETWATER_TRUNK_PHONES) {
      expect(buildToolsForTrunk(phone)).not.toHaveProperty(
        "route_to_spring_hill",
      );
    }
  });
});

describe("tool-first prompt gating", () => {
  it("injects tool and session-state instructions", () => {
    const prompt = buildPrompt(undefined, DEV_OFFICE_PHONE);

    expect(prompt).toContain("<tool_operating_contract>");
    expect(prompt).toContain("<state_memory_contract>");
    expect(prompt).toContain("You speak English and Spanish");
    expect(prompt).toContain(
      "If the caller asks to speak Spanish, continue the conversation in Spanish",
    );
    expect(prompt).toContain(
      "When asking for a patient's first or last name, ask them to spell it",
    );
    expect(prompt).toContain(
      'When giving an address, put `<break time="300ms"/>` between the street',
    );
    expect(prompt).toContain(
      "Session state and tool results are authoritative",
    );

    const crystalRiverPrompt = buildPrompt(
      undefined,
      CRYSTAL_RIVER_OFFICE_PHONE,
    );

    expect(crystalRiverPrompt).toContain("<tool_operating_contract>");
    expect(crystalRiverPrompt).toContain("<state_memory_contract>");

    for (const phone of [
      SPRING_HILL_OFFICE_PHONE,
      SPRING_HILL_813_TRUNK_PHONE,
      HOLLYWOOD_OFFICE_PHONE,
      ...SWEETWATER_TRUNK_PHONES,
    ]) {
      const officePrompt = buildPrompt(undefined, phone);

      expect(officePrompt).toContain("<tool_operating_contract>");
      expect(officePrompt).toContain("<state_memory_contract>");
    }
  });

  it("does not treat pre-call lookup failures as no-match callers", () => {
    const prompt = buildPrompt(
      {
        status: "lookup_failed",
        phone: "+17275551212",
        reason: "middleware_error",
        retryable: true,
        lookupDurationMs: 250,
      },
      SPRING_HILL_OFFICE_PHONE,
    );

    expect(prompt).toContain("PHONE LOOKUP UNAVAILABLE");
    expect(prompt).toContain("do not say they are new");
    expect(prompt).toContain("use verify_patient");
    expect(prompt).not.toContain("NO MATCH");
  });

  it("asks no-match callers whether they are registered before making a chart", () => {
    const prompt = buildPrompt(
      {
        status: "no_match",
        phone: "+17275551212",
      },
      SPRING_HILL_OFFICE_PHONE,
    );

    expect(prompt).toContain(
      'Ask "Are you already registered with us, or should I make a new chart?" early in the call.',
    );
    expect(prompt).not.toContain("have you been seen here before");
  });
});

describe("Crystal River prompt guidance", () => {
  it("includes Crystal River routing guidance while keeping office facts in the knowledge file", () => {
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

    expect(prompt).toContain("Use the routing tool, not the transfer tool");
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

    expect(prompt).toContain("an ophthalmology clinic");
    expect(prompt).toContain("<tool_operating_contract>");
    expect(prompt).not.toContain("Visit Type Triage");
    expect(prompt).not.toContain(
      "Before choosing a path, checking insurance, or searching availability",
    );
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

  it("keeps full registration prose out of the Spring Hill prompt", () => {
    const prompt = buildPrompt(undefined, SPRING_HILL_OFFICE_PHONE);

    expect(prompt).not.toContain(
      `is the number you're calling from a good one on file?`,
    );
    expect(prompt).not.toContain("Email is optional");
  });

  it("keeps Hollywood and Sweetwater off the Crystal River routing prompt block", () => {
    const hollywoodPrompt = buildPrompt(undefined, HOLLYWOOD_OFFICE_PHONE);
    const sweetwaterPrompt = buildPrompt(undefined, SWEETWATER_OFFICE_PHONE);
    const hollywoodKnowledge = readFileSync(
      join(
        import.meta.dirname,
        "..",
        "..",
        "workspace",
        "KNOWLEDGE_HOLLYWOOD.md",
      ),
      "utf-8",
    );
    const sweetwaterKnowledge = readFileSync(
      join(
        import.meta.dirname,
        "..",
        "..",
        "workspace",
        "KNOWLEDGE_SWEETWATER.md",
      ),
      "utf-8",
    );

    expect(hollywoodPrompt).not.toContain("route_to_spring_hill");
    expect(sweetwaterPrompt).not.toContain("route_to_spring_hill");
    expect(hollywoodKnowledge).toContain("Abita Eye Group Hollywood");
    expect(hollywoodKnowledge).toContain("4330 Sheridan St, Suite 102B");
    expect(hollywoodKnowledge).toContain("Route to ophthalmology");
    expect(hollywoodKnowledge).toContain(
      "does not perform retina surgical care",
    );
    expect(hollywoodKnowledge).toContain("Katie is the licensed optician");
    expect(hollywoodKnowledge).toContain("@abitaeyegroup");
    expect(hollywoodKnowledge).toContain("Dr. Bach");
    expect(sweetwaterKnowledge).toContain("Abita Eye Group Sweetwater");
    expect(sweetwaterKnowledge).toContain("12750 NW 17th St, #201");
    expect(sweetwaterKnowledge).toContain("Route to ophthalmology");
    expect(sweetwaterKnowledge).toContain(
      "does not perform retina surgical care",
    );
    expect(sweetwaterKnowledge).toContain("Betty is the licensed optician");
    expect(sweetwaterKnowledge).toContain("@abitaeyegroup");
    expect(sweetwaterKnowledge).toContain("Dr. Maria Casas");
  });

  it("keeps compact state-changing tool guidance in the Spring Hill prompt", () => {
    const prompt = buildPrompt(undefined, SPRING_HILL_OFFICE_PHONE);

    expect(prompt).toContain("<tool_operating_contract>");
    expect(prompt).toContain(
      "State-changing tools can run when their required inputs and session state are present.",
    );
    expect(prompt).toContain(
      "Do not say a state-changing action is done until the tool succeeds.",
    );
  });

  it("keeps emergency transfer policy in the base role prompt", () => {
    const prompt = buildPrompt(undefined, SPRING_HILL_OFFICE_PHONE);

    expect(prompt).toContain("emergencies");
    expect(prompt).toContain(
      "Transfer only when the request truly needs a human",
    );
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
    expect(prompt).toContain(
      "Use normal written forms for dates, times, phone numbers, emails, and common acronyms.",
    );
    expect(prompt).not.toContain("eight fifteen a m");
  });

  it("includes preloaded appointment facility from the actual office", () => {
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
        routing: "bach_only",
        allowedProviders: [],
        routingAmbiguous: false,
        appointments: [
          {
            id: 123,
            date: "2099-01-01",
            time: "9:30AM",
            provider: "Dr. Bach",
            type: "Follow-up",
            facility: "Hollywood",
            confirmed: true,
          },
        ],
      },
      HOLLYWOOD_OFFICE_PHONE,
    );

    expect(prompt).toContain(
      "[ID: 123] 2099-01-01 at 9:30 AM with Dr. Bach (Follow-up) at Hollywood",
    );
  });

  it("makes the single-match pre-call contract explicit", () => {
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
        routing: "bach_only",
        allowedProviders: [],
        routingAmbiguous: false,
        appointments: [
          {
            id: 123,
            date: "2099-01-01",
            time: "9:30AM",
            provider: "Dr. Bach",
            type: "Follow-up",
            facility: "Hollywood",
            confirmed: true,
          },
        ],
      },
      HOLLYWOOD_OFFICE_PHONE,
    );

    expect(prompt).toContain("<pre_call_context>");
    expect(prompt).toContain(
      "Phone lookup found exactly one existing patient for this caller.",
    );
    expect(prompt).toContain("- Ask what the caller needs first.");
    expect(prompt).toContain(
      "- Only confirm identity before patient-specific help:",
    );
    expect(prompt).toContain(
      "- For quick questions, office information, policy questions, routing questions that do not require private patient data, or transfer requests, help the caller without patient verification.",
    );
    expect(prompt).toContain(
      "- When identity is needed, ask the caller to spell the patient's first name only.",
    );
    expect(prompt).toContain("- Do not call verify_patient for this caller.");
    expect(prompt).toContain(
      "- Use the preloaded appointment list for appointment changes and cancellations.",
    );
    expect(prompt).toContain("Preloaded facts available after confirmation:");
  });

  it("makes the multiple-match pre-call wording explicit", () => {
    const prompt = buildPrompt(
      {
        status: "multiple_matches",
        message: "Multiple patients found",
        matches: [{ firstName: "IVETTE" }, { firstName: "KAELI" }],
      },
      HOLLYWOOD_OFFICE_PHONE,
    );

    expect(prompt).toContain("MULTIPLE MATCHES (2 patients on this number)");
    expect(prompt).toContain(
      "Say there are multiple patients on this number, ask the caller to confirm the patient's first name first, and do not read names on file aloud.",
    );
    expect(prompt).not.toContain("IVETTE");
    expect(prompt).not.toContain("KAELI");
  });
});

describe("model-facing tool definitions", () => {
  it("keeps Bach-only routing from implying a minor patient", () => {
    expect(add_patient.description).toContain(
      "Do not infer age from Bach-only routing",
    );
    expect(get_availability.description).not.toContain("bach_only routing");
    expect(get_availability.description).not.toContain(
      "Under 18 medical visits = Dr. Bach only",
    );
  });

  it("limits verify_patient to patient-specific help", () => {
    expect(verify_patient.description).toContain(
      "patient-specific help such as scheduling",
    );
    expect(verify_patient.description).toContain("appointment management");
    expect(verify_patient.description).toContain(
      "For caller-phone lookup, provide firstName only",
    );
    expect(verify_patient.description).toContain(
      "Follow the returned status, next, patient, and appointments fields",
    );
  });
});
