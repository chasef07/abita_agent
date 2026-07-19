import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isToolset, type ToolContextEntry } from "@livekit/agents";
import { afterEach, describe, expect, it } from "vitest";
import { buildToolsForTrunk } from "../runtime/tool-registry.js";
import { buildPrompt } from "../prompt.js";
import {
  CRYSTAL_RIVER_OFFICE_PHONE,
  DEV_DEMO_TRANSFER_NUMBER,
  DEV_OFFICE_PHONE,
  getOfficeConfig,
  getOfficeConfigByPhone,
  getOfficePhoneHandoffTarget,
  getOfficeKeyByPhone,
  HOLLYWOOD_OFFICE_PHONE,
  NORTH_MIAMI_BEACH_OPTICAL_OFFICE_PHONE,
  normalizeHandoffTarget,
  normalizePhoneNumber,
  SPRING_HILL_813_TRUNK_PHONE,
  SPRING_HILL_OFFICE_PHONE,
  SWEETWATER_OFFICE_PHONE,
  SWEETWATER_TRUNK_PHONES,
} from "../customers/profile.js";
import {
  add_patient,
  book_appointment,
  cancel_appointment,
  check_insurance,
  create_staff_task,
  resolve_patient,
  get_current_datetime,
  get_availability,
  lookup_knowledge,
  reschedule_appointment,
  transfer_call,
  update_insurance,
} from "../tools/index.js";
import { getBaseUrlForOfficePhone } from "../clients/advancedmd-client.js";
import type { PhoneLookupResult } from "../state/call-state.js";
import {
  lookupOfficeKnowledge,
  resolveKnowledgeFileForOffice,
} from "../tools/knowledge.js";

type VerifiedPhoneLookup = Extract<
  NonNullable<PhoneLookupResult>,
  { status: "verified" }
>;

function verifiedPhoneLookup(
  overrides: Partial<VerifiedPhoneLookup> = {},
): VerifiedPhoneLookup {
  return {
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
    preauthRequired: false,
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
    ...overrides,
  };
}

function toolNames(entries: readonly ToolContextEntry[]): string[] {
  return entries.flatMap((entry) =>
    isToolset(entry) ? toolNames(entry.tools) : [entry.id],
  );
}

function toolNamesForTrunk(trunkPhone: string): string[] {
  return toolNames(buildToolsForTrunk(trunkPhone));
}

