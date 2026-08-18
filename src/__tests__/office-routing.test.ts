import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isToolset, type ToolContextEntry } from "@livekit/agents";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
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
  "Check your texts. A readiness text confirms your glasses are ready for pickup. Please wait for that text before coming in.";

function toolNames(entries: readonly ToolContextEntry[]): string[] {
  return entries.flatMap((entry) =>
    isToolset(entry) ? toolNames(entry.tools) : [entry.id],
  );
}

function toolNamesForTrunk(trunkPhone: string): string[] {
  return toolNames(buildToolsForTrunk(trunkPhone));
}

function toolForTrunk(trunkPhone: string, name: string) {
  return buildToolsForTrunk(trunkPhone)
    .flatMap((entry) => (isToolset(entry) ? entry.tools : [entry]))
    .find((entry) => entry.id === name);
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

  it("selects staff task delivery from the inbound Office Profile", () => {
    for (const phone of [
      SPRING_HILL_OFFICE_PHONE,
      SPRING_HILL_813_TRUNK_PHONE,
      HOLLYWOOD_OFFICE_PHONE,
      NORTH_MIAMI_BEACH_OPTICAL_OFFICE_PHONE,
      ...SWEETWATER_TRUNK_PHONES,
    ]) {
      expect(toolNamesForTrunk(phone)).toContain("create_staff_task");
    }

    expect(toolNamesForTrunk(DEV_OFFICE_PHONE)).toContain("create_staff_task");
    expect(getOfficeProfile("spring-hill").staffTaskEnabled).toBe(true);
    expect(getOfficeProfile("dev").staffTaskEnabled).toBe(true);
  });

  it("keeps Crystal River transfer-only", () => {
    expect(toolNamesForTrunk(CRYSTAL_RIVER_OFFICE_PHONE)).not.toContain(
      "create_staff_task",
    );
    expect(toolNamesForTrunk(CRYSTAL_RIVER_OFFICE_PHONE)).toContain(
      "transfer_call",
    );
    expect(getOfficeProfile("crystal-river").staffTaskEnabled).toBe(false);
  });

  it("makes availability office selection match the inbound trunk", () => {
    const hollywood = toolForTrunk(HOLLYWOOD_OFFICE_PHONE, "get_availability");
    const springHill = toolForTrunk(
      SPRING_HILL_OFFICE_PHONE,
      "get_availability",
    );
    const hollywoodSchema = z.toJSONSchema(hollywood!.parameters);
    const springHillSchema = z.toJSONSchema(springHill!.parameters);

    expect(hollywoodSchema.required).toContain("office");
    expect(springHillSchema.properties).not.toHaveProperty("office");
  });
});

