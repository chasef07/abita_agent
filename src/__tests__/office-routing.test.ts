import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isToolset, type ToolContextEntry } from "@livekit/agents";
import { afterEach, describe, expect, it } from "vitest";
import { buildToolsForTrunk } from "../runtime/tool-registry.js";
import { buildPrompt } from "../prompt.js";
import {
  CRYSTAL_RIVER_OFFICE_PHONE,
  DEV_OFFICE_PHONE,
  getOfficeProfile,
  getOfficeKeyByPhone,
  HOLLYWOOD_OFFICE_PHONE,
  NORTH_MIAMI_BEACH_OPTICAL_OFFICE_PHONE,
  normalizeHandoffTarget,
  normalizePhoneNumber,
  SPRING_HILL_813_TRUNK_PHONE,
  SPRING_HILL_OFFICE_PHONE,
  SWEETWATER_OFFICE_PHONE,
  SWEETWATER_TRUNK_PHONES,
} from "../customers/abita/profile.js";
import {
  add_patient,
  book_appointment,
  cancel_appointment,
  check_insurance,
  create_staff_task,
  resolve_patient,
  get_availability,
  reschedule_appointment,
  transfer_call,
  update_insurance,
} from "../tools/index.js";
import { resolveOfficeKnowledge } from "../office-knowledge.js";

const GLASSES_READY_ANSWER =
  "Check your texts. You'll receive a text when they're ready. If you haven't received a text, they aren't ready yet.";

function toolNames(entries: readonly ToolContextEntry[]): string[] {
  return entries.flatMap((entry) =>
    isToolset(entry) ? toolNames(entry.tools) : [entry.id],
  );
}

function toolNamesForTrunk(trunkPhone: string): string[] {
  return toolNames(buildToolsForTrunk(trunkPhone));
}

afterEach(() => {
  delete process.env.DEV_HANDOFF_TARGET;
});

describe("office routing helpers", () => {
  it("normalizes LiveKit phone attributes without a plus prefix", () => {
    expect(normalizePhoneNumber("14843989071")).toBe(DEV_OFFICE_PHONE);
    expect(getOfficeKeyByPhone("14843989071")).toBe("dev");
  });

  it("normalizes handoff targets while allowing SIP URIs directly", () => {
    expect(normalizeHandoffTarget("+12025550123")).toBe("tel:+12025550123");
    expect(normalizeHandoffTarget("12025550123")).toBe("tel:+12025550123");
    expect(normalizeHandoffTarget("tel:+12025550123")).toBe("tel:+12025550123");
    expect(normalizeHandoffTarget("sip:office@sip.telnyx.com")).toBe(
      "sip:office@sip.telnyx.com",
    );
  });

  it("always exposes one patient resolution tool without a separate switch tool", () => {
    expect(toolNamesForTrunk(SPRING_HILL_OFFICE_PHONE)).toContain(
      "resolve_patient",
    );
    expect(toolNamesForTrunk(SPRING_HILL_OFFICE_PHONE)).not.toContain(
      "switch_preloaded_patient",
    );
  });

  it("exposes staff task capture on every production office and not the demo", () => {
    for (const phone of [
      SPRING_HILL_OFFICE_PHONE,
      SPRING_HILL_813_TRUNK_PHONE,
      CRYSTAL_RIVER_OFFICE_PHONE,
      HOLLYWOOD_OFFICE_PHONE,
      NORTH_MIAMI_BEACH_OPTICAL_OFFICE_PHONE,
      ...SWEETWATER_TRUNK_PHONES,
    ]) {
      expect(toolNamesForTrunk(phone)).toContain("create_staff_task");
    }

    expect(toolNamesForTrunk(DEV_OFFICE_PHONE)).not.toContain(
      "create_staff_task",
    );
  });
});