describe("office routing helpers", () => {
  afterEach(() => {
    delete process.env.DEV_HANDOFF_TARGET;
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
    expect(getOfficeKeyByPhone(NORTH_MIAMI_BEACH_OPTICAL_OFFICE_PHONE)).toBe(
      "north-miami-beach-optical",
    );
    expect(getOfficeKeyByPhone(DEV_OFFICE_PHONE)).toBe("dev");
  });

  it("routes the Spring Hill 813 trunk through the canonical AMD office phone", () => {
    const office = getOfficeConfigByPhone(SPRING_HILL_813_TRUNK_PHONE);

    expect(office.key).toBe("spring-hill");
    expect(office.amdOfficePhone).toBe(SPRING_HILL_OFFICE_PHONE);
    expect(toolNamesForTrunk(SPRING_HILL_813_TRUNK_PHONE)).not.toContain(
      "route_to_spring_hill",
    );
  });

  it("routes Hollywood and Sweetwater trunks through their canonical AMD office phones", () => {
    const hollywood = getOfficeConfigByPhone(HOLLYWOOD_OFFICE_PHONE);

    expect(hollywood.key).toBe("hollywood");
    expect(hollywood.amdOfficePhone).toBe(HOLLYWOOD_OFFICE_PHONE);
    expect(toolNamesForTrunk(HOLLYWOOD_OFFICE_PHONE)).not.toContain(
      "route_to_spring_hill",
    );

    for (const phone of SWEETWATER_TRUNK_PHONES) {
      const sweetwater = getOfficeConfigByPhone(phone);

      expect(sweetwater.key).toBe("sweetwater");
      expect(sweetwater.amdOfficePhone).toBe(SWEETWATER_OFFICE_PHONE);
      expect(toolNamesForTrunk(phone)).not.toContain("route_to_spring_hill");
    }
  });

  it("routes North Miami Beach Optical through its optical-only AMD office phone", () => {
    const office = getOfficeConfigByPhone(
      NORTH_MIAMI_BEACH_OPTICAL_OFFICE_PHONE,
    );

    expect(office.key).toBe("north-miami-beach-optical");
    expect(office.displayName).toBe("North Miami Beach Optical");
    expect(office.amdOfficePhone).toBe(NORTH_MIAMI_BEACH_OPTICAL_OFFICE_PHONE);
    expect(office.features.medicalScheduling).toBe(false);
    expect(
      toolNamesForTrunk(NORTH_MIAMI_BEACH_OPTICAL_OFFICE_PHONE),
    ).not.toContain("route_to_spring_hill");
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
    expect(resolveKnowledgeFileForOffice("north-miami-beach-optical")).toBe(
      "KNOWLEDGE_NORTH_MIAMI_BEACH_OPTICAL.md",
    );
    expect(resolveKnowledgeFileForOffice("spring-hill")).toBe(
      "KNOWLEDGE_SPRINGHILL.md",
    );
    expect(resolveKnowledgeFileForOffice("dev")).toBe("KNOWLEDGE_DERM_DEMO.md");
  });

  it("keeps phone handoff targets only for non-call-center offices", () => {
    expect(getOfficePhoneHandoffTarget("crystal-river")).toBe(
      "tel:+13527941244",
    );
    expect(getOfficePhoneHandoffTarget("dev")).toBe(
      `tel:${DEV_DEMO_TRANSFER_NUMBER}`,
    );
  });

  it("introduces the configured virtual assistant for each office", () => {
    const greeting =
      "Hey this is Zoe, the virtual assistant at Abeeta Eye Group. How's your day going";

    expect(getOfficeConfig("spring-hill").greeting).toBe(greeting);
    expect(getOfficeConfig("dev").greeting).toBe(
      "Hi, this is Julia, the virtual assistant at Harborleaf Dermatology and Aesthetics. How can I help you today?",
    );
    expect(getOfficeConfig("crystal-river").greeting).toBe(
      "Hey this is Zoe, the virtual assistant at Eye Radiance, powered by Abeeta Eye Group. How's your day going",
    );
    expect(getOfficeConfig("hollywood").greeting).toBe(greeting);
    expect(getOfficeConfig("sweetwater").greeting).toBe(
      "Hey this is Maya, the virtual assistant at Abeeta Eye Group. How's your day going",
    );
    expect(getOfficeConfig("north-miami-beach-optical").greeting).toBe(
      "Hey this is Maya, the virtual assistant at Abeeta Eye Group. How's your day going",
    );
  });

  it("normalizes handoff targets while allowing SIP URIs directly", () => {
    expect(normalizeHandoffTarget("+12025550123")).toBe("tel:+12025550123");
    expect(normalizeHandoffTarget("12025550123")).toBe("tel:+12025550123");
    expect(normalizeHandoffTarget("tel:+12025550123")).toBe("tel:+12025550123");
    expect(normalizeHandoffTarget("sip:office@sip.telnyx.com")).toBe(
      "sip:office@sip.telnyx.com",
    );
  });

  it("does not expose Spring Hill routing on any office trunk", () => {
    expect(toolNamesForTrunk("+13523202007")).not.toContain(
      "route_to_spring_hill",
    );
    expect(toolNamesForTrunk(SPRING_HILL_OFFICE_PHONE)).not.toContain(
      "route_to_spring_hill",
    );
    expect(toolNamesForTrunk(DEV_OFFICE_PHONE)).not.toContain(
      "route_to_spring_hill",
    );
    expect(toolNamesForTrunk(HOLLYWOOD_OFFICE_PHONE)).not.toContain(
      "route_to_spring_hill",
    );
    for (const phone of SWEETWATER_TRUNK_PHONES) {
      expect(toolNamesForTrunk(phone)).not.toContain("route_to_spring_hill");
    }
    expect(
      toolNamesForTrunk(NORTH_MIAMI_BEACH_OPTICAL_OFFICE_PHONE),
    ).not.toContain("route_to_spring_hill");
  });

  it("exposes staff task capture only on Spring Hill inbound trunks", () => {
    expect(toolNamesForTrunk(SPRING_HILL_OFFICE_PHONE)).toContain(
      "create_staff_task",
    );
    expect(toolNamesForTrunk(SPRING_HILL_813_TRUNK_PHONE)).toContain(
      "create_staff_task",
    );
    expect(toolNamesForTrunk(CRYSTAL_RIVER_OFFICE_PHONE)).not.toContain(
      "create_staff_task",
    );
    expect(toolNamesForTrunk(DEV_OFFICE_PHONE)).not.toContain(
      "create_staff_task",
    );
    expect(toolNamesForTrunk(HOLLYWOOD_OFFICE_PHONE)).not.toContain(
      "create_staff_task",
    );
    for (const phone of SWEETWATER_TRUNK_PHONES) {
      expect(toolNamesForTrunk(phone)).not.toContain("create_staff_task");
    }
    expect(
      toolNamesForTrunk(NORTH_MIAMI_BEACH_OPTICAL_OFFICE_PHONE),
    ).not.toContain("create_staff_task");
  });

  it("always exposes one patient resolution tool without a separate switch tool", () => {
    expect(toolNamesForTrunk(SPRING_HILL_OFFICE_PHONE)).toContain(
      "resolve_patient",
    );
    expect(toolNamesForTrunk(SPRING_HILL_OFFICE_PHONE)).not.toContain(
      "switch_preloaded_patient",
    );
  });
});