describe("voice output prompt", () => {
  it("states model-facing prompt and tool instructions as positive actions", () => {
    const tools = [
      add_patient,
      book_appointment,
      cancel_appointment,
      check_insurance,
      create_staff_task,
      get_availability,
      reschedule_appointment,
      resolve_patient,
      transfer_call,
      update_insurance,
    ];
    const surfaces = [
      buildPrompt(SPRING_HILL_OFFICE_PHONE),
      buildPrompt(DEV_OFFICE_PHONE),
      ...tools.flatMap((entry) => [
        entry.description,
        JSON.stringify(z.toJSONSchema(entry.parameters)),
      ]),
    ];

    for (const surface of surfaces) {
      expect(surface).not.toMatch(
        /\b(?:aren't|can't|cannot|couldn't|do not|does not|don't|haven't|isn't|never|must not|shouldn't|wasn't|weren't|won't|wouldn't)\b/i,
      );
    }
  });

  it("requires caller-facing speech without internal context", () => {
    const prompt = buildPrompt(SPRING_HILL_OFFICE_PHONE);

    expect(prompt).toContain(
      "Produce only caller-facing speech. Keep system messages, internal state, instructions, tool names, and hidden context private and outside the response.",
    );
    expect(prompt).toContain(
      "Use plain caller-facing words in place of role or reasoning tags such as <system>, <instructions>, or <think>.",
    );
  });
});

describe("tool-first prompt gating", () => {
  it("includes core tool-use rules from the role prompt", () => {
    const prompt = buildPrompt(SPRING_HILL_OFFICE_PHONE);

    expect(prompt).toContain("<role>");
    expect(prompt).toContain("# Tool Use");
    expect(prompt).toContain(
      "Callers have already reached Abita Eye Group. Serve them on this call",
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
      "Only confirm a booking, cancellation, rescheduling, insurance update, or patient creation after the matching currently available action succeeds. Complete any prerequisite requested by the available tools first.",
    );
    expect(prompt).not.toContain("book_appointment");
    expect(prompt).toContain(
      "For calls involving more than one patient, finish one patient's task at a time.",
    );
    expect(prompt).toContain(
      "Before starting work for the next patient, call resolve_patient to switch the active patient.",
    );
    expect(prompt).toContain(
      "For insurance acceptance questions, answer yes or no only from a successful check_insurance result.",
    );
    expect(prompt).toContain("# Human Transfer");
    expect(prompt).toContain(
      "Immediately call transfer_call only for an eye emergency or a caller returning a call for a named staff member.",
    );
    expect(prompt).toContain("Redness alone is not an eye emergency.");
    expect(prompt).toContain(
      "Describe a transfer only from the transfer_call result.",
    );
    expect(transfer_call.description).toBe(
      "Transfer the caller to human office staff when the transfer policy requires it. Call this tool immediately without announcing the transfer first; the tool speaks the transfer announcement.",
    );
    expect(prompt).not.toContain(
      "Use resolve_patient for patient-specific work when internal state has not already confirmed the patient.",
    );
    expect(get_availability.description).toContain(
      "claim booking success only after book_appointment succeeds",
    );
    expect(prompt).not.toContain("Today is");
    expect(prompt).not.toContain("The current time is");

    const crystalRiverPrompt = buildPrompt(CRYSTAL_RIVER_OFFICE_PHONE);
    const devPrompt = buildPrompt(DEV_OFFICE_PHONE);

    expect(crystalRiverPrompt).toContain("# Tool Use");
    expect(devPrompt).not.toContain("book_appointment");

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

  it("makes purpose-based appointment triage a core responsibility", () => {
    for (const phone of [
      SPRING_HILL_OFFICE_PHONE,
      SPRING_HILL_813_TRUNK_PHONE,
      CRYSTAL_RIVER_OFFICE_PHONE,
      HOLLYWOOD_OFFICE_PHONE,
      NORTH_MIAMI_BEACH_OPTICAL_OFFICE_PHONE,
      ...SWEETWATER_TRUNK_PHONES,
    ]) {
      const prompt = buildPrompt(phone);

      expect(prompt).toContain("# Appointment Triage");
      expect(prompt).toContain(
        "Before checking availability for a new appointment, understand why the patient is coming in",
      );
      expect(prompt).toContain(
        "Use medical when the patient needs medical eye care from an ophthalmologist, including a current eye problem, symptom, condition, post-operative concern, or medical evaluation.",
      );
      expect(prompt).toContain(
        "Use routine_vision when the patient's purpose is limited to routine vision care from an optometrist for glasses, contacts, prescription updates, fittings, or a routine vision exam.",
      );
      expect(prompt).not.toContain("alone do not determine the visit type");
      expect(prompt).toContain(
        'ask exactly: "Is this for an eye problem or symptom that needs an ophthalmologist, or for routine vision care with an optometrist for glasses or contacts?"',
      );
      expect(prompt).not.toContain("referral");
      expect(prompt).toContain(
        "Leave diagnosis to clinical staff and classify only the scheduling purpose.",
      );
    }
  });

  it("keeps identity and privacy policy in the static prompt", () => {
    const prompt = buildPrompt(SPRING_HILL_OFFICE_PHONE);

    expect(prompt).toContain("# Patient Identity");
    expect(prompt).toContain(
      "Ask for patient identity only when the caller requests patient-specific work and no patient is active.",
    );
    expect(prompt).toContain(
      'Ask once: "To help with that, could you spell the patient\'s first name?"',
    );
    expect(prompt).toContain(
      "If no patient becomes active, collect the patient's full name and date of birth, then call resolve_patient.",
    );
    expect(prompt).not.toContain("<caller_identity_hint>");
    expect(prompt).not.toContain("middleware_error");
    expect(prompt).not.toContain("+17275551212");
  });

  it("requires a reason and supported help before an avoidable transfer", () => {
    const prompt = buildPrompt(HOLLYWOOD_OFFICE_PHONE);

    expect(prompt).toContain(
      "For any other request for a person, the front desk, or a transfer, require a reason.",
    );
    expect(prompt).toContain(
      'Ask: "What do you need help with? I may be able to handle it here or send it to the team."',
    );
    expect(prompt).toContain(
      'If the caller repeats the request without a reason, say: "I need a brief reason to route this correctly.',
    );
    expect(prompt).toContain(
      "If the caller refuses both reason questions, or declines the supported path, and still explicitly insists, call transfer_call.",
    );
    expect(prompt).toContain(
      "A successful create_staff_task completes that issue.",
    );
  });
});

describe("rheumatology demo", () => {
  it("uses a fictional rheumatology identity and safe medication workflow", () => {
    const prompt = buildPrompt(DEV_OFFICE_PHONE);

    expect(prompt).toContain("You are Julia");
    expect(prompt).toContain("fictional rheumatology practice");
    expect(prompt).toContain("Rheumatology includes");
    expect(prompt).toContain("visitType medical");
    expect(prompt).toContain(
      "Help callers book returned medical appointment slots for rheumatology care",
    );
    expect(prompt).toContain(
      "Use check_insurance for rheumatology insurance acceptance.",
    );
    expect(prompt).toContain(
      "For a routine refill, pharmacy change, medication prior authorization, or prescription-status request",
    );
    expect(prompt).toContain(
      "If the caller asks what they personally should start, stop, hold, combine, or change",
    );
    expect(prompt).toContain(
      "Immediately call transfer_call for clinical medication guidance",
    );
    expect(prompt).toContain(
      "Answer general medication education only from the current office knowledge supplied for that reply",
    );
    expect(prompt).toContain(
      "A caller describing symptoms only as the reason for an appointment stays in the scheduling workflow",
    );
    expect(prompt).toContain(
      "Medication requests and caller-reported list corrections can be sent with no active patient in this demo",
    );
    expect(prompt).toContain(
      "Call create_staff_task directly; skip resolve_patient for this demo workflow",
    );
    expect(prompt).toContain(
      "After the supported transfer retry fails for a safe, non-urgent clinical medication question",
    );
    expect(prompt).toContain("# Human Transfer");
    expect(prompt).toContain(
      "Describe a transfer only from the transfer_call result.",
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
    expect(prompt).not.toContain("dermatology");
    expect(prompt).not.toContain("glasses");
    expect(prompt).not.toContain("contact lenses");
  });

  it("keeps the complete demo tool surface specialty-neutral", () => {
    const availability = toolForTrunk(DEV_OFFICE_PHONE, "get_availability");
    const booking = toolForTrunk(DEV_OFFICE_PHONE, "book_appointment");
    const insurance = toolForTrunk(DEV_OFFICE_PHONE, "check_insurance");
    const staffTask = toolForTrunk(DEV_OFFICE_PHONE, "create_staff_task");
    const availabilitySchema = z.toJSONSchema(availability!.parameters) as {
      properties: { visitType: { enum?: string[]; description?: string } };
    };
    const bookingSchema = z.toJSONSchema(booking!.parameters) as {
      properties: { appointmentReason: { description?: string } };
    };
    const insuranceSchema = z.toJSONSchema(insurance!.parameters) as {
      properties: { coverageType: { enum?: string[]; description?: string } };
    };
    const staffTaskSchema = z.toJSONSchema(staffTask!.parameters) as {
      properties: {
        category: { enum?: string[]; description?: string };
        message: { description?: string };
      };
    };

    expect(bookingSchema.properties.appointmentReason.description).not.toMatch(
      /eye|vision|glasses|optical/i,
    );
    expect(availabilitySchema.properties.visitType.enum).toEqual(["medical"]);
    expect(availabilitySchema.properties.visitType.description).not.toContain(
      "routine_vision",
    );
    expect(availability!.description).not.toContain("routine_vision");
    expect(insuranceSchema.properties.coverageType.enum).toEqual(["medical"]);
    expect(insuranceSchema.properties.coverageType.description).not.toContain(
      "routine_vision",
    );
    expect(staffTask!.description).not.toMatch(/glasses|optical/i);
    expect(staffTask!.description).toContain(
      "After the supported transfer retry fails for a safe, non-urgent clinical medication question",
    );
    expect(staffTaskSchema.properties.category.enum).not.toContain("optical");
    expect(staffTaskSchema.properties.category.description).toContain(
      "medication for refills, pharmacy changes, prescription status, medication prior authorization",
    );
    expect(staffTaskSchema.properties.message.description).toContain(
      "strength and directions exactly as stated",
    );
  });

  it("exposes the demo transfer and staff-task tools", () => {
    const names = toolNamesForTrunk(DEV_OFFICE_PHONE);

    expect(names).toContain("check_insurance");
    expect(names).toContain("get_availability");
    expect(names).toContain("book_appointment");
    expect(names).toContain("end_call");
    expect(names).toContain("transfer_call");
    expect(names).toContain("create_staff_task");
  });

  it("honors the isolated demo handoff override", () => {
    process.env.DEV_HANDOFF_TARGET = "sip:demo@example.test";
    expect(getOfficeProfile("dev").handoff()).toEqual({
      mode: "product-with-phone-fallback",
      target: "sip:demo@example.test",
    });
  });

  it("retrieves rheumatology knowledge for conditions and infusions", () => {
    const condition = resolveOfficeKnowledge("dev", "Do you treat lupus?");
    const infusion = resolveOfficeKnowledge("dev", "Do you offer infusions?");

    expect(condition.sections.join("\n")).toContain("## Scope of Services");
    expect(condition.sections.join("\n")).toContain(
      "rheumatoid arthritis, osteoarthritis, lupus",
    );
    expect(infusion.sections.join("\n")).toContain("## Scope of Services");
    expect(infusion.sections.join("\n")).toContain(
      "Infusions, injections, and procedure visits require clinical review",
    );
  });

  it("retrieves approved general medication education", () => {
    const medication = resolveOfficeKnowledge(
      "dev",
      "What is methotrexate and why are labs needed?",
    );

    expect(medication).toMatchObject({
      outcome: "matched",
      topic: "medications",
    });
    expect(medication.sections.join("\n")).toContain(
      "Methotrexate is a conventional disease-modifying antirheumatic drug",
    );
    expect(medication.sections.join("\n")).toContain(
      "general education rather than personal medication advice",
    );

    const combination = resolveOfficeKnowledge(
      "dev",
      "Can rheumatology medications be combined?",
    );
    expect(combination).toMatchObject({
      outcome: "matched",
      topic: "medications",
    });
    expect(combination.sections.join("\n")).toContain(
      "Some rheumatology treatment plans combine medicines",
    );
    expect(combination.sections.join("\n")).toContain(
      "A clinician may consider holding a medication",
    );
    expect(
      resolveOfficeKnowledge(
        "spring-hill",
        "What is methotrexate and why are labs needed?",
      ),
    ).toMatchObject({ outcome: "skipped", topic: null });
  });

  it("keeps the active knowledge base fictional and preserves dermatology", () => {
    const knowledge = readFileSync(
      join(
        import.meta.dirname,
        "..",
        "..",
        "workspace",
        "KNOWLEDGE_RHEUM_DEMO.md",
      ),
      "utf-8",
    );
    const preservedDermatology = readFileSync(
      join(
        import.meta.dirname,
        "..",
        "..",
        "workspace",
        "KNOWLEDGE_DERM_DEMO.md",
      ),
      "utf-8",
    );
    const preservedDermatologyRole = readFileSync(
      join(import.meta.dirname, "..", "..", "workspace", "SOUL_DERM_DEMO.md"),
      "utf-8",
    );

    expect(knowledge).toContain(
      "fictional practice created for product demonstrations",
    );
    expect(knowledge).toContain("rheumatoid arthritis");
    expect(knowledge).toContain(
      "Clinical staff maintains and verifies each patient's current medication list",
    );
    expect(knowledge).not.toContain("Abita");
    expect(knowledge).not.toContain("acrmed.com");
    expect(preservedDermatology).toContain(
      "Harborleaf Dermatology & Aesthetics is a fictional practice created for product demonstrations",
    );
    expect(preservedDermatology).toContain("medical dermatology");
    expect(preservedDermatologyRole).toContain("# Harborleaf Dermatology Demo");
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
      "does not see pediatric ophthalmology",
    );
    expect(crystalRiverKnowledge).toContain("cataract evaluations");
    expect(crystalRiverKnowledge).toContain(
      "Crystal River can schedule the in-office evaluation when appropriate",
    );
    expect(crystalRiverKnowledge).toContain(
      "Present only the tests, procedures, and specialty services explicitly listed here; route other availability questions to staff",
    );
    expect(crystalRiverKnowledge).not.toContain(
      "does **not** schedule cataract evaluations",
    );
    expect(crystalRiverKnowledge).not.toContain(
      "does **not** schedule cataract surgery workups",
    );
    expect(crystalRiverKnowledge).not.toContain("coordinates with Spring Hill");
    expect(crystalRiverKnowledge).toContain(
      "does not schedule routine-vision exams, glasses prescriptions, or contact lens prescriptions",
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
    expect(springHillKnowledge).not.toContain("Social Security");
    expect(springHillKnowledge).not.toContain("SSN");
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
    expect(hollywoodKnowledge).not.toContain("Use the medical visit type");
    expect(hollywoodKnowledge).not.toContain(
      "Use the routine vision visit type",
    );
    expect(hollywoodKnowledge).not.toContain("Route to ophthalmology");
    expect(hollywoodKnowledge).not.toContain("Route to optometry");
    expect(hollywoodKnowledge).toContain(
      "Routine-vision appointments cover routine eye exams",
    );
    expect(hollywoodKnowledge).not.toContain("optometry lane");
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
    expect(sweetwaterKnowledge).not.toContain("Use the medical visit type");
    expect(sweetwaterKnowledge).not.toContain(
      "Use the routine vision visit type",
    );
    expect(sweetwaterKnowledge).not.toContain("Route to ophthalmology");
    expect(sweetwaterKnowledge).not.toContain("Route to optometry");
    expect(sweetwaterKnowledge).toContain(
      "Routine-vision appointments cover routine eye exams",
    );
    expect(sweetwaterKnowledge).not.toContain("optometry lane");
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
    expect(knowledge).toContain("Name only the providers listed here");
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
      "Use the glasses-readiness text policy for glasses status",
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

  it("keeps human transfer policy in the shared role prompt", () => {
    const prompt = buildPrompt(HOLLYWOOD_OFFICE_PHONE);

    expect(prompt).toContain("# Human Transfer");
    expect(prompt).toContain("sudden vision loss or a sudden change in vision");
    expect(prompt).toContain(
      "a known or suspected retinal detachment, including new flashes or floaters or a curtain, veil, or shadow in vision",
    );
    expect(prompt).toContain("eye trauma or chemical exposure");
    expect(prompt).toContain(
      "severe eye pain with sudden blurred vision, halos, nausea, or vomiting",
    );
    expect(prompt).toContain("Redness alone is not an eye emergency");
    expect(prompt).toContain("returning a call for a named staff member");
    expect(prompt).toContain(
      "Describe callbacks as staff follow-up requests with timing and outcomes left open",
    );
    expect(prompt).not.toContain(
      "is returning a missed or received call from this number",
    );
    expect(prompt).not.toContain("reports emergency or urgent symptoms");
    expect(prompt).not.toContain(
      "supported workflow or Staff Task that failed",
    );
    expect(prompt).toContain("create_staff_task");
    expect(prompt).not.toContain("<office_policy>");
  });

  it("keeps create_staff_task policy capability-aware in static prompts", () => {
    for (const phone of [
      SPRING_HILL_OFFICE_PHONE,
      SPRING_HILL_813_TRUNK_PHONE,
      CRYSTAL_RIVER_OFFICE_PHONE,
      HOLLYWOOD_OFFICE_PHONE,
      NORTH_MIAMI_BEACH_OPTICAL_OFFICE_PHONE,
      ...SWEETWATER_TRUNK_PHONES,
    ]) {
      const prompt = buildPrompt(phone);

      expect(prompt).toContain(
        "Once the reason is known, use the available tools or offer create_staff_task for safe, non-urgent follow-up.",
      );
      expect(prompt.toLowerCase()).not.toContain("staff task");
      expect(prompt).not.toContain("# Staff Tasks");
      expect(prompt).not.toContain("<office_policy>");
    }

    expect(buildPrompt(DEV_OFFICE_PHONE)).toContain("create_staff_task");
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
      "Create a chart after the caller explicitly confirms this is the patient's first registration",
    );
    expect(add_patient.description).toContain(
      "an accepted check_insurance result",
    );
    expect(add_patient.description).toContain(
      "Read back the registration details and get caller confirmation",
    );
    expect(add_patient.description).toContain(
      "call add_patient directly with newPatientConfirmed true",
    );
    expect(add_patient.description).toContain(
      "For insured routine-vision registration, ask once for the patient's SSN last four",
    );
    expect(add_patient.description).toContain(
      "Continue without it if declined or unavailable",
    );
    expect(add_patient.description).toContain(
      "Request only the last four digits",
    );
    expect(add_patient.description).toContain(
      "Skip SSN collection for self pay",
    );
    expect(add_patient.description).toContain(
      "confirm it is a good callback number",
    );
    expect(add_patient.description).toContain(
      "set inboundPhoneConfirmed to true",
    );
    expect(add_patient.description).toContain(
      'Use "self pay" as insuranceMemberId only when the patient asks for self pay',
    );

    const parameters = add_patient.parameters as {
      safeParse: (value: unknown) => { success: boolean };
      shape: Record<string, unknown>;
    };
    expect(Object.keys(parameters.shape)).not.toContain("insurance");
    expect(Object.keys(parameters.shape)).not.toContain("appointmentLane");
    expect(Object.keys(parameters.shape)).toContain("insuranceMemberId");
    expect(Object.keys(parameters.shape)).toContain("newPatientConfirmed");
    expect(Object.keys(parameters.shape)).toContain("ssnLast4");
    expect(Object.keys(parameters.shape)).not.toContain("ssnLast4Unavailable");
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
      "Optional. Exactly the last 4 digits of the patient's Social Security number for insured routine-vision registration. Request only the last four digits.",
    );
    expect(
      String(
        (parameters.shape.ssnLast4 as { description?: string }).description,
      ),
    ).toContain("Optional");
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

  it("keeps availability execution tied to core appointment triage", () => {
    expect(get_availability.description).toContain(
      "caller's own date and time words",
    );
    expect(get_availability.description).toContain(
      "Pass those words verbatim in when",
    );
    expect(get_availability.description).toContain(
      "search from the earliest allowed date",
    );
    expect(get_availability.description).toContain(
      "appointment triage has established the visit type",
    );
    expect(get_availability.description).toContain(
      "Offer only the returned slots",
    );
    expect(get_availability.description).not.toContain("appointmentLane");
    expect(get_availability.description).not.toContain("bach_only routing");
    expect(get_availability.description).not.toContain(
      "Under 18 medical visits = Dr. Bach only",
    );

    const parameters = get_availability.parameters as {
      safeParse: (value: unknown) => { success: boolean };
      shape: {
        oldAppointmentRef: { description?: string };
        office: { description?: string };
        visitType: { description?: string };
        when: { description?: string };
      };
    };
    expect(parameters.shape.visitType.description).toContain(
      "Visit type established by appointment triage",
    );
    expect(parameters.shape.oldAppointmentRef.description).toContain(
      "exact loaded appointment",
    );
    expect(parameters.shape.office.description).toContain(
      "Hollywood and Sweetwater calls",
    );
    expect(parameters.shape.office.description).toContain(
      "Use the caller's answer as the office value",
    );
    expect(parameters.shape.when.description).toContain(
      "caller's own date and time phrase",
    );
    expect(parameters.shape.when.description).toContain("forwarded verbatim");
    expect(Object.keys(parameters.shape)).toEqual([
      "when",
      "visitType",
      "oldAppointmentRef",
      "office",
    ]);
    expect(
      parameters.safeParse({
        when: "next Tuesday around 3 PM",
        visitType: "medical",
        office: "hollywood",
      }).success,
    ).toBe(true);
    expect(
      parameters.safeParse({
        when: "next Tuesday around 3 PM",
        oldAppointmentRef: "appointment-loaded",
        office: "hollywood",
      }).success,
    ).toBe(true);
    expect(
      parameters.safeParse({
        when: "tomorrow morning",
        visitType: "medical",
        office: "sweetwater",
      }).success,
    ).toBe(true);
    expect(
      parameters.safeParse({
        when: "tomorrow",
        visitType: "medical",
        office: "spring-hill",
      }).success,
    ).toBe(false);
    expect(
      parameters.safeParse({
        when: "tomorrow",
        visitType: "medical",
        timePreference: "evening",
      }).success,
    ).toBe(false);
    expect(
      parameters.safeParse({
        date: "2026-06-01",
        visitType: "medical",
        timePreference: "none",
      }).success,
    ).toBe(false);
    expect(
      parameters.safeParse({
        when: "June 1",
        visitType: "routine_vision",
      }).success,
    ).toBe(true);
    expect(
      parameters.safeParse({
        when: "June 1",
        visitType: "unknown",
      }).success,
    ).toBe(false);
    expect(
      parameters.safeParse({
        date: "2026-06-01",
        visitType: "medical",
      }).success,
    ).toBe(false);
    expect(
      parameters.safeParse({
        when: "next Wednesday",
        date: "2026-06-01",
        visitType: "medical",
      }).success,
    ).toBe(false);
    expect(
      parameters.safeParse({
        when: "next Wednesday",
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
      "after you know the plan name and visit type",
    );
    expect(check_insurance.description).toContain(
      "quick insurance acceptance questions",
    );
    expect(check_insurance.description).toContain(
      "wait for a more specific plan or coverage type before the next check_insurance call",
    );
    expect(check_insurance.description).toContain(
      "If the result says needs_staff_task, follow its instructions to create a staff task for prior authorization instead of transferring",
    );
    expect(check_insurance.description).not.toContain(
      "If the result says needs_transfer",
    );
    expect(check_insurance.description).not.toContain("speech-ready");
    expect(check_insurance.description).not.toContain("routeTool");

    const parameters = check_insurance.parameters as {
      safeParse: (value: unknown) => { success: boolean };
      shape: {
        coverageType: { description?: string };
      };
    };
    expect(parameters.shape.coverageType.description).toContain(
      "Visit type established by appointment triage",
    );
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
    expect(transfer_call.description).toBe(
      "Transfer the caller to human office staff when the transfer policy requires it. Call this tool immediately without announcing the transfer first; the tool speaks the transfer announcement.",
    );
  });

  it("keeps staff task capture scoped to safe non-live work", () => {
    expect(create_staff_task.description).not.toContain("Spring Hill");
    expect(create_staff_task.description).toContain(
      "safe, non-urgent office work",
    );
    expect(create_staff_task.description).toContain(
      "After the caller agrees, collect the details staff needs, then call create_staff_task",
    );
    expect(create_staff_task.description).toContain(
      "Success or duplicate completes the request; reserve a later transfer for a new urgent concern",
    );
    expect(create_staff_task.description).toContain(
      "Treat a successful booking, cancellation, or reschedule as complete",
    );
    expect(create_staff_task.description).toContain(
      "appointments only for separate appointment-specific work staff still needs to perform",
    );
    expect(create_staff_task.description).toContain("requests for a person");
    expect(create_staff_task.description).toContain("returned calls");
    expect(create_staff_task.description).toContain(
      "medication reactions or instructions",
    );
    expect(create_staff_task.description).toContain(
      "urgent or clinical concerns",
    );
    expect(create_staff_task.description).toContain(
      "approval, completion, refill, and timing left open",
    );
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
      "referrals for referral coordination or insurance prior authorization",
    );
    expect(taskParameters.shape.category.description).toContain(
      "insurance prior authorization",
    );
    expect(taskParameters.shape.category.description).toContain(
      "successful bookings, cancellations, and reschedules are complete",
    );
    expect(taskParameters.shape.message.description).toContain(
      "insurance prior authorization include the patient, plan, visit type, and authorization request",
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
      "Use add_patient for new-patient registration flows",
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
      "Pass only the matching call-scoped appointmentRef",
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
      "use call-scoped references from loaded appointment state",
    );
    expect(reschedule_appointment.description).toContain("oldAppointmentRef");
    expect(reschedule_appointment.description).toContain(
      "make the next call after you can pass the matching oldAppointmentRef",
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
        appointmentSlotRef: "S1",
        appointmentReason: "move my appointment",
        referringDoctor: "none",
        readBack: true,
      }).success,
    ).toBe(true);
    expect(
      parameters.safeParse({
        appointmentSlotRef: "S1",
        appointmentReason: "move my appointment",
        referringDoctor: "none",
        oldAppointmentRef: "old-appointment-2-abc123",
      }).success,
    ).toBe(true);
    expect(
      parameters.safeParse({
        appointmentSlotRef: "S1",
        appointmentReason: "move my appointment",
        referringDoctor: "none",
        oldAppointmentDate: "June 2",
        oldAppointmentTime: "9 AM",
      }).success,
    ).toBe(false);
    expect(
      parameters.safeParse({
        slotId: "S1",
        appointmentReason: "move my appointment",
        referringDoctor: "none",
        appointmentDate: "June 2",
        appointmentTime: "9 AM",
        appointmentId: 123,
      }).success,
    ).toBe(false);
    expect(
      parameters.safeParse({
        newSlotId: "S1",
        appointmentReason: "move my appointment",
        referringDoctor: "none",
        appointmentDate: "June 2",
        appointmentTime: "9 AM",
        appointmentId: 123,
      }).success,
    ).toBe(false);
    expect(
      parameters.safeParse({
        newAppointmentSlotRef: "S1",
        appointmentReason: "move my appointment",
        referringDoctor: "none",
      }).success,
    ).toBe(false);
    expect(
      parameters.safeParse({
        appointmentSlotRef: "S1",
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
        appointmentSlotRef: "S1",
        appointmentReason: "move my appointment",
      }).success,
    ).toBe(false);
  });

  it("keeps book_appointment scoped to confirmed slots with required referring doctor", () => {
    expect(book_appointment.description).toContain(
      "Book a caller-confirmed new appointment",
    );
    expect(book_appointment.description).toContain(
      "Use reschedule_appointment for appointment changes",
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
        appointmentSlotRef: "S1",
        appointmentReason: "eye pain",
        referringDoctor: "none",
      }).success,
    ).toBe(true);
  });

  it("keeps the no-referring-doctor marker internal to scheduling tools", () => {
    for (const schedulingTool of [book_appointment, reschedule_appointment]) {
      const parameters = schedulingTool.parameters as {
        shape: Record<string, { description?: string }>;
      };

      expect(parameters.shape.referringDoctor.description).toContain(
        'Pass "none" only as this tool\'s internal value and use natural caller-facing wording.',
      );
    }
  });

  it("keeps resolve_patient scoped to patient identity loading", () => {
    expect(resolve_patient.description).toContain("Resolve who the patient is");
    expect(resolve_patient.description).toContain(
      "firstName, lastName, and DOB",
    );
    expect(resolve_patient.description).toContain(
      "use this tool as the last resort for existing-patient lookup",
    );
    expect(resolve_patient.description).toContain(
      "Use this tool to switch to a different patient using caller-provided identity details",
    );
    expect(resolve_patient.description).toContain(
      "Use add_patient for explicit new-patient confirmation and chart creation",
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
    expect(parameters.safeParse({}).success).toBe(true);
    expect(
      parameters.safeParse({ registrationStatus: "not_registered" }).success,
    ).toBe(false);
    expect(parameters.safeParse({ firstName: " " }).success).toBe(false);
  });
});