describe("tool-first prompt gating", () => {
  it("includes core tool-use rules from the role prompt", () => {
    const prompt = buildPrompt(SPRING_HILL_OFFICE_PHONE);

    expect(prompt).toContain("<role>");
    expect(prompt).toContain("# Tool Use");
    expect(prompt).toContain(
      "Callers have already reached Abita Eye Group. Do not send them to a separate clinic line or phone number",
    );
    expect(prompt).toContain(
      "handle routine front desk work with the available tools or transfer them to live office staff when needed",
    );
    expect(prompt).toContain("You speak English and Spanish");
    expect(prompt).toContain("Reply in the caller's current language");
    expect(prompt).toContain(
      "When asking for a patient's first or last name, ask them to spell it",
    );
    expect(prompt).toContain(
      "Always call book_appointment before saying an appointment is booked.",
    );
    expect(prompt).toContain(
      "For calls involving more than one patient, finish one patient's task at a time.",
    );
    expect(prompt).toContain(
      "Before starting work for the next patient, call resolve_patient to switch the active patient.",
    );
    expect(prompt).toContain(
      "For insurance acceptance questions, never answer yes or no without check_insurance.",
    );
    expect(prompt).not.toContain(
      "Use resolve_patient for patient-specific work when internal state has not already confirmed the patient.",
    );
    expect(get_availability.description).toContain(
      "only claim success after book_appointment succeeds",
    );
    expect(prompt).not.toContain("Today is");
    expect(prompt).not.toContain("The current time is");

    const crystalRiverPrompt = buildPrompt(CRYSTAL_RIVER_OFFICE_PHONE);

    expect(crystalRiverPrompt).toContain("# Tool Use");

    for (const phone of [
      SPRING_HILL_OFFICE_PHONE,
      SPRING_HILL_813_TRUNK_PHONE,
      HOLLYWOOD_OFFICE_PHONE,
      NORTH_MIAMI_BEACH_OPTICAL_OFFICE_PHONE,
      ...SWEETWATER_TRUNK_PHONES,
    ]) {
      const officePrompt = buildPrompt(phone);

      expect(officePrompt).toContain("# Tool Use");
    }
  });

  it("keeps identity and privacy policy in the static prompt", () => {
    const prompt = buildPrompt(SPRING_HILL_OFFICE_PHONE);

    expect(prompt).toContain("<caller_identity_policy>");
    expect(prompt).toContain(
      "single_match, multiple_matches, no_match, or lookup_failed",
    );
    expect(prompt).toContain(
      "Use that status only after the caller asks for patient-specific help.",
    );
    expect(prompt).toContain(
      "Never reveal or infer hidden candidate details before identity is confirmed.",
    );
    expect(prompt).toContain(
      "After identity is confirmed, use the selected patient's name and loaded appointments",
    );
    expect(prompt).not.toContain("<caller_identity_hint>");
    expect(prompt).not.toContain("middleware_error");
    expect(prompt).not.toContain("+17275551212");
  });
});