describe("tool-first prompt gating", () => {
  it("includes core tool-use rules from the role prompt", () => {
    const prompt = buildPrompt(undefined, SPRING_HILL_OFFICE_PHONE);

    expect(prompt).toContain("<role>");
    expect(prompt).toContain("# Tool Use");
    expect(prompt).toContain("You speak English and Spanish");
    expect(prompt).toContain("Reply in the caller's current language");
    expect(prompt).toContain(
      "When asking for a patient's first or last name, ask them to spell it",
    );
    expect(prompt).toContain(
      "Use resolve_patient for patient-specific work when internal state has not already confirmed the patient.",
    );
    expect(prompt).toContain(
      "For a pre-call phone lookup match, ask for the patient's first name and call resolve_patient with that first name.",
    );
    expect(prompt).toContain(
      "If internal state says patient identity is already confirmed, do not ask for last name or date of birth again and do not call resolve_patient again unless the caller clearly asks about a different patient.",
    );
    expect(prompt).toContain("already registered with us");
    expect(prompt).toContain(
      "Do not start identity confirmation just because a caller identity hint exists.",
    );
    expect(prompt).toContain("First learn why the caller is calling.");
    expect(prompt).toContain(
      "Use the caller identity hint only after the caller asks for patient-specific work",
    );
    expect(prompt).toContain("say you see a patient record on file");
    expect(prompt).toContain("say you see a few patient records on file");
    expect(prompt).toContain(
      "For insurance acceptance questions, never answer yes or no without check_insurance.",
    );
    expect(get_availability.description).toContain(
      "do not say the caller is booked, scheduled, or all set until book_appointment returns a successful booking",
    );
    expect(prompt).not.toContain("Today is");
    expect(prompt).not.toContain("The current time is");

    const crystalRiverPrompt = buildPrompt(
      undefined,
      CRYSTAL_RIVER_OFFICE_PHONE,
    );

    expect(crystalRiverPrompt).toContain("# Tool Use");

    for (const phone of [
      SPRING_HILL_OFFICE_PHONE,
      SPRING_HILL_813_TRUNK_PHONE,
      HOLLYWOOD_OFFICE_PHONE,
      NORTH_MIAMI_BEACH_OPTICAL_OFFICE_PHONE,
      ...SWEETWATER_TRUNK_PHONES,
    ]) {
      const officePrompt = buildPrompt(undefined, phone);

      expect(officePrompt).toContain("# Tool Use");
    }
  });

  it("keeps pre-call lookup failures to a safe prompt hint", () => {
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

    expect(prompt).toContain("<caller_identity_hint>");
    expect(prompt).toContain(
      "Caller identity hint: phone lookup failed before the call.",
    );
    expect(prompt).not.toContain("PHONE LOOKUP UNAVAILABLE");
    expect(prompt).not.toContain("do not say they are new");
    expect(prompt).not.toContain("middleware_error");
    expect(prompt).not.toContain("NO MATCH");
  });

  it("keeps no-match lookup outcomes to a safe prompt hint", () => {
    const prompt = buildPrompt(
      {
        status: "no_match",
        phone: "+17275551212",
      },
      SPRING_HILL_OFFICE_PHONE,
    );

    expect(prompt).toContain(
      "Caller identity hint: no matching patient record was found from this phone number.",
    );
    expect(prompt).not.toContain("NO MATCH");
    expect(prompt).not.toContain("This number is not in the system");
    expect(prompt).not.toContain(
      "Are you already registered with us, or should I make a new chart?",
    );
    expect(prompt).not.toContain("have you been seen here before");
  });
});

describe("dermatology demo", () => {
  it("uses a fictional dermatology identity and short role prompt", () => {
    const office = getOfficeConfig("dev");
    const prompt = buildPrompt(undefined, DEV_OFFICE_PHONE);

    expect(office.displayName).toBe("Harborleaf Dermatology & Aesthetics");
    expect(office.roleFile).toBe("SOUL_DERM_DEMO.md");
    expect(office.knowledgeFile).toBe("KNOWLEDGE_DERM_DEMO.md");
    expect(office.features).toEqual({
      medicalScheduling: true,
      routineVisionScheduling: false,
    });
    expect(prompt).toContain("You are Julia");
    expect(prompt).toContain("fictional dermatology practice");
    expect(prompt).toContain("Medical dermatology includes");
    expect(prompt).toContain("appointmentLane medical_md");
    expect(prompt).toContain(
      "The current demo does not book cosmetic or med-spa services",
    );
    expect(prompt).toContain("You speak English and Spanish");
    expect(prompt).not.toContain("Abita Eye Group");
    expect(prompt).not.toContain("an ophthalmology clinic");
    expect(prompt).not.toContain("glasses");
    expect(prompt).not.toContain("contact lenses");
    expect(prompt).not.toContain("# Spring Hill Staff Tasks");
  });

  it("exposes the demo transfer without exposing staff-task tools", () => {
    const names = toolNamesForTrunk(DEV_OFFICE_PHONE);

    expect(names).toContain("lookup_knowledge");
    expect(names).toContain("check_insurance");
    expect(names).toContain("get_availability");
    expect(names).toContain("book_appointment");
    expect(names).toContain("end_call");
    expect(names).toContain("transfer_call");
    expect(names).not.toContain("create_staff_task");
  });

  it("routes demo transfers only to the configured demo target", () => {
    expect(getOfficePhoneHandoffTarget("dev")).toBe(
      `tel:${DEV_DEMO_TRANSFER_NUMBER}`,
    );
    process.env.DEV_HANDOFF_TARGET = "sip:demo@example.test";
    expect(getOfficePhoneHandoffTarget("dev")).toBe("sip:demo@example.test");
  });

  it("retrieves dermatology knowledge for medical and cosmetic questions", () => {
    const cosmetic = lookupOfficeKnowledge("dev", "Do you offer Botox?");
    const medical = lookupOfficeKnowledge(
      "dev",
      "I have a changing mole that is bleeding",
    );

    expect(cosmetic).toContain("## Medical or Cosmetic");
    expect(cosmetic).toContain("Botox and Dysport consultations");
    expect(medical).toContain("## Skin Cancer and Mohs");
    expect(medical).toContain("## Urgency Screening");
    expect(medical).toContain("cannot diagnose skin cancer");
  });

  it("keeps the knowledge base fictional and free of eye-practice identity", () => {
    const knowledge = readFileSync(
      join(
        import.meta.dirname,
        "..",
        "..",
        "workspace",
        "KNOWLEDGE_DERM_DEMO.md",
      ),
      "utf-8",
    );

    expect(knowledge).toContain(
      "fictional practice created for product demonstrations",
    );
    expect(knowledge).toContain("medical dermatology");
    expect(knowledge).toContain(
      "Cosmetic consultations and med-spa services are self-pay",
    );
    expect(knowledge).not.toContain("Abita");
    expect(knowledge).not.toContain("Clear Skin");
    expect(knowledge).not.toContain("Spring Hill");
  });
});

