import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildToolsForTrunk } from "../agent.js";
import { buildPrompt } from "../prompt.js";
import type { PhoneLookupResult } from "../state/call-state.js";
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
  book_appt,
  cancel_appt,
  check_insurance,
  confirm_patient_identity,
  get_current_datetime,
  get_availability,
  lookup_knowledge,
  reschedule_appt,
  route_to_spring_hill,
  switch_preloaded_patient,
  transfer_call,
  update_insurance,
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

  it("introduces Zoe as the virtual assistant", () => {
    const greeting =
      "Hey, this is Zoe, the virtual assistant at Abita Eye Group. How's your day going?";

    expect(getOfficeConfig("spring-hill").greeting).toBe(greeting);
    expect(getOfficeConfig("dev").greeting).toBe(greeting);
    expect(getOfficeConfig("crystal-river").greeting).toBe(
      "Hey, this is Zoe, the virtual assistant at Eye Radiance, powered by Abita Eye Group. How's your day going?",
    );
    expect(getOfficeConfig("hollywood").greeting).toBe(greeting);
    expect(getOfficeConfig("sweetwater").greeting).toBe(greeting);
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

  it("only exposes preloaded patient switching after multiple-match phone lookup", () => {
    const multipleMatchLookup: PhoneLookupResult = {
      status: "multiple_matches",
      message: "Multiple patients found",
      matches: [{ firstName: "DAVID" }, { firstName: "ELLIE" }],
    };

    expect(buildToolsForTrunk(SPRING_HILL_OFFICE_PHONE)).not.toHaveProperty(
      "switch_preloaded_patient",
    );
    expect(
      buildToolsForTrunk(SPRING_HILL_OFFICE_PHONE, {
        status: "verified",
        patientId: "patient-1",
        name: "DAVID MEJIA",
        dob: "01/01/2015",
        phone: "+17275551212",
        insuranceCarrier: "Aetna",
        insPlanId: null,
        respPartyId: null,
        routing: "all_three",
        allowedProviders: [],
        routingAmbiguous: false,
        preauthRequired: false,
        appointments: [],
      }),
    ).not.toHaveProperty("switch_preloaded_patient");
    expect(
      buildToolsForTrunk(SPRING_HILL_OFFICE_PHONE, multipleMatchLookup),
    ).toHaveProperty("switch_preloaded_patient");
  });
});

