import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildToolsForTrunk } from "../agent.js";
import { buildPrompt } from "../prompt.js";
import {
  DEV_OFFICE_PHONE,
  getOfficeConfig,
  getOfficeConfigByPhone,
  getOfficeHandoffTarget,
  getOfficeKeyByPhone,
  HOLLYWOOD_OFFICE_PHONE,
  isFlowHarnessEnabledForTrunk,
  normalizeHandoffTarget,
  normalizePhoneNumber,
  SPRING_HILL_813_TRUNK_PHONE,
  SPRING_HILL_OFFICE_PHONE,
  SWEETWATER_OFFICE_PHONE,
  SWEETWATER_TRUNK_PHONES,
} from "../offices.js";
import {
  getAmdOfficeForToolCall,
  getBaseUrlForOfficePhone,
  getSpringHillOfficePhone,
  resolveKnowledgeFileForOffice,
} from "../tools.js";

describe("office routing helpers", () => {
  afterEach(() => {
    delete process.env.SPRING_HILL_HANDOFF_TARGET;
    delete process.env.CRYSTAL_RIVER_HANDOFF_TARGET;
    delete process.env.HOLLYWOOD_HANDOFF_TARGET;
    delete process.env.SWEETWATER_HANDOFF_TARGET;
    delete process.env.DEV_HANDOFF_TARGET;
    delete process.env.TELNYX_VOICE_API_HANDOFF_TARGET;
    delete process.env.OFFICE_HANDOFF_TARGET;
    delete process.env.FLOW_HARNESS_TRUNK_PHONES;
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

  it("enables the flow harness only for the demo trunk by default", () => {
    delete process.env.FLOW_HARNESS_TRUNK_PHONES;

    expect(isFlowHarnessEnabledForTrunk(DEV_OFFICE_PHONE)).toBe(true);
    expect(isFlowHarnessEnabledForTrunk("14843989071")).toBe(true);
    expect(isFlowHarnessEnabledForTrunk(SPRING_HILL_OFFICE_PHONE)).toBe(false);
    expect(isFlowHarnessEnabledForTrunk("+13523202007")).toBe(false);
    expect(isFlowHarnessEnabledForTrunk(HOLLYWOOD_OFFICE_PHONE)).toBe(false);
    for (const phone of SWEETWATER_TRUNK_PHONES) {
      expect(isFlowHarnessEnabledForTrunk(phone)).toBe(false);
    }
  });

  it("allows the flow harness trunk list to be overridden explicitly", () => {
    process.env.FLOW_HARNESS_TRUNK_PHONES = `13523202007, ${SPRING_HILL_OFFICE_PHONE}`;

    expect(isFlowHarnessEnabledForTrunk("+13523202007")).toBe(true);
    expect(isFlowHarnessEnabledForTrunk(SPRING_HILL_OFFICE_PHONE)).toBe(true);
    expect(isFlowHarnessEnabledForTrunk(DEV_OFFICE_PHONE)).toBe(false);
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

  it("only exposes flow harness tools on demo trunk calls", () => {
    const demoTools = buildToolsForTrunk(DEV_OFFICE_PHONE);
    expect(demoTools).toHaveProperty("record_turn_understanding");
    expect(demoTools).not.toHaveProperty("confirm_booking_action");
    expect(demoTools).not.toHaveProperty("confirm_side_effect_action");

    const liveTrunks = [
      SPRING_HILL_OFFICE_PHONE,
      SPRING_HILL_813_TRUNK_PHONE,
      "+13523202007",
      HOLLYWOOD_OFFICE_PHONE,
      ...SWEETWATER_TRUNK_PHONES,
    ];

    for (const phone of liveTrunks) {
      const tools = buildToolsForTrunk(phone);
      expect(tools).not.toHaveProperty("record_turn_understanding");
      expect(tools).not.toHaveProperty("confirm_booking_action");
      expect(tools).not.toHaveProperty("confirm_side_effect_action");
    }
  });
});

describe("flow harness prompt gating", () => {
  afterEach(() => {
    delete process.env.FLOW_HARNESS_TRUNK_PHONES;
  });

  it("injects state harness instructions only for the demo trunk", () => {
    const prompt = buildPrompt(undefined, DEV_OFFICE_PHONE);

    expect(prompt).toContain("<harness_operating_contract>");
    expect(prompt).toContain("<flow_harness_runbook>");
    expect(prompt).toContain("<state_memory_contract>");
    expect(prompt).toContain("<context_capsules>");
    expect(prompt).toContain("record_turn_understanding");
    expect(prompt).not.toContain("<runbook>");
    expect(prompt).not.toContain("RUNBOOK.md - How to Handle Every Call");
    expect(prompt).not.toContain("confirm_booking_action");
    expect(prompt).not.toContain("confirm_side_effect_action");
  });

  it("keeps flow harness instructions out of live-office prompts", () => {
    const prompt = buildPrompt(undefined, SPRING_HILL_OFFICE_PHONE);

    expect(prompt).not.toContain("<flow_harness_runbook>");
    expect(prompt).not.toContain("<state_memory_contract>");
    expect(prompt).toContain("<runbook>");
    expect(prompt).not.toContain("record_turn_understanding");
    expect(prompt).not.toContain("confirm_booking_action");
    expect(prompt).not.toContain("confirm_side_effect_action");
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
    expect(prompt).toContain("Reason for visit and referring doctor");
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

  it("allows registration to continue when a new patient has no email", () => {
    const prompt = buildPrompt(undefined, SPRING_HILL_OFFICE_PHONE);

    expect(prompt).toContain("Email is optional");
    expect(prompt).toContain("continue registration without it");
  });

  it("tells scheduling flows to save the patient note only after booking succeeds", () => {
    const prompt = buildPrompt(undefined, SPRING_HILL_OFFICE_PHONE);

    expect(prompt).toContain(
      "ask reason for visit first, then ask whether a doctor referred them",
    );
    expect(prompt).toContain(
      "After book_appt succeeds, call add_patient_note with appointmentReason and referringDoctor",
    );
    expect(prompt).toContain(
      "Do not call add_patient_note before a successful booking",
    );
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

  it("includes preloaded appointment facility so confirmations use the actual office", () => {
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

  it("does not include past preloaded appointments in caller context", () => {
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
            id: 111,
            date: "2020-01-01",
            time: "9:30AM",
            provider: "Dr. Bach",
            type: "Follow-up",
            facility: "Hollywood",
            confirmed: true,
          },
          {
            id: 222,
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

    expect(prompt).toContain("[ID: 222]");
    expect(prompt).not.toContain("[ID: 111]");
    expect(prompt).not.toContain("Past appointments");
  });
});