describe("Crystal River prompt guidance", () => {
  it("keeps Crystal River medical-only guidance in knowledge and out of routing tools", () => {
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

    expect(prompt).not.toContain("Use the routing tool, not the transfer tool");
    expect(prompt).not.toContain("route_to_spring_hill");
    expect(prompt).not.toContain("do not transfer just for that");
    expect(getOfficeConfig("crystal-river").features).toMatchObject({
      medicalScheduling: true,
      routineVisionScheduling: false,
    });
    expect(crystalRiverKnowledge).toContain(
      "Crystal River is a medical-only office",
    );
    expect(crystalRiverKnowledge).toContain(
      "does **not** see pediatric ophthalmology",
    );
    expect(crystalRiverKnowledge).toContain("cataract evaluations");
    expect(crystalRiverKnowledge).toContain(
      "Crystal River can schedule the in-office evaluation when appropriate",
    );
    expect(crystalRiverKnowledge).toContain(
      "Do not promise that every test, procedure, or specialty service is available at Crystal River",
    );
    expect(crystalRiverKnowledge).not.toContain(
      "does **not** schedule cataract evaluations",
    );
    expect(crystalRiverKnowledge).not.toContain(
      "does **not** schedule cataract surgery workups",
    );
    expect(crystalRiverKnowledge).not.toContain("coordinates with Spring Hill");
    expect(crystalRiverKnowledge).toContain(
      "does **not** schedule routine-vision exams, glasses prescriptions, or contact lens prescriptions",
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
    expect(prompt).toContain("# Tool Use");
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
    expect(springHillKnowledge).toContain("Routine optometry is age 7+");
    expect(springHillKnowledge).toContain(
      "Children under 7 are not scheduled for routine vision or optical",
    );
    expect(springHillKnowledge).toContain("retinal photos");
    expect(springHillKnowledge).toContain("$39 charge");
    expect(springHillKnowledge).toContain(
      "Collect the last 4 of the patient's Social Security number for routine-vision insurance",
    );
    expect(springHillKnowledge).toContain("patient's policy number");
    expect(springHillKnowledge).not.toContain("insured person's SSN");
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
    expect(hollywoodPrompt).not.toContain("Crystal River routing rules");
    expect(sweetwaterPrompt).not.toContain("Crystal River routing rules");
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

  it("keeps North Miami Beach Optical knowledge limited to provided facts", () => {
    const prompt = buildPrompt(
      undefined,
      NORTH_MIAMI_BEACH_OPTICAL_OFFICE_PHONE,
    );
    const knowledge = readFileSync(
      join(
        import.meta.dirname,
        "..",
        "..",
        "workspace",
        "KNOWLEDGE_NORTH_MIAMI_BEACH_OPTICAL.md",
      ),
      "utf-8",
    );

    expect(prompt).not.toContain("route_to_spring_hill");
    expect(knowledge).toContain("North Miami Beach Optical");
    expect(knowledge).toContain("(305) 509-5333");
    expect(knowledge).toContain("633 NE 167th Street");
    expect(knowledge).toContain("optical-only office");
    expect(knowledge).toContain("Gucci, Montblanc, YSL");
    expect(knowledge).toContain("Dr. Miriam Bach");
    expect(knowledge).toContain("less than 10 business days");
    expect(knowledge).toContain("Do not invent");
    expect(knowledge).toContain("Medical insurance checks are not supported");
  });

  it("keeps compact inline scheduling-lane guidance in the role prompt", () => {
    const prompt = buildPrompt(undefined, SPRING_HILL_OFFICE_PHONE);

    expect(prompt).toContain(
      "For new scheduling, pass appointmentLane to get_availability once the medical-versus-routine lane is clear.",
    );
    expect(prompt).toContain(
      "Use routine_od only for glasses, contacts, prescription updates, contact lens fittings, or routine eye exams with no active eye problem.",
    );
    expect(prompt).toContain(
      'ask: "Is this mainly for glasses or contacts, or for the eye problem?"',
    );
  });

  it("does not expose a standalone turn context recorder", () => {
    expect(toolNamesForTrunk(SPRING_HILL_OFFICE_PHONE)).not.toContain(
      "record_turn_context",
    );
  });

  it("exposes the LiveKit-native end call tool", () => {
    expect(toolNamesForTrunk(SPRING_HILL_OFFICE_PHONE)).toContain("end_call");
  });

  it("exposes current date/time as an on-demand read-only tool", () => {
    expect(toolNamesForTrunk(SPRING_HILL_OFFICE_PHONE)).toContain(
      "get_current_datetime",
    );
    expect(get_current_datetime.description).toContain(
      "current clinic-local date and time",
    );
    expect(get_current_datetime.description).toContain(
      "today, tomorrow, next week, Friday",
    );
    expect(get_current_datetime.description).toContain("read-only");
  });

  it("keeps emergency transfer policy in the shared role prompt", () => {
    const prompt = buildPrompt(undefined, HOLLYWOOD_OFFICE_PHONE);

    expect(prompt).toContain("urgent symptoms");
    expect(prompt).toContain(
      "Transfer only when the request truly needs a live human",
    );
    expect(prompt).toContain("suspected medication reactions");
    expect(prompt).toContain("Do not promise a callback time or outcome");
    expect(prompt).not.toContain("create_staff_task");
    expect(prompt).not.toContain("<office_policy>");
  });

  it("keeps staff-task instructions in the Spring Hill prompt only", () => {
    const springHillPrompt = buildPrompt(undefined, SPRING_HILL_OFFICE_PHONE);

    expect(springHillPrompt).toContain("<office_policy>");
    expect(springHillPrompt).toContain("# Spring Hill Staff Tasks");
    expect(springHillPrompt).toContain("create_staff_task");
    expect(springHillPrompt).toContain(
      "Do not transfer those requests by default",
    );
    expect(springHillPrompt).toContain("medication or prescription name");

    for (const phone of [
      CRYSTAL_RIVER_OFFICE_PHONE,
      DEV_OFFICE_PHONE,
      HOLLYWOOD_OFFICE_PHONE,
      NORTH_MIAMI_BEACH_OPTICAL_OFFICE_PHONE,
      ...SWEETWATER_TRUNK_PHONES,
    ]) {
      const prompt = buildPrompt(undefined, phone);

      expect(prompt).not.toContain("create_staff_task");
      expect(prompt).not.toContain("# Spring Hill Staff Tasks");
      expect(prompt).not.toContain("<office_policy>");
    }
  });

  it("keeps Spring Hill staff-task fallback guidance explicit", () => {
    const prompt = buildPrompt(undefined, SPRING_HILL_OFFICE_PHONE);

    expect(prompt).toContain("Do not transfer those requests by default");
    expect(prompt).toContain(
      "If the request cannot safely become a staff task or task creation fails, transfer the caller to the office",
    );
  });

  it("keeps concise voice guidance in the base voice prompt", () => {
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

    expect(prompt).not.toContain("2099-01-01");
    expect(prompt).not.toContain("2099-01-02");
    expect(prompt).not.toContain("9:30AM");
    expect(prompt).not.toContain("1pm");
    expect(prompt).toContain(
      "Use normal written forms for dates, times, phone numbers, emails, and common acronyms.",
    );
    expect(prompt).toContain("Include light disfluencies");
    expect(prompt).toContain(
      'Start sentences with "And", "But", or "So" when it sounds natural.',
    );
    expect(prompt).toContain("Use audible personality patterns when they fit");
    expect(prompt).toContain("Sorry, I think I missed that, what did you say?");
    expect(prompt).toContain("If the caller asks you to slow down");
    expect(prompt).not.toContain("eight fifteen a m");
  });

  it("does not inject preloaded appointment facilities into the prompt", () => {
    const prompt = buildPrompt(verifiedPhoneLookup(), HOLLYWOOD_OFFICE_PHONE);

    expect(prompt).not.toContain("Santos");
    expect(prompt).not.toContain("patient-1");
    expect(prompt).not.toContain("2099-01-01");
    expect(prompt).not.toContain("Hollywood");
  });

  it("keeps single-match pre-call facts out of the prompt", () => {
    const prompt = buildPrompt(verifiedPhoneLookup(), HOLLYWOOD_OFFICE_PHONE);

    expect(prompt).not.toContain("<pre_call_context>");
    expect(prompt).toContain("<caller_identity_hint>");
    expect(prompt).toContain(
      "Caller identity hint: one likely patient record was found from this phone number.",
    );
    expect(prompt).not.toContain("Santos");
    expect(prompt).not.toContain("01/01/1980");
    expect(prompt).not.toContain("Aetna");
    expect(prompt).not.toContain("2099-01-01");
  });

  it("keeps multiple-match pre-call facts out of the prompt", () => {
    const prompt = buildPrompt(
      {
        status: "multiple_matches",
        message: "Multiple patients found",
        matches: [{ firstName: "IVETTE" }, { firstName: "KAELI" }],
      },
      HOLLYWOOD_OFFICE_PHONE,
    );

    expect(prompt).toContain(
      "Caller identity hint: multiple possible patient records were found from this phone number.",
    );
    expect(prompt).not.toContain("MULTIPLE MATCHES");
    expect(prompt).not.toContain("multiple patients on this number");
    expect(prompt).not.toContain("IVETTE");
    expect(prompt).not.toContain("KAELI");
  });
});

describe("model-facing tool definitions", () => {
  it("keeps add_patient focused on new-patient chart creation", () => {
    expect(add_patient.description).toContain(
      "Creates a chart for a new patient",
    );
    expect(add_patient.description).toContain(
      "checking insurance eligibility with check_insurance",
    );
    expect(add_patient.description).toContain("Pass appointmentLane");
    expect(add_patient.description).toContain("symptom-driven eye care");
    expect(add_patient.description).toContain(
      "routine eye exams with no active eye problem",
    );
    expect(add_patient.description).toContain(
      "read back the important registration details and get caller confirmation",
    );
    expect(add_patient.description).toContain(
      "plans like VSP use the last 4 digits of the patient's Social Security number as the patient's policy number",
    );
    expect(add_patient.description).toContain(
      "vision insurance plans need it to verify coverage",
    );
    expect(add_patient.description).toContain("collect ssnLast4");
    expect(add_patient.description).toContain("Do not ask for the full SSN");
    expect(add_patient.description).toContain(
      "ask whether the number they are calling from is a good callback number",
    );
    expect(add_patient.description).toContain(
      "set inboundPhoneConfirmed to true; do not ask them to repeat that number",
    );
    expect(add_patient.description).not.toContain(
      "Do not infer age from Bach-only routing",
    );

    const parameters = add_patient.parameters as {
      safeParse: (value: unknown) => { success: boolean };
      shape: Record<string, unknown>;
    };
    expect(Object.keys(parameters.shape)).toContain("insuranceMemberId");
    expect(Object.keys(parameters.shape)).toContain("ssnLast4");
    expect(
      String(
        (parameters.shape.insuranceMemberId as { description?: string })
          .description,
      ),
    ).toBe("Member ID from the insurance card.");
    expect(
      String(
        (parameters.shape.ssnLast4 as { description?: string }).description,
      ),
    ).toBe(
      "Last 4 digits of the patient's Social Security number. Collect when appointmentLane is routine_od; do not ask for the full SSN.",
    );
    expect(
      String(
        (parameters.shape.ssnLast4 as { description?: string }).description,
      ),
    ).not.toContain("Optional");
    expect(Object.keys(parameters.shape)).not.toContain("subscriberNum");
    expect(
      parameters.safeParse({
        firstName: "Jane",
        lastName: "Doe",
        dob: "01/01/1980",
        inboundPhoneConfirmed: true,
        street: "1 Main St",
        city: "Spring Hill",
        state: "FL",
        zip: "34609",
        sex: "female",
        insurance: "Aetna",
        appointmentLane: "medical_md",
        subscriberName: "Jane Doe",
      }).success,
    ).toBe(false);
    expect(
      parameters.safeParse({
        firstName: "Jane",
        lastName: "Doe",
        dob: "01/01/1980",
        inboundPhoneConfirmed: true,
        street: "1 Main St",
        city: "Spring Hill",
        state: "FL",
        zip: "34609",
        sex: "female",
        insurance: "Aetna",
        appointmentLane: "medical_md",
        subscriberName: "Jane Doe",
        insuranceMemberId: "ABC123",
        ssnLast4: "1234",
      }).success,
    ).toBe(true);
    expect(
      parameters.safeParse({
        firstName: "Jane",
        lastName: "Doe",
        dob: "01/01/1980",
        inboundPhoneConfirmed: true,
        street: "1 Main St",
        city: "Spring Hill",
        state: "FL",
        zip: "34609",
        sex: "female",
        insurance: "Aetna",
        appointmentLane: "medical_md",
        subscriberName: "Jane Doe",
        insuranceMemberId: "ABC123",
        ssnLast4: "12345",
      }).success,
    ).toBe(false);
  });

  it("keeps availability from exposing Bach-only routing internals", () => {
    expect(get_availability.description).toContain(
      "exact YYYY-MM-DD start date",
    );
    expect(get_availability.description).toContain("pass appointmentLane");
    expect(get_availability.description).toContain("Use timePreference");
    expect(get_availability.description).toContain(
      "Do not call for same-day or past dates",
    );
    expect(get_availability.description).toContain(
      "Call get_current_datetime before using relative dates",
    );
    expect(get_availability.description).toContain(
      "at most two appointmentSlotRef values",
    );
    expect(get_availability.description).not.toContain("bach_only routing");
    expect(get_availability.description).not.toContain(
      "Under 18 medical visits = Dr. Bach only",
    );

    const parameters = get_availability.parameters as {
      safeParse: (value: unknown) => { success: boolean };
      shape: {
        appointmentLane: { description?: string };
        timePreference: { description?: string };
      };
    };
    expect(parameters.shape.appointmentLane.description).toContain(
      "medical_md",
    );
    expect(parameters.shape.appointmentLane.description).toContain(
      "routine_od",
    );
    expect(parameters.shape.timePreference.description).toContain("morning");
    expect(parameters.shape.timePreference.description).toContain("afternoon");
    expect(parameters.shape.timePreference.description).toContain("none");
    expect(
      parameters.safeParse({
        date: "2026-06-01",
        appointmentLane: "medical_md",
        timePreference: "afternoon",
      }).success,
    ).toBe(true);
    expect(
      parameters.safeParse({
        date: "2026-06-01",
        appointmentLane: "medical_md",
        timePreference: "morning",
      }).success,
    ).toBe(true);
    expect(
      parameters.safeParse({
        date: "2026-06-01",
        appointmentLane: "medical_md",
        timePreference: "evening",
      }).success,
    ).toBe(false);
    expect(
      parameters.safeParse({
        date: "2026-06-01",
        appointmentLane: "routine_od",
      }).success,
    ).toBe(true);
    expect(
      parameters.safeParse({
        date: "2026-06-01",
        appointmentLane: "unknown",
      }).success,
    ).toBe(false);
    expect(
      parameters.safeParse({
        date: "next Wednesday",
        appointmentLane: "medical_md",
      }).success,
    ).toBe(false);
    expect(
      parameters.safeParse({
        date: "2026-6-1",
        appointmentLane: "medical_md",
      }).success,
    ).toBe(false);
  });

  it("keeps check_insurance scoped to insurance eligibility", () => {
    expect(check_insurance.description).toContain(
      "active office accepts the caller's insurance",
    );
    expect(check_insurance.description).toContain(
      "before adding a new patient",
    );
    expect(check_insurance.description).toContain(
      "whether the visit is medical or glasses/contacts routine vision",
    );
    expect(check_insurance.description).toContain(
      "quick insurance acceptance questions",
    );
    expect(check_insurance.description).toContain(
      "do not call check_insurance again until the caller gives a more specific plan or coverage type",
    );
    expect(check_insurance.description).toContain(
      "If the result says needs_transfer, transfer the caller to staff before scheduling.",
    );
    expect(check_insurance.description).not.toContain("speech-ready");
    expect(check_insurance.description).not.toContain("routeTool");

    const parameters = check_insurance.parameters as {
      safeParse: (value: unknown) => { success: boolean };
    };
    expect(
      parameters.safeParse({
        plan: "Blue Cross",
      }).success,
    ).toBe(false);
    expect(
      parameters.safeParse({
        plan: "   ",
        coverageType: "medical",
      }).success,
    ).toBe(false);
    expect(
      parameters.safeParse({
        plan: "Blue Cross",
        coverageType: "medical",
      }).success,
    ).toBe(true);
  });

  it("keeps lookup_knowledge scoped to general office facts", () => {
    expect(lookup_knowledge.description).toContain(
      "general practice questions",
    );
    expect(lookup_knowledge.description).toContain("address, hours, providers");
    expect(lookup_knowledge.description).not.toContain("patient-specific");
    expect(lookup_knowledge.description).not.toContain("availability, booking");

    const parameter = lookup_knowledge.parameters.shape.question;
    expect(parameter.description).toBe("The caller's office-fact question");
  });

  it("keeps transfer_call scoped to human-only work", () => {
    expect(transfer_call.description).toContain(
      "outside the agent's front-desk scope",
    );
    expect(transfer_call.description).toContain(
      "ask what they are calling about before calling this tool",
    );
    expect(transfer_call.description).toContain(
      "suspected medication reactions",
    );
    expect(transfer_call.description).toContain(
      "dosage or medication instructions",
    );
    expect(transfer_call.description).toContain(
      "returned missed calls or received calls from this number",
    );
    expect(transfer_call.description).not.toContain("create_staff_task");
    expect(transfer_call.description).not.toContain("staff task");
    expect(transfer_call.description).not.toContain("tool speaks");
    expect(transfer_call.description).toContain("Do not call for scheduling");
    expect(transfer_call.description).not.toContain("Spring Hill routing");
  });

  it("keeps staff task capture scoped to safe non-live work", () => {
    expect(create_staff_task.description).toContain(
      "safe non-live office work",
    );
    expect(create_staff_task.description).toContain("high_priority");
    expect(create_staff_task.description).toContain(
      "never use it for clinical acuity",
    );
    expect(create_staff_task.description).toContain("returned calls");
    expect(create_staff_task.description).toContain(
      "routine medication and prescription requests",
    );
    expect(create_staff_task.description).toContain("use category other");
    expect(create_staff_task.description).toContain(
      "medication or prescription name",
    );
    expect(create_staff_task.description).toContain(
      "suspected medication reactions",
    );
    expect(create_staff_task.description).toContain("Transfer those instead");
    expect(
      create_staff_task.parameters.safeParse({
        category: "billing",
        urgency: "high_priority",
        summary: "Caller has a billing question.",
        message: "The caller wants billing to review a recent bill.",
      }).success,
    ).toBe(true);
    expect(
      create_staff_task.parameters.safeParse({
        category: "other",
        urgency: "normal",
        summary: "Caller needs a medication refill reviewed.",
        message:
          "The caller needs staff to review a refill request and provided the medication and pharmacy.",
      }).success,
    ).toBe(true);
    expect(
      create_staff_task.parameters.safeParse({
        category: "billing",
        urgency: "urgent",
        summary: "Caller has a billing question.",
        message: "The caller wants billing to review a recent bill.",
      }).success,
    ).toBe(false);
  });

  it("keeps update_insurance scoped to verified-patient checked coverage updates", () => {
    expect(update_insurance.description).toContain("verified existing patient");
    expect(update_insurance.description).toContain(
      "explicitly says they want to update the insurance on file",
    );
    expect(update_insurance.description).toContain(
      "Do not call for new patients or registration flows",
    );
    expect(update_insurance.description).toContain(
      "correct medical or routine-vision coverage type",
    );

    const parameters = update_insurance.parameters as {
      safeParse: (value: unknown) => { success: boolean };
      shape: Record<string, { description?: string }>;
    };
    expect(Object.keys(parameters.shape)).toEqual(["insuranceMemberId"]);
    expect(parameters.shape.insuranceMemberId.description).toBe(
      'Member ID from the insurance card. Use "self pay" only when check_insurance accepted Self Pay.',
    );
    expect(parameters.safeParse({}).success).toBe(false);
    expect(parameters.safeParse({ insuranceMemberId: "ABC123" }).success).toBe(
      true,
    );
    expect(parameters.safeParse({ subscriberNum: "ABC123" }).success).toBe(
      false,
    );
  });

  it("exposes clear active appointment tool names without legacy aliases", () => {
    const toolNames = toolNamesForTrunk(SPRING_HILL_OFFICE_PHONE);

    expect(toolNames).toEqual(
      expect.arrayContaining([
        "book_appointment",
        "cancel_appointment",
        "reschedule_appointment",
      ]),
    );
    expect(toolNames).not.toEqual(
      expect.arrayContaining(["book_appt", "cancel_appt", "reschedule_appt"]),
    );
  });

  it("keeps cancel_appointment scoped to loaded appointment cancellation", () => {
    expect(cancel_appointment.description).toContain(
      "Cancel a loaded appointment",
    );
    expect(cancel_appointment.description).toContain(
      "caller confirms the exact appointment",
    );
    expect(cancel_appointment.description).toContain(
      "latest booked appointment or exactly one loaded appointment",
    );
    expect(cancel_appointment.description).toContain(
      "Pass appointmentDate and appointmentTime",
    );
    expect(cancel_appointment.description).toContain(
      "Do not pass backend patient IDs or appointment IDs",
    );
    expect(cancel_appointment.description).not.toContain(
      "For reschedules, book the new appointment",
    );

    const parameters = cancel_appointment.parameters as {
      safeParse: (value: unknown) => { success: boolean };
      shape: Record<string, unknown>;
    };
    expect(Object.keys(parameters.shape)).toEqual([
      "appointmentDate",
      "appointmentTime",
    ]);
    expect(parameters.safeParse({ appointmentId: 123 }).success).toBe(false);
    expect(
      parameters.safeParse({
        appointmentDate: "June 2",
        appointmentTime: "9 AM",
      }).success,
    ).toBe(true);
    expect(parameters.safeParse({}).success).toBe(true);
  });

  it("exposes reschedule_appointment as the deterministic appointment move tool", () => {
    expect(toolNamesForTrunk(SPRING_HILL_OFFICE_PHONE)).toContain(
      "reschedule_appointment",
    );
    expect(reschedule_appointment.description).toContain(
      "Reschedule a loaded appointment",
    );
    expect(reschedule_appointment.description).toContain(
      "books the new appointment first",
    );
    expect(reschedule_appointment.description).toContain(
      "read back the selected new appointment date, time, and provider",
    );
    expect(reschedule_appointment.description).toContain(
      "Do not pass backend patient IDs or appointment IDs",
    );
    expect(reschedule_appointment.description).toContain("oldAppointmentRef");
    expect(reschedule_appointment.description).toContain(
      "do not call this tool again until you can pass the matching oldAppointmentRef",
    );
    expect(reschedule_appointment.description).toContain(
      "cancels the old appointment only after booking succeeds",
    );

    const parameters = reschedule_appointment.parameters as {
      safeParse: (value: unknown) => { success: boolean };
      shape: Record<string, unknown>;
    };
    expect(Object.keys(parameters.shape)).toEqual([
      "appointmentSlotRef",
      "appointmentReason",
      "referringDoctor",
      "readBack",
      "oldAppointmentRef",
    ]);
    expect(
      parameters.safeParse({
        appointmentSlotRef: "A",
        appointmentReason: "move my appointment",
        referringDoctor: "none",
        readBack: true,
      }).success,
    ).toBe(true);
    expect(
      parameters.safeParse({
        appointmentSlotRef: "A",
        appointmentReason: "move my appointment",
        referringDoctor: "none",
        oldAppointmentRef: "old-appointment-2-abc123",
      }).success,
    ).toBe(true);
    expect(
      parameters.safeParse({
        appointmentSlotRef: "A",
        appointmentReason: "move my appointment",
        referringDoctor: "none",
        oldAppointmentDate: "June 2",
        oldAppointmentTime: "9 AM",
      }).success,
    ).toBe(false);
    expect(
      parameters.safeParse({
        slotId: "A",
        appointmentReason: "move my appointment",
        referringDoctor: "none",
        appointmentDate: "June 2",
        appointmentTime: "9 AM",
        appointmentId: 123,
      }).success,
    ).toBe(false);
    expect(
      parameters.safeParse({
        newSlotId: "A",
        appointmentReason: "move my appointment",
        referringDoctor: "none",
        appointmentDate: "June 2",
        appointmentTime: "9 AM",
        appointmentId: 123,
      }).success,
    ).toBe(false);
    expect(
      parameters.safeParse({
        newAppointmentSlotRef: "A",
        appointmentReason: "move my appointment",
        referringDoctor: "none",
      }).success,
    ).toBe(false);
    expect(
      parameters.safeParse({
        appointmentSlotRef: "A",
        appointmentReason: "move my appointment",
        referringDoctor: "none",
        appointmentId: 123,
      }).success,
    ).toBe(false);
    expect(
      parameters.safeParse({
        appointmentReason: "move my appointment",
        referringDoctor: "none",
      }).success,
    ).toBe(false);
    expect(
      parameters.safeParse({
        appointmentSlotRef: "A",
        appointmentReason: "move my appointment",
      }).success,
    ).toBe(false);
  });

  it("keeps book_appointment scoped to confirmed slots with required referring doctor", () => {
    expect(book_appointment.description).toContain(
      "Book a caller-confirmed appointment slot",
    );
    expect(book_appointment.description).toContain(
      "do not use for reschedules",
    );
    expect(book_appointment.description).toContain(
      "caller provides a referring doctor or says they have none",
    );
    expect(book_appointment.description).toContain(
      "enough caller-provided detail for staff to prepare appropriate diagnostic testing",
    );
    expect(book_appointment.description).toContain(
      "read back the selected appointment date, time, and provider",
    );
    expect(book_appointment.description).toContain(
      "Only after this tool returns a successful booking may you tell the caller they are booked, scheduled, or all set",
    );

    const parameters = book_appointment.parameters as {
      safeParse: (value: unknown) => { success: boolean };
      shape: Record<string, unknown>;
    };
    expect(Object.keys(parameters.shape)).toEqual([
      "appointmentSlotRef",
      "appointmentReason",
      "referringDoctor",
      "readBack",
    ]);
    expect(
      (
        parameters.shape.appointmentReason as {
          description?: string;
        }
      ).description,
    ).toContain(
      "enough detail for staff to prepare appropriate diagnostic testing",
    );
    expect(parameters.safeParse({}).success).toBe(false);
    expect(
      parameters.safeParse({
        appointmentSlotRef: "A",
        appointmentReason: "eye pain",
        referringDoctor: "none",
      }).success,
    ).toBe(true);
  });

  it("keeps resolve_patient scoped to patient identity loading", () => {
    expect(resolve_patient.description).toContain("Resolve who the patient is");
    expect(resolve_patient.description).toContain("preloaded patient");
    expect(resolve_patient.description).toContain(
      "firstName, lastName, and DOB",
    );
    expect(resolve_patient.description).toContain(
      "registrationStatus not_registered before add_patient",
    );
    expect(resolve_patient.description).not.toContain("insurance updates");
    expect(resolve_patient.description).not.toContain("private account");

    const parameters = resolve_patient.parameters as {
      safeParse: (value: unknown) => { success: boolean };
      shape: Record<string, unknown>;
    };
    expect(Object.keys(parameters.shape)).toEqual([
      "firstName",
      "lastName",
      "dob",
      "registrationStatus",
    ]);
    expect(
      parameters.safeParse({
        firstName: "Jane",
        lastName: "Doe",
      }).success,
    ).toBe(true);
    expect(
      parameters.safeParse({
        firstName: "Jane",
        lastName: "Doe",
        dob: "01/01/1980",
      }).success,
    ).toBe(true);
    expect(
      parameters.safeParse({ registrationStatus: "not_registered" }).success,
    ).toBe(true);
    expect(parameters.safeParse({ firstName: " " }).success).toBe(false);
  });
});