describe("tool-first prompt gating", () => {
  it("includes core tool-use rules from the role prompt", () => {
    const prompt = buildPrompt(undefined, DEV_OFFICE_PHONE);

    expect(prompt).toContain("<role>");
    expect(prompt).toContain("# Tool Use");
    expect(prompt).toContain("You speak English and Spanish");
    expect(prompt).toContain(
      "If the caller asks to speak Spanish, continue the conversation in Spanish",
    );
    expect(prompt).toContain(
      "When asking for a patient's first or last name, ask them to spell it",
    );
    expect(prompt).toContain(
      "Use confirm_patient_identity for patient-specific work only when internal state has not already confirmed the patient from the pre-call identity step.",
    );
    expect(prompt).toContain(
      "Before calling it, collect the patient's first name, last name, and date of birth.",
    );
    expect(prompt).toContain(
      "If internal state says patient identity is already confirmed, do not ask for last name or date of birth again and do not call confirm_patient_identity again.",
    );
    expect(prompt).toContain(
      "Use the caller identity hint only to choose the first identity question.",
    );
    expect(prompt).toContain("say you see a patient record on file");
    expect(prompt).toContain("say you see a few patient records on file");
    expect(prompt).toContain(
      "For insurance acceptance questions, never answer yes or no without check_insurance.",
    );
    expect(prompt).toContain(
      "Call get_current_datetime before interpreting relative dates or times for scheduling, availability, booking, or appointment changes.",
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

describe("Crystal River prompt guidance", () => {
  it("keeps Crystal River routing guidance out of the prompt and in tool/knowledge surfaces", () => {
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
    expect(route_to_spring_hill.description).toContain(
      "Switch scheduling to Spring Hill without transferring",
    );
    expect(route_to_spring_hill.description).toContain(
      "pediatric ophthalmology",
    );
    expect(route_to_spring_hill.description).toContain("cataract evaluations");
    expect(route_to_spring_hill.description).toContain("routine eye exams");
    expect(route_to_spring_hill.description).toContain(
      "caller is actively scheduling and agrees",
    );
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

  it("keeps compact inline scheduling-lane guidance in the role prompt", () => {
    const prompt = buildPrompt(undefined, SPRING_HILL_OFFICE_PHONE);

    expect(prompt).toContain(
      "For new scheduling, pass appointmentLane to get_availability once the medical-versus-routine lane is clear.",
    );
    expect(prompt).toContain(
      "If the scheduling lane is unclear, ask concise clarifying questions before checking availability.",
    );
  });

  it("does not expose a standalone turn context recorder", () => {
    expect(buildToolsForTrunk(SPRING_HILL_OFFICE_PHONE)).not.toHaveProperty(
      "record_turn_context",
    );
  });

  it("exposes current date/time as an on-demand read-only tool", () => {
    expect(buildToolsForTrunk(SPRING_HILL_OFFICE_PHONE)).toHaveProperty(
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

  it("keeps emergency transfer policy in the base role prompt", () => {
    const prompt = buildPrompt(undefined, SPRING_HILL_OFFICE_PHONE);

    expect(prompt).toContain("emergencies");
    expect(prompt).toContain(
      "Transfer only when the request truly needs a human",
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
    expect(prompt).toContain("Don't open consecutive turns");
    expect(prompt).toContain(
      'Feel free to start sentences with "And", "But", or "So".',
    );
    expect(prompt).toContain("Sorry, I think I missed that, what did you say?");
    expect(prompt).toContain("If the caller asks you to slow down");
    expect(prompt).not.toContain("eight fifteen a m");
  });

  it("does not inject preloaded appointment facilities into the prompt", () => {
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

    expect(prompt).not.toContain("Santos");
    expect(prompt).not.toContain("patient-1");
    expect(prompt).not.toContain("2099-01-01");
    expect(prompt).not.toContain("Hollywood");
  });

  it("keeps single-match pre-call facts out of the prompt", () => {
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
    expect(add_patient.description).toContain(
      "read back the important registration details and get caller confirmation",
    );
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
    };
    expect(
      parameters.safeParse({
        firstName: "Jane",
        lastName: "Doe",
        dob: "01/01/1980",
        street: "123 Main St",
        aptSuite: "",
        city: "Spring Hill",
        state: "FL",
        zip: "34606",
        sex: "female",
        insurance: "Aetna",
        subscriberName: "Jane Doe",
        subscriberNum: "ABC123",
        readBack: true,
      }).success,
    ).toBe(false);
    expect(
      parameters.safeParse({
        firstName: "Jane",
        lastName: "Doe",
        dob: "01/01/1980",
        street: "123 Main St",
        aptSuite: "",
        city: "Spring Hill",
        state: "FL",
        zip: "34606",
        sex: "female",
        insurance: "Aetna",
        appointmentLane: "medical_md",
        subscriberName: "Jane Doe",
        subscriberNum: "ABC123",
        readBack: true,
      }).success,
    ).toBe(true);
  });

  it("keeps availability from exposing Bach-only routing internals", () => {
    expect(get_availability.description).toContain("pass appointmentLane");
    expect(get_availability.description).toContain("medical_md");
    expect(get_availability.description).toContain("routine_od");
    expect(get_availability.description).toContain(
      "Do not call for same-day or past dates",
    );
    expect(get_availability.description).toContain(
      "For explicit calendar dates like June 16",
    );
    expect(get_availability.description).not.toContain("bach_only routing");
    expect(get_availability.description).not.toContain(
      "Under 18 medical visits = Dr. Bach only",
    );

    const parameters = get_availability.parameters as {
      safeParse: (value: unknown) => { success: boolean };
    };
    expect(
      parameters.safeParse({
        date: "2026-06-01",
        appointmentLane: "medical_md",
      }).success,
    ).toBe(true);
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
      "whether the visit is medical or routine vision",
    );
    expect(check_insurance.description).toContain(
      "quick insurance acceptance questions",
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
    expect(transfer_call.description).toContain("prescription questions");
    expect(transfer_call.description).toContain("asking for a specific person");
    expect(transfer_call.description).toContain(
      "returning a missed call or received call from this number",
    );
    expect(transfer_call.description).toContain(
      "status of glasses or contacts already ordered",
    );
    expect(transfer_call.description).not.toContain("tool speaks");
    expect(transfer_call.description).toContain("Do not call for scheduling");
    expect(transfer_call.description).toContain(
      "Crystal River-to-Spring Hill routing",
    );
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
      shape: Record<string, unknown>;
    };
    expect(Object.keys(parameters.shape)).toEqual(["subscriberNum"]);
    expect(parameters.safeParse({}).success).toBe(true);
    expect(parameters.safeParse({ subscriberNum: "ABC123" }).success).toBe(
      true,
    );
  });

  it("keeps cancel_appt scoped to loaded appointment cancellation", () => {
    expect(cancel_appt.description).toContain("Cancel a loaded appointment");
    expect(cancel_appt.description).toContain(
      "caller confirms the exact appointment",
    );
    expect(cancel_appt.description).toContain(
      "latest booked appointment or exactly one loaded appointment",
    );
    expect(cancel_appt.description).toContain(
      "Pass appointmentDate and appointmentTime",
    );
    expect(cancel_appt.description).not.toContain(
      "For reschedules, book the new appointment",
    );

    const parameters = cancel_appt.parameters as {
      safeParse: (value: unknown) => { success: boolean };
    };
    expect(parameters.safeParse({ appointmentId: 123 }).success).toBe(true);
    expect(
      parameters.safeParse({
        appointmentDate: "June 2",
        appointmentTime: "9 AM",
      }).success,
    ).toBe(true);
    expect(parameters.safeParse({}).success).toBe(true);
    expect(parameters.safeParse({ appointmentId: 0 }).success).toBe(false);
    expect(parameters.safeParse({ appointmentId: 1.5 }).success).toBe(false);
  });

  it("exposes reschedule_appt as the deterministic appointment move tool", () => {
    expect(buildToolsForTrunk(SPRING_HILL_OFFICE_PHONE)).toHaveProperty(
      "reschedule_appt",
    );
    expect(reschedule_appt.description).toContain(
      "Reschedule a loaded appointment",
    );
    expect(reschedule_appt.description).toContain(
      "books the new appointment first",
    );
    expect(reschedule_appt.description).toContain(
      "read back the selected new appointment date, time, and provider",
    );
    expect(reschedule_appt.description).toContain(
      "cancels the old appointment only after booking succeeds",
    );

    const parameters = reschedule_appt.parameters as {
      safeParse: (value: unknown) => { success: boolean };
    };
    expect(
      parameters.safeParse({
        slotId: "A",
        confirmedSlotDate: "2026-06-01",
        confirmedSlotTime: "9:00 AM",
        appointmentReason: "move my appointment",
        referringDoctor: "none",
        readBack: true,
        appointmentId: 123,
      }).success,
    ).toBe(true);
    expect(
      parameters.safeParse({
        slotId: "A",
        confirmedSlotDate: "2026-06-01",
        confirmedSlotTime: "9:00 AM",
        appointmentReason: "move my appointment",
        referringDoctor: "none",
        appointmentDate: "June 2",
        appointmentTime: "9 AM",
      }).success,
    ).toBe(true);
    expect(
      parameters.safeParse({
        slotId: "A",
        confirmedSlotDate: "2026-06-01",
        confirmedSlotTime: "9:00 AM",
        appointmentReason: "move my appointment",
      }).success,
    ).toBe(false);
    expect(
      parameters.safeParse({
        slotId: "A",
        confirmedSlotDate: "2026-06-01",
        confirmedSlotTime: "9:00 AM",
        appointmentReason: "move my appointment",
        referringDoctor: "none",
        appointmentId: 0,
      }).success,
    ).toBe(false);
  });

  it("keeps book_appt scoped to confirmed slots with required referring doctor", () => {
    expect(book_appt.description).toContain(
      "Book a caller-confirmed appointment slot",
    );
    expect(book_appt.description).toContain("do not use for reschedules");
    expect(book_appt.description).toContain(
      "caller provides a referring doctor or says they have none",
    );
    expect(book_appt.description).toContain(
      "read back the selected appointment date, time, and provider",
    );

    const parameters = book_appt.parameters as {
      safeParse: (value: unknown) => { success: boolean };
    };
    expect(
      parameters.safeParse({
        slotId: "A",
        appointmentReason: "blurry vision",
      }).success,
    ).toBe(false);
    expect(
      parameters.safeParse({
        slotId: "A",
        appointmentReason: "blurry vision",
        referringDoctor: "none",
        readBack: true,
      }).success,
    ).toBe(false);
    expect(
      parameters.safeParse({
        slotId: "A",
        confirmedSlotDate: "2026-06-01",
        confirmedSlotTime: "9:00 AM",
        appointmentReason: "blurry vision",
        referringDoctor: "none",
      }).success,
    ).toBe(true);
    expect(
      parameters.safeParse({
        slotId: "A",
        confirmedSlotDate: "2026-06-01",
        confirmedSlotTime: "9:00 AM",
        appointmentReason: "blurry vision",
        referringDoctor: "Doctor Lee",
      }).success,
    ).toBe(true);
  });

  it("keeps confirm_patient_identity scoped to patient identity loading", () => {
    expect(confirm_patient_identity.description).toContain(
      "Confirm or load a patient identity",
    );
    expect(confirm_patient_identity.description).toContain(
      "If internal state says patient identity is already confirmed",
    );
    expect(confirm_patient_identity.description).toContain(
      "do not call this tool or ask for last name or DOB again",
    );
    expect(confirm_patient_identity.description).toContain(
      "Call only after collecting the patient's first name, last name, and DOB",
    );
    expect(confirm_patient_identity.description).not.toContain(
      "insurance updates",
    );
    expect(confirm_patient_identity.description).not.toContain(
      "private account",
    );
    expect(confirm_patient_identity.description).not.toContain(
      "firstName only",
    );

    const parameters = confirm_patient_identity.parameters as {
      safeParse: (value: unknown) => { success: boolean };
    };
    expect(
      parameters.safeParse({
        firstName: "Jane",
        lastName: "Doe",
      }).success,
    ).toBe(false);
    expect(
      parameters.safeParse({
        firstName: "Jane",
        lastName: "Doe",
        dob: "01/01/1980",
      }).success,
    ).toBe(true);
  });

  it("keeps switch_preloaded_patient scoped to pre-call multiple-match switches", () => {
    expect(switch_preloaded_patient.description).toContain(
      "another patient already returned by the pre-call phone lookup",
    );
    expect(switch_preloaded_patient.description).toContain(
      "parent is scheduling multiple children",
    );
    expect(switch_preloaded_patient.description).toContain(
      "call get_availability again before booking or rescheduling",
    );

    const parameters = switch_preloaded_patient.parameters as {
      safeParse: (value: unknown) => { success: boolean };
      shape: Record<string, unknown>;
    };
    expect(Object.keys(parameters.shape)).toEqual(["firstName"]);
    expect(parameters.safeParse({ firstName: "Ellie" }).success).toBe(true);
    expect(parameters.safeParse({ firstName: " " }).success).toBe(false);
    expect(parameters.safeParse({}).success).toBe(false);
  });
});