describe("dermatology demo", () => {
  it("uses a fictional dermatology identity and short role prompt", () => {
    const prompt = buildPrompt(DEV_OFFICE_PHONE);

    expect(prompt).toContain("You are Julia");
    expect(prompt).toContain("fictional dermatology practice");
    expect(prompt).toContain("Medical dermatology includes");
    expect(prompt).toContain("appointmentLane medical_md");
    expect(prompt).toContain(
      "The current demo does not book cosmetic or med-spa services",
    );
    expect(prompt).toContain(
      "For calls involving more than one patient, finish one patient's task at a time.",
    );
    expect(prompt).toContain(
      "Before starting work for the next patient, call resolve_patient to switch the active patient.",
    );
    expect(prompt).toContain("You speak English and Spanish");
    expect(prompt).not.toContain("Abita Eye Group");
    expect(prompt).not.toContain("an ophthalmology clinic");
    expect(prompt).not.toContain("glasses");
    expect(prompt).not.toContain("contact lenses");
  });

  it("exposes the demo transfer without exposing staff-task tools", () => {
    const names = toolNamesForTrunk(DEV_OFFICE_PHONE);

    expect(names).toContain("check_insurance");
    expect(names).toContain("get_availability");
    expect(names).toContain("book_appointment");
    expect(names).toContain("end_call");
    expect(names).toContain("transfer_call");
    expect(names).not.toContain("create_staff_task");
  });

  it("honors the isolated demo handoff override", () => {
    process.env.DEV_HANDOFF_TARGET = "sip:demo@example.test";
    expect(getOfficeProfile("dev").handoff()).toEqual({
      mode: "phone",
      target: "sip:demo@example.test",
    });
  });

  it("retrieves dermatology knowledge for medical and cosmetic questions", () => {
    const cosmetic = resolveOfficeKnowledge("dev", "Do you offer Botox?");
    const medical = resolveOfficeKnowledge("dev", "Do you perform Mohs?");

    expect(cosmetic.sections.join("\n")).toContain("## Medical or Cosmetic");
    expect(cosmetic.sections.join("\n")).toContain(
      "Botox and Dysport consultations",
    );
    expect(medical.sections.join("\n")).toContain("## Skin Cancer and Mohs");
    expect(medical.sections.join("\n")).toContain(
      "Do not promise that a caller needs Mohs surgery",
    );
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
    const prompt = buildPrompt("+13523202007");
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
    const prompt = buildPrompt(SPRING_HILL_OFFICE_PHONE);
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
    const prompt = buildPrompt(SPRING_HILL_OFFICE_PHONE);

    expect(prompt).not.toContain(
      `is the number you're calling from a good one on file?`,
    );
    expect(prompt).not.toContain("Email is optional");
  });

  it("keeps Hollywood and Sweetwater off the Crystal River routing prompt block", () => {
    const hollywoodPrompt = buildPrompt(HOLLYWOOD_OFFICE_PHONE);
    const sweetwaterPrompt = buildPrompt(SWEETWATER_OFFICE_PHONE);
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
    expect(hollywoodKnowledge).toContain(
      "4330 Sheridan St, Suite 102B, Hollywood, FL 33021",
    );
    expect(hollywoodKnowledge).toContain(
      "12750 NW 17th St, #201, Miami, FL 33182",
    );
    expect(hollywoodKnowledge).toContain("Route to ophthalmology");
    expect(hollywoodKnowledge).toContain(
      "does not perform retina surgical care",
    );
    expect(hollywoodKnowledge).toContain("Katie is the licensed optician");
    expect(hollywoodKnowledge).toContain("@abitaeyegroup");
    expect(hollywoodKnowledge).toContain("Dr. Bach");
    expect(sweetwaterKnowledge).toContain("Abita Eye Group Sweetwater");
    expect(sweetwaterKnowledge).toContain("12750 NW 17th St, #201");
    expect(sweetwaterKnowledge).toContain(
      "4330 Sheridan St, Suite 102B, Hollywood, FL 33021",
    );
    expect(sweetwaterKnowledge).toContain("Route to ophthalmology");
    expect(sweetwaterKnowledge).toContain(
      "does not perform retina surgical care",
    );
    expect(sweetwaterKnowledge).toContain("Betty is the licensed optician");
    expect(sweetwaterKnowledge).toContain("@abitaeyegroup");
    expect(sweetwaterKnowledge).toContain("Dr. Maria Casas");
  });

  it("answers either office with both Hollywood and Sweetwater scheduling addresses", () => {
    for (const office of ["hollywood", "sweetwater"] as const) {
      const result = resolveOfficeKnowledge(
        office,
        "What are the Hollywood and Sweetwater office addresses?",
      );

      expect(result.sections.join("\n")).toContain(
        "4330 Sheridan St, Suite 102B, Hollywood, FL 33021",
      );
      expect(result.sections.join("\n")).toContain(
        "12750 NW 17th St, #201, Miami, FL 33182",
      );
    }
  });

  it("keeps North Miami Beach Optical knowledge limited to provided facts", () => {
    const prompt = buildPrompt(NORTH_MIAMI_BEACH_OPTICAL_OFFICE_PHONE);
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

  it("answers ordered-glasses readiness from text notification status", () => {
    for (const phone of [
      SPRING_HILL_OFFICE_PHONE,
      CRYSTAL_RIVER_OFFICE_PHONE,
      HOLLYWOOD_OFFICE_PHONE,
      NORTH_MIAMI_BEACH_OPTICAL_OFFICE_PHONE,
      ...SWEETWATER_TRUNK_PHONES,
    ]) {
      expect(buildPrompt(phone)).toContain(GLASSES_READY_ANSWER);
    }

    expect(create_staff_task.description).toContain(
      "Do not use for a simple glasses-readiness check",
    );
  });

  it("keeps universal glasses-readiness policy out of office knowledge", () => {
    for (const officeKey of [
      "spring-hill",
      "crystal-river",
      "hollywood",
      "sweetwater",
      "north-miami-beach-optical",
    ] as const) {
      expect(
        resolveOfficeKnowledge(officeKey, "Are my glasses ready?"),
      ).toMatchObject({ outcome: "skipped" });
    }

    expect(
      resolveOfficeKnowledge("dev", "Are my glasses ready?"),
    ).toMatchObject({ outcome: "skipped" });
  });

  it("does not expose a standalone turn context recorder", () => {
    expect(toolNamesForTrunk(SPRING_HILL_OFFICE_PHONE)).not.toContain(
      "record_turn_context",
    );
  });

  it("exposes the LiveKit-native end call tool", () => {
    expect(toolNamesForTrunk(SPRING_HILL_OFFICE_PHONE)).toContain("end_call");
  });

  it("does not expose a standalone current date/time tool", () => {
    expect(toolNamesForTrunk(SPRING_HILL_OFFICE_PHONE)).not.toContain(
      "get_current_datetime",
    );
  });

  it("keeps emergency transfer policy in the shared role prompt", () => {
    const prompt = buildPrompt(HOLLYWOOD_OFFICE_PHONE);

    expect(prompt).toContain("urgent symptoms");
    expect(prompt).toContain(
      "callers returning a missed or received call from this number",
    );
    expect(prompt).toContain("Do not promise a callback time or outcome");
    expect(prompt).not.toContain("suspected medication reactions");
    expect(transfer_call.description).toContain(
      "suspected medication reactions",
    );
    expect(prompt).not.toContain("create_staff_task");
    expect(prompt).not.toContain("<office_policy>");
  });

  it("keeps staff-task tool policy out of static system prompts", () => {
    for (const phone of [
      SPRING_HILL_OFFICE_PHONE,
      SPRING_HILL_813_TRUNK_PHONE,
      CRYSTAL_RIVER_OFFICE_PHONE,
      DEV_OFFICE_PHONE,
      HOLLYWOOD_OFFICE_PHONE,
      NORTH_MIAMI_BEACH_OPTICAL_OFFICE_PHONE,
      ...SWEETWATER_TRUNK_PHONES,
    ]) {
      const prompt = buildPrompt(phone);

      expect(prompt).not.toContain("create_staff_task");
      expect(prompt.toLowerCase()).not.toContain("staff task");
      expect(prompt).not.toContain("# Staff Tasks");
      expect(prompt).not.toContain("<office_policy>");
    }
  });

  it("keeps concise voice guidance in the base voice prompt", () => {
    const prompt = buildPrompt(SPRING_HILL_OFFICE_PHONE);

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

  it("accepts only office configuration and contains no per-call lookup data", () => {
    const prompt = buildPrompt(HOLLYWOOD_OFFICE_PHONE);

    expect(buildPrompt.length).toBe(1);
    expect(prompt).not.toContain("<pre_call_context>");
    expect(prompt).not.toContain("<caller_identity_hint>");
    expect(prompt).not.toContain("Santos");
    expect(prompt).not.toContain("patient-1");
    expect(prompt).not.toContain("01/01/1980");
    expect(prompt).not.toContain("Aetna");
    expect(prompt).not.toContain("2099-01-01");
    expect(prompt).not.toContain("IVETTE");
    expect(prompt).not.toContain("KAELI");
    expect(prompt).not.toContain("private-cancellation-token");
  });
});

describe("model-facing tool definitions", () => {
  it("keeps add_patient focused on new-patient chart creation", () => {
    expect(add_patient.description).toContain(
      "Create a chart for a confirmed new patient",
    );
    expect(add_patient.description).toContain(
      "an accepted check_insurance result",
    );
    expect(add_patient.description).toContain(
      "Read back the registration details and get caller confirmation",
    );
    expect(add_patient.description).toContain(
      "For routine-vision registration, collect only the patient's SSN last four",
    );
    expect(add_patient.description).toContain(
      "confirm it is a good callback number",
    );
    expect(add_patient.description).toContain(
      "set inboundPhoneConfirmed to true",
    );
    expect(add_patient.description).toContain("Never offer self pay");

    const parameters = add_patient.parameters as {
      safeParse: (value: unknown) => { success: boolean };
      shape: Record<string, unknown>;
    };
    expect(Object.keys(parameters.shape)).not.toContain("insurance");
    expect(Object.keys(parameters.shape)).not.toContain("appointmentLane");
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
      "Last 4 digits of the patient's Social Security number. Collect for routine-vision registration; do not ask for the full SSN.",
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
        subscriberName: "Jane Doe",
        insuranceMemberId: "ABC123",
        ssnLast4: "12345",
      }).success,
    ).toBe(false);
  });

  it("keeps availability from exposing Bach-only routing internals", () => {
    expect(get_availability.description).toContain(
      "caller's own date and time words",
    );
    expect(get_availability.description).toContain(
      "Pass those words unchanged in when",
    );
    expect(get_availability.description).toContain(
      "search from the earliest allowed date",
    );
    expect(get_availability.description).toContain(
      "routine exam caller also mentions an eye problem or symptom",
    );
    expect(get_availability.description).toContain(
      "ask whether the appointment is mainly for glasses or contacts or for the eye problem",
    );
    expect(get_availability.description).toContain(
      "Offer only the returned slots",
    );
    expect(get_availability.description).not.toContain("bach_only routing");
    expect(get_availability.description).not.toContain(
      "Under 18 medical visits = Dr. Bach only",
    );

    const parameters = get_availability.parameters as {
      safeParse: (value: unknown) => { success: boolean };
      shape: {
        appointmentLane: { description?: string };
        office: { description?: string };
        when: { description?: string };
      };
    };
    expect(parameters.shape.appointmentLane.description).toContain(
      "medical_md",
    );
    expect(parameters.shape.appointmentLane.description).toContain(
      "routine_od",
    );
    expect(parameters.shape.office.description).toContain(
      "Hollywood and Sweetwater calls",
    );
    expect(parameters.shape.office.description).toContain(
      "Do not infer it from the number called",
    );
    expect(parameters.shape.when.description).toContain(
      "caller's own date and time phrase",
    );
    expect(parameters.shape.when.description).toContain(
      "without converting it",
    );
    expect(
      parameters.safeParse({
        when: "next Tuesday around 3 PM",
        appointmentLane: "medical_md",
        office: "hollywood",
      }).success,
    ).toBe(true);
    expect(
      parameters.safeParse({
        when: "tomorrow morning",
        appointmentLane: "medical_md",
        office: "sweetwater",
      }).success,
    ).toBe(true);
    expect(
      parameters.safeParse({
        when: "tomorrow",
        appointmentLane: "medical_md",
        office: "spring-hill",
      }).success,
    ).toBe(false);
    expect(
      parameters.safeParse({
        when: "tomorrow",
        appointmentLane: "medical_md",
        timePreference: "evening",
      }).success,
    ).toBe(false);
    expect(
      parameters.safeParse({
        date: "2026-06-01",
        appointmentLane: "medical_md",
        timePreference: "none",
      }).success,
    ).toBe(false);
    expect(
      parameters.safeParse({
        when: "June 1",
        appointmentLane: "routine_od",
      }).success,
    ).toBe(true);
    expect(
      parameters.safeParse({
        when: "June 1",
        appointmentLane: "unknown",
      }).success,
    ).toBe(false);
    expect(
      parameters.safeParse({
        date: "2026-06-01",
        appointmentLane: "medical_md",
      }).success,
    ).toBe(false);
    expect(
      parameters.safeParse({
        when: "next Wednesday",
        date: "2026-06-01",
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
    expect(transfer_call.description).toContain(
      "safe non-live office follow-up that another available tool can capture",
    );
    expect(transfer_call.description).not.toContain("create_staff_task");
    expect(transfer_call.description).not.toContain("staff task");
    expect(transfer_call.description).not.toContain("tool speaks");
    expect(transfer_call.description).toContain("Do not call for scheduling");
    expect(transfer_call.description).not.toContain("Spring Hill routing");
  });

  it("keeps staff task capture scoped to safe non-live work", () => {
    expect(create_staff_task.description).not.toContain("Spring Hill");
    expect(create_staff_task.description).toContain(
      "safe asynchronous office work",
    );
    expect(create_staff_task.description).toContain("returned calls");
    expect(create_staff_task.description).toContain(
      "suspected medication reactions",
    );
    expect(create_staff_task.description).toContain("transfer instead");
    const taskParameters = create_staff_task.parameters as {
      shape: {
        category: { description?: string };
        urgency: { description?: string };
        summary: { description?: string };
        message: { description?: string };
      };
    };
    expect(taskParameters.shape.category.description).toContain(
      "medication for routine prescription work",
    );
    expect(taskParameters.shape.category.description).toContain(
      "optical for glasses, contacts, lab jobs, or optical orders",
    );
    expect(taskParameters.shape.category.description).toContain(
      "referrals for referral coordination",
    );
    expect(taskParameters.shape.urgency.description).toContain(
      "high_priority for time-sensitive non-clinical work",
    );
    expect(taskParameters.shape.urgency.description).toContain(
      "normal for standard follow-up",
    );
    expect(taskParameters.shape.urgency.description).toContain(
      "non_urgent for work with no time sensitivity",
    );
    expect(taskParameters.shape.summary.description).toContain(
      "Short staff inbox title",
    );
    expect(taskParameters.shape.message.description).toContain(
      "For medication include the name, requested action, and pharmacy",
    );
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
        category: "medication",
        urgency: "normal",
        summary: "Caller needs a medication refill reviewed.",
        message:
          "The caller needs staff to review a refill request and provided the medication and pharmacy.",
      }).success,
    ).toBe(true);
    for (const category of ["optical", "referrals"]) {
      expect(
        create_staff_task.parameters.safeParse({
          category,
          urgency: "normal",
          summary: "Caller needs staff follow-up.",
          message:
            "The caller provided the information staff needs to follow up.",
        }).success,
      ).toBe(true);
    }
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
      "Pass the matching appointmentRef",
    );
    expect(cancel_appointment.description).toContain(
      "Do not pass backend patient IDs or appointment IDs",
    );
    expect(cancel_appointment.description).toContain(
      "Do not pass appointment dates or times",
    );
    expect(cancel_appointment.description).not.toContain(
      "For reschedules, book the new appointment",
    );

    const parameters = cancel_appointment.parameters as {
      safeParse: (value: unknown) => { success: boolean };
      shape: Record<string, unknown>;
    };
    expect(Object.keys(parameters.shape)).toEqual(["appointmentRef"]);
    expect(parameters.safeParse({ appointmentId: 123 }).success).toBe(false);
    expect(
      parameters.safeParse({ appointmentRef: "appointment-abc123" }).success,
    ).toBe(true);
    expect(
      parameters.safeParse({
        appointmentRef: "appointment-abc123",
        appointmentDate: "June 2",
        appointmentTime: "9 AM",
      }).success,
    ).toBe(false);
    expect(parameters.safeParse({ appointmentRef: " " }).success).toBe(false);
    expect(parameters.safeParse({}).success).toBe(false);
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
      "Book a caller-confirmed new appointment",
    );
    expect(book_appointment.description).toContain(
      "do not use for reschedules",
    );
    expect(book_appointment.description).toContain(
      "provides a referring doctor or says they have none",
    );
    expect(book_appointment.description).toContain(
      "Only after this tool returns a successful booking may you tell the caller they are booked, scheduled, or all set",
    );
    expect(book_appointment.description).toContain(
      "if the caller asks whether they will receive confirmation, say yes, a confirmation email will be sent",
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
    expect(resolve_patient.description).toContain(
      "Use this tool to switch to a different patient using caller-provided identity details",
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
