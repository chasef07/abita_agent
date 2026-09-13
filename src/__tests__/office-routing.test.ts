import { isToolset, type ToolContextEntry } from "@livekit/agents";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildToolsForTrunk } from "../runtime/tool-registry.js";
import { buildPrompt } from "../prompt.js";
import {
  CRYSTAL_RIVER_OFFICE_PHONE,
  RHEUMATOLOGY_DEMO_TRUNK_PHONE,
  NEW_TAMPA_DEMO_TRUNK_PHONE,
  getOfficeProfile,
  getOfficeProfileByPhone,
  getOfficeKeyByPhone,
  getProductOfficeKeyByPhone,
  HOLLYWOOD_OFFICE_PHONE,
  NORTH_MIAMI_BEACH_OPTICAL_OFFICE_PHONE,
  OPHTHALMOLOGY_DEMO_TRUNK_PHONE,
  normalizeHandoffTarget,
  normalizePhoneNumber,
  SPRING_HILL_813_TRUNK_PHONE,
  SPRING_HILL_OFFICE_PHONE,
  SWEETWATER_OFFICE_PHONE,
  SWEETWATER_TRUNK_PHONES,
} from "../customers/abita/profile.js";
import {
  createAddPatientTool,
  check_insurance,
  create_staff_task,
  transfer_call,
  createUpdateInsuranceTool,
} from "../tools/index.js";
import { createResolvePatientTool } from "../tools/resolve-patient.js";
import { InMemoryOwnedMiddleware } from "./support/owned-middleware.js";

const middleware = new InMemoryOwnedMiddleware();
const add_patient = createAddPatientTool(middleware);
const resolve_patient = createResolvePatientTool(middleware);
const update_insurance = createUpdateInsuranceTool(middleware);

const GLASSES_READY_ANSWER =
  "Check your texts. A readiness text confirms your glasses are ready for pickup. Please wait for that text before coming in.";

function toolNames(entries: readonly ToolContextEntry[]): string[] {
  return entries.flatMap((entry) =>
    isToolset(entry) ? toolNames(entry.tools) : [entry.id],
  );
}

function toolNamesForTrunk(trunkPhone: string): string[] {
  return toolNames(buildToolsForTrunk(middleware, trunkPhone));
}

function toolForTrunk(trunkPhone: string, name: string) {
  return buildToolsForTrunk(middleware, trunkPhone)
    .flatMap((entry) => (isToolset(entry) ? entry.tools : [entry]))
    .find((entry) => entry.id === name);
}

const book_appointment = toolForTrunk(
  SPRING_HILL_OFFICE_PHONE,
  "book_appointment",
)!;
const cancel_appointment = toolForTrunk(
  SPRING_HILL_OFFICE_PHONE,
  "cancel_appointment",
)!;
const list_available_appointments = toolForTrunk(
  HOLLYWOOD_OFFICE_PHONE,
  "list_available_appointments",
)!;
const reschedule_appointment = toolForTrunk(
  SPRING_HILL_OFFICE_PHONE,
  "reschedule_appointment",
)!;

afterEach(() => {
  delete process.env.DEV_HANDOFF_TARGET;
});

describe("office routing helpers", () => {
  it("normalizes LiveKit phone attributes without a plus prefix", () => {
    expect(normalizePhoneNumber("14843989071")).toBe(
      RHEUMATOLOGY_DEMO_TRUNK_PHONE,
    );
    expect(getOfficeKeyByPhone("14843989071")).toBe("rheumatology-demo");
    expect(getOfficeKeyByPhone("18027878312")).toBe("ophthalmology-demo");
    expect(getOfficeKeyByPhone("13207388132")).toBe("new-tampa-demo");
  });

  it.each([
    [RHEUMATOLOGY_DEMO_TRUNK_PHONE, "rheumatology-demo"],
    [OPHTHALMOLOGY_DEMO_TRUNK_PHONE, "ophthalmology-demo"],
    [NEW_TAMPA_DEMO_TRUNK_PHONE, "new-tampa-demo"],
  ] as const)(
    "maps specialty demo trunk %s through its matching Office Profile and Product route",
    (trunkPhone, officeKey) => {
      expect(getOfficeProfileByPhone(trunkPhone).key).toBe(officeKey);
      expect(getProductOfficeKeyByPhone(trunkPhone)).toBe(officeKey);
    },
  );

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

    expect(toolNamesForTrunk(RHEUMATOLOGY_DEMO_TRUNK_PHONE)).toContain(
      "create_staff_task",
    );
    expect(getOfficeProfile("spring-hill").staffTaskEnabled).toBe(true);
    expect(getOfficeProfile("rheumatology-demo").staffTaskEnabled).toBe(true);
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
    const hollywood = toolForTrunk(
      HOLLYWOOD_OFFICE_PHONE,
      "list_available_appointments",
    );
    const springHill = toolForTrunk(
      SPRING_HILL_OFFICE_PHONE,
      "list_available_appointments",
    );
    const hollywoodSchema = z.toJSONSchema(hollywood!.parameters);
    const springHillSchema = z.toJSONSchema(springHill!.parameters);

    expect(hollywoodSchema.required).toContain("office");
    expect(springHillSchema.properties).not.toHaveProperty("office");
  });
});

describe("voice output prompt", () => {
  it("includes shared related-detail batching guidance in every live prompt", () => {
    for (const phone of [
      SPRING_HILL_OFFICE_PHONE,
      OPHTHALMOLOGY_DEMO_TRUNK_PHONE,
      RHEUMATOLOGY_DEMO_TRUNK_PHONE,
      NEW_TAMPA_DEMO_TRUNK_PHONE,
    ]) {
      const prompt = buildPrompt(phone);

      expect(prompt).toContain(
        "Ask one topic at a time, combining closely related details into one natural question. Keep confirmation of a consequential action as its own question.",
      );
      expect(prompt).not.toContain(
        "Keep responses to one to three sentences. Ask one question at a time.",
      );
      expect(prompt).not.toContain(
        "Use one to three sentences and ask one question at a time.",
      );
    }

    const focusedTriageRule =
      "Triage is complete when the routine purpose is clear";
    for (const phone of [
      SPRING_HILL_OFFICE_PHONE,
      OPHTHALMOLOGY_DEMO_TRUNK_PHONE,
    ]) {
      expect(buildPrompt(phone)).toContain(focusedTriageRule);
    }
    for (const phone of [
      RHEUMATOLOGY_DEMO_TRUNK_PHONE,
      NEW_TAMPA_DEMO_TRUNK_PHONE,
    ]) {
      expect(buildPrompt(phone)).not.toContain(focusedTriageRule);
    }
  });

  it("states model-facing prompt instructions as positive actions", () => {
    const prompts = [
      buildPrompt(SPRING_HILL_OFFICE_PHONE),
      buildPrompt(RHEUMATOLOGY_DEMO_TRUNK_PHONE),
    ];

    for (const prompt of prompts) {
      expect(prompt).not.toMatch(
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
      "If the name is still unclear, ask for spelling; use a clearly supplied name directly.",
    );
    expect(prompt).toContain(
      "When a reply is unclear or seems out of context, clarify only the uncertain detail and keep what is already understood.",
    );
    expect(prompt).toContain(
      "Only confirm a booking, cancellation, rescheduling, insurance update, patient creation, or staff request after the matching currently available action succeeds.",
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
      "Transfer the caller to human staff only when current office policy requires it. Call immediately without announcing the transfer; the tool speaks the announcement. Retry only when the result explicitly offers one retry.",
    );
    expect(prompt).not.toContain(
      "Use resolve_patient for patient-specific work when internal state has not already confirmed the patient.",
    );
    expect(list_available_appointments.description).toContain(
      "Book the confirmed reference with book_appointment",
    );
    expect(prompt).not.toContain("Today is");
    expect(prompt).not.toContain("The current time is");

    const crystalRiverPrompt = buildPrompt(CRYSTAL_RIVER_OFFICE_PHONE);
    const devPrompt = buildPrompt(RHEUMATOLOGY_DEMO_TRUNK_PHONE);

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
      expect(officePrompt).not.toContain("We are closed on weekends.");
      expect(officePrompt).not.toContain("Labor Day");
    }
  });

  it("understands the eye concern before classifying the scheduling purpose", () => {
    for (const phone of [
      SPRING_HILL_OFFICE_PHONE,
      SPRING_HILL_813_TRUNK_PHONE,
      CRYSTAL_RIVER_OFFICE_PHONE,
      HOLLYWOOD_OFFICE_PHONE,
      NORTH_MIAMI_BEACH_OPTICAL_OFFICE_PHONE,
      ...SWEETWATER_TRUNK_PHONES,
      OPHTHALMOLOGY_DEMO_TRUNK_PHONE,
    ]) {
      const prompt = buildPrompt(phone);

      expect(prompt).toContain("# Appointment Triage");
      expect(prompt).toContain(
        "Before checking availability for a new appointment, understand why the patient is coming in",
      );
      expect(prompt).toContain(
        "Use medical for a current eye problem, symptom, condition, post-operative concern, or medical evaluation.",
      );
      expect(prompt).toContain(
        "Use routine_vision when the patient's purpose is limited to glasses, contacts, prescription updates, fittings, or a routine vision exam.",
      );
      expect(prompt).not.toContain("alone do not determine the visit type");
      expect(prompt).toContain(
        'If the appointment reason is missing, ask: "What are you coming in for?"',
      );
      expect(prompt).toContain(
        'A vague answer like "an eye problem" is not enough. Ask: "What\'s going on with your eye?"',
      );
      expect(prompt).toContain(
        "Triage is complete when the routine purpose is clear, or the caller has described the eye concern and one useful detail, such as which eye or when it started.",
      );
      expect(prompt).toContain(
        "Reuse details already given; ask one focused question at a time for anything missing, then move to patient identity and availability.",
      );
      expect(prompt).toContain(
        "If the caller can only describe a vague eye concern after one focused follow-up, record their words and that limitation as the appointment reason, then continue scheduling. Keep unknown details unknown.",
      );
      expect(prompt).toContain(
        "If the caller describes an eye emergency, follow Human Transfer immediately.",
      );
      expect(prompt).not.toContain(
        "Is this for an eye problem or symptom that needs an ophthalmologist",
      );
      expect(prompt).not.toContain("referral");
      expect(prompt).toContain(
        "Leave diagnosis to clinical staff and classify only the scheduling purpose.",
      );
    }
  });

  it.each([
    SPRING_HILL_OFFICE_PHONE,
    CRYSTAL_RIVER_OFFICE_PHONE,
    OPHTHALMOLOGY_DEMO_TRUNK_PHONE,
  ])("keeps runtime eye-emergency handling for %s", (phone) => {
    expect(buildPrompt(phone)).toContain(
      "If the caller describes an eye emergency, follow Human Transfer immediately.",
    );
  });

  it.each([SPRING_HILL_OFFICE_PHONE, OPHTHALMOLOGY_DEMO_TRUNK_PHONE])(
    "keeps identity and privacy policy in the static prompt for %s",
    (phone) => {
      const prompt = buildPrompt(phone);

      expect(prompt).toContain("# Patient Identity");
      expect(prompt).toContain(
        "call resolve_patient with the intended patient's caller-provided identity",
      );
      expect(prompt).toContain("Use null for unknown fields");
      expect(prompt).not.toContain("wait for confirmation before resolving");
      expect(prompt).not.toContain("<caller_identity_hint>");
      expect(prompt).not.toContain("middleware_error");
      expect(prompt).not.toContain("+17275551212");
    },
  );

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
      "call create_staff_task before confirming submission or closing",
    );
    expect(prompt).toContain(
      "A successful result means the request was sent for staff review, not that the underlying issue is resolved.",
    );
  });
});

describe("rheumatology demo", () => {
  it("uses a fictional rheumatology identity and medication prompt", () => {
    const prompt = buildPrompt(RHEUMATOLOGY_DEMO_TRUNK_PHONE);

    expect(prompt).toContain("You are Julia");
    expect(prompt).toContain("fictional rheumatology practice");
    expect(prompt).toContain("Rheumatology includes");
    expect(prompt).toContain("visitType medical");
    expect(prompt).toContain(
      "Answer general medication education only from the current office knowledge",
    );
    expect(prompt).toContain(
      "For a routine refill, pharmacy change, medication prior authorization, or prescription-status request",
    );
    expect(prompt).toContain(
      "Immediately call transfer_call for clinical medication guidance",
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

  it("exposes the demo transfer and staff-task tools", () => {
    const names = toolNamesForTrunk(RHEUMATOLOGY_DEMO_TRUNK_PHONE);

    expect(names).toContain("check_insurance");
    expect(names).toContain("list_available_appointments");
    expect(names).toContain("book_appointment");
    expect(names).toContain("end_call");
    expect(names).toContain("transfer_call");
    expect(names).toContain("create_staff_task");
  });

  it("honors the isolated demo handoff override", () => {
    process.env.DEV_HANDOFF_TARGET = "sip:demo@example.test";
    expect(getOfficeProfile("rheumatology-demo").handoff()).toEqual({
      mode: "product-with-phone-fallback",
      target: "sip:demo@example.test",
    });
  });
});

describe("dedicated demo trunks", () => {
  it("restores the ophthalmology demo on its own number", () => {
    const office = getOfficeProfile("ophthalmology-demo");
    const prompt = buildPrompt(OPHTHALMOLOGY_DEMO_TRUNK_PHONE);

    expect(office.trunkPhones).toEqual([OPHTHALMOLOGY_DEMO_TRUNK_PHONE]);
    expect(office.amdOfficePhone).toBe(RHEUMATOLOGY_DEMO_TRUNK_PHONE);
    expect(office.schedulingFor("medical")).toEqual({ supported: true });
    expect(office.schedulingFor("routine_vision")).toEqual({
      supported: true,
    });
    expect(prompt).toContain("a fictional ophthalmology clinic");
    expect(prompt).not.toContain("Abita Eye Group");
    expect(prompt).toContain("# Appointment Triage");
  });

  it("activates the personalized New Tampa demo with both eye-care lanes", () => {
    const office = getOfficeProfile("new-tampa-demo");
    const prompt = buildPrompt(NEW_TAMPA_DEMO_TRUNK_PHONE);
    expect(office.trunkPhones).toEqual([NEW_TAMPA_DEMO_TRUNK_PHONE]);
    expect(office.amdOfficePhone).toBe(RHEUMATOLOGY_DEMO_TRUNK_PHONE);
    expect(office.schedulingFor("medical")).toEqual({ supported: true });
    expect(office.schedulingFor("routine_vision")).toEqual({ supported: true });
    expect(prompt).toContain("New Tampa Eye Institute");
    expect(prompt).toContain("triage_eye_care");
  });
});

describe("Crystal River prompt guidance", () => {
  it("keeps obsolete Crystal River routing instructions out of the prompt", () => {
    const prompt = buildPrompt("+13523202007");

    expect(prompt).not.toContain("Use the routing tool, not the transfer tool");
    expect(prompt).not.toContain("route_to_spring_hill");
    expect(prompt).not.toContain("do not transfer just for that");
  });

  it("keeps obsolete triage instructions out of the Spring Hill prompt", () => {
    const prompt = buildPrompt(SPRING_HILL_OFFICE_PHONE);

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
    expect(prompt).not.toContain("do **not** perform routine eye exams");
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

    expect(hollywoodPrompt).not.toContain("route_to_spring_hill");
    expect(sweetwaterPrompt).not.toContain("route_to_spring_hill");
    expect(hollywoodPrompt).not.toContain("Crystal River routing rules");
    expect(sweetwaterPrompt).not.toContain("Crystal River routing rules");
  });

  it("keeps Crystal River routing instructions out of the North Miami Beach prompt", () => {
    const prompt = buildPrompt(NORTH_MIAMI_BEACH_OPTICAL_OFFICE_PHONE);

    expect(prompt).not.toContain("route_to_spring_hill");
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

    expect(create_staff_task.description).not.toContain(
      "glasses-readiness text policy",
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

    expect(buildPrompt(RHEUMATOLOGY_DEMO_TRUNK_PHONE)).toContain(
      "create_staff_task",
    );
  });

  it("keeps concise voice guidance in the base voice prompt", () => {
    const prompt = buildPrompt(SPRING_HILL_OFFICE_PHONE);

    expect(prompt).toContain(
      "Use normal written forms for dates, times, phone numbers, emails, and common acronyms.",
    );
    expect(prompt).toContain("If one sentence is enough, use one sentence.");
    expect(prompt).toContain("Use at most three sentences per response.");
    expect(prompt).toContain(
      "Sprinkle them sparingly, one at a time, and keep most responses free of fillers.",
    );
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
  it("keeps each custom tool description within the concise contract", () => {
    const customTools = buildToolsForTrunk(middleware, HOLLYWOOD_OFFICE_PHONE)
      .flatMap((entry) => (isToolset(entry) ? entry.tools : [entry]))
      .filter((entry) => entry.id !== "end_call");

    expect(customTools.map((entry) => entry.id).sort()).toEqual(
      [
        "add_patient",
        "book_appointment",
        "cancel_appointment",
        "check_insurance",
        "search_office_knowledge",
        "create_staff_task",
        "list_available_appointments",
        "reschedule_appointment",
        "resolve_patient",
        "transfer_call",
        "update_insurance",
      ].sort(),
    );
    for (const customTool of customTools) {
      const words = customTool.description.trim().split(/\s+/).length;
      expect(customTool.description.trim(), customTool.id).not.toBe("");
      expect(words, customTool.id).toBeLessThanOrEqual(70);
    }
  });

  it("keeps add_patient focused on new-patient chart creation", () => {
    expect(add_patient.description).toContain(
      "Create a new patient chart only after first-registration confirmation",
    );
    expect(add_patient.description).toContain("accepted insurance");
    expect(add_patient.description).toContain("confirmed full read-back");
    expect(add_patient.description).toContain(
      "For insured routine vision, request only SSN last four once",
    );
    expect(add_patient.description).toContain(
      "continue if unavailable; skip it for self-pay",
    );
    expect(add_patient.description).toContain(
      "never retry after full or partial chart creation",
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
      "Optional SSN last four for insured routine vision. Request only four digits. Pass null for self-pay, declined, or unavailable.",
    );
    expect(
      String(
        (parameters.shape.ssnLast4 as { description?: string }).description,
      ),
    ).toContain("Pass null");
    expect(Object.keys(parameters.shape)).not.toContain("subscriberNum");
    expect(
      parameters.safeParse({
        firstName: "Jane",
        lastName: "Doe",
        dob: "01/01/1980",
        phone: null,
        inboundPhoneConfirmed: true,
        email: null,
        street: "1 Main St",
        aptSuite: null,
        city: "Spring Hill",
        state: "FL",
        zip: "34609",
        sex: "female",
        subscriberName: "Jane Doe",
        ssnLast4: null,
        newPatientConfirmed: null,
        readBack: null,
      }).success,
    ).toBe(false);
    expect(
      parameters.safeParse({
        firstName: "Jane",
        lastName: "Doe",
        dob: "01/01/1980",
        phone: null,
        inboundPhoneConfirmed: true,
        email: null,
        street: "1 Main St",
        aptSuite: null,
        city: "Spring Hill",
        state: "FL",
        zip: "34609",
        sex: "female",
        subscriberName: "Jane Doe",
        insuranceMemberId: "ABC123",
        ssnLast4: "1234",
        newPatientConfirmed: null,
        readBack: null,
      }).success,
    ).toBe(true);
    expect(
      parameters.safeParse({
        firstName: "Jane",
        lastName: "Doe",
        dob: "   ",
        inboundPhoneConfirmed: true,
        street: "1 Main St",
        city: "Spring Hill",
        state: "FL",
        zip: "34609",
        sex: "female",
        subscriberName: "Jane Doe",
        insuranceMemberId: "ABC123",
      }).success,
    ).toBe(false);
    expect(
      parameters.safeParse({
        firstName: "Jane",
        lastName: "Doe",
        dob: "01/01/1980",
        phone: null,
        inboundPhoneConfirmed: true,
        email: null,
        street: "1 Main St",
        aptSuite: null,
        city: "Spring Hill",
        state: "FL",
        zip: "34609",
        sex: "female",
        subscriberName: "Jane Doe",
        insuranceMemberId: "ABC123",
        ssnLast4: null,
        newPatientConfirmed: null,
        readBack: null,
      }).success,
    ).toBe(true);
    expect(
      parameters.safeParse({
        firstName: "Jane",
        lastName: "Doe",
        dob: "01/01/1980",
        phone: null,
        inboundPhoneConfirmed: true,
        email: null,
        street: "1 Main St",
        aptSuite: null,
        city: "Spring Hill",
        state: "FL",
        zip: "34609",
        sex: "female",
        subscriberName: "Jane Doe",
        insuranceMemberId: "ABC123",
        ssnLast4: "12345",
        newPatientConfirmed: null,
        readBack: null,
      }).success,
    ).toBe(false);
  });

  it("keeps availability execution tied to core appointment triage", () => {
    expect(list_available_appointments.description).toContain("after triage");
    expect(list_available_appointments.description).toContain(
      "Offer only returned slots",
    );
    expect(list_available_appointments.description).not.toContain(
      "appointmentLane",
    );
    expect(list_available_appointments.description).not.toContain(
      "bach_only routing",
    );
    expect(list_available_appointments.description).not.toContain(
      "Under 18 medical visits = Dr. Bach only",
    );

    const parameters = list_available_appointments.parameters as {
      safeParse: (value: unknown) => { success: boolean };
      shape: {
        office: { description?: string };
        visitType: { description?: string };
        startDate: { description?: string };
      };
    };
    expect(parameters.shape.visitType.description).toContain(
      "Visit type for this availability",
    );
    expect(parameters.shape.office.description).toContain(
      "Caller-selected Hollywood or Sweetwater office",
    );
    expect(parameters.shape.startDate.description).toContain(
      "14-calendar-day window",
    );
    expect(parameters.shape.startDate.description).toContain("future date");
    expect(Object.keys(parameters.shape)).toEqual([
      "startDate",
      "visitType",
      "office",
    ]);
    expect(
      parameters.safeParse({
        visitType: "medical",
        office: "hollywood",
      }).success,
    ).toBe(true);
    expect(
      parameters.safeParse({
        visitType: null,
        office: "hollywood",
      }).success,
    ).toBe(false);
    expect(
      parameters.safeParse({
        visitType: "medical",
        office: "sweetwater",
      }).success,
    ).toBe(true);
    expect(
      parameters.safeParse({
        visitType: "medical",
        office: "spring-hill",
      }).success,
    ).toBe(false);
    expect(
      parameters.safeParse({
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
        visitType: "routine_vision",
        office: "hollywood",
      }).success,
    ).toBe(true);
    expect(
      parameters.safeParse({
        visitType: "unknown",
        office: "hollywood",
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
        date: "2026-06-01",
        visitType: "medical",
      }).success,
    ).toBe(false);
    expect(
      parameters.safeParse({
        appointmentLane: "medical_md",
      }).success,
    ).toBe(false);
  });

  it("keeps check_insurance scoped to insurance eligibility", () => {
    expect(check_insurance.description).toContain(
      "active office accepts a plan",
    );
    expect(check_insurance.description).toContain(
      "after the caller provides the plan name and visit type",
    );
    expect(check_insurance.description).toContain(
      "before new-patient creation",
    );
    expect(check_insurance.description).toContain(
      "for participation questions",
    );
    expect(check_insurance.description).toContain(
      "A result requiring staff follow-up needs caller permission, then a normal insurance task",
    );
    expect(check_insurance.description).toContain(
      "transfer only if task creation is unavailable, fails, or the caller declines",
    );

    const parameters = check_insurance.parameters as {
      safeParse: (value: unknown) => { success: boolean };
      shape: {
        coverageType: { description?: string };
      };
    };
    expect(parameters.shape.coverageType.description).toBe(
      "Triaged visit type: medical or routine_vision.",
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
      "Transfer the caller to human staff only when current office policy requires it. Call immediately without announcing the transfer; the tool speaks the announcement. Retry only when the result explicitly offers one retry.",
    );
  });

  it("keeps staff task capture scoped to safe non-live work", () => {
    expect(create_staff_task.description).toContain(
      "one safe, non-urgent caller-approved unresolved request",
    );
    expect(create_staff_task.description).toContain("list gaps if incomplete");
    expect(create_staff_task.description).toContain(
      "search office knowledge for intake and delivery rules",
    );
    expect(create_staff_task.description).toContain(
      "Follow Human Transfer policy for urgent or clinical concerns",
    );
    expect(create_staff_task.description).toContain(
      "Confirm submission only after success",
    );
    const taskParameters = create_staff_task.parameters as {
      shape: {
        category: { description?: string };
        urgency: { description?: string };
        summary: { description?: string };
        message: { description?: string };
      };
    };
    expect(taskParameters.shape.category.description).toContain("medication");
    expect(taskParameters.shape.category.description).toContain("optical");
    expect(taskParameters.shape.category.description).toContain(
      "medication includes refills and medication authorizations",
    );
    expect(taskParameters.shape.message.description).toContain(
      "service/plan, authorization status",
    );
    expect(taskParameters.shape.urgency.description).toContain(
      "high_priority for time-sensitive non-clinical work",
    );
    expect(taskParameters.shape.urgency.description).toContain(
      "normal for standard follow-up",
    );
    expect(taskParameters.shape.urgency.description).toContain(
      "non_urgent with no time sensitivity",
    );
    expect(taskParameters.shape.summary.description).toContain(
      "Short staff inbox title",
    );
    expect(taskParameters.shape.message.description).toContain(
      "Include medication/pharmacy",
    );
    expect(
      create_staff_task.parameters.safeParse({
        category: "billing",
        urgency: "high_priority",
        summary: "Caller has a billing question.",
        message: "The caller wants billing to review a recent bill.",
      }).success,
    ).toBe(false);
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
    expect(update_insurance.description).toContain("active verified patient");
    expect(update_insurance.description).toContain(
      "after the caller requests the change",
    );
    expect(update_insurance.description).toContain(
      "Use add_patient for new registrations",
    );
    expect(update_insurance.description).toContain("updated receipt");
    expect(update_insurance.description).toContain(
      "single-retry or transfer instruction",
    );

    const parameters = update_insurance.parameters as {
      safeParse: (value: unknown) => { success: boolean };
      shape: Record<string, { description?: string }>;
    };
    expect(Object.keys(parameters.shape)).toEqual(["insuranceMemberId"]);
    expect(parameters.shape.insuranceMemberId.description).toBe(
      'Card member ID; use "self pay" only after Self Pay is accepted.',
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
      "Cancel a loaded appointment only after patient verification",
    );
    expect(cancel_appointment.description).toContain(
      "confirmation of the exact appointment",
    );
    expect(cancel_appointment.description).toContain(
      "opaque call-scoped appointmentRef",
    );
    expect(cancel_appointment.description).toContain(
      "do not retry a completed cancellation",
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
      "Move a verified patient's loaded appointment",
    );
    expect(reschedule_appointment.description).toContain(
      "books first, then cancels the old appointment",
    );
    expect(reschedule_appointment.description).toContain(
      "read-back of the new date, time, and provider",
    );
    expect(reschedule_appointment.description).toContain(
      "use only opaque call-scoped references",
    );
    expect(reschedule_appointment.description).toContain(
      "report partial success if cancellation fails",
    );
    expect(reschedule_appointment.description).toContain(
      "never retry the booking",
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
        oldAppointmentRef: "A1",
        appointmentSlotRef: "S1",
        appointmentReason: "move my appointment",
        referringDoctor: "none",
        readBack: true,
      }).success,
    ).toBe(true);
    expect(
      parameters.safeParse({
        oldAppointmentRef: "A1",
        appointmentSlotRef: "S1",
        appointmentReason: "move my appointment",
        referringDoctor: "none",
        readBack: null,
      }).success,
    ).toBe(true);
    expect(
      parameters.safeParse({
        oldAppointmentRef: "A1",
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
        oldAppointmentRef: "A1",
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
        oldAppointmentRef: "A1",
        appointmentSlotRef: "S1",
        appointmentReason: "move my appointment",
      }).success,
    ).toBe(false);
  });

  it("keeps book_appointment scoped to confirmed slots with required referring doctor", () => {
    expect(book_appointment.description).toContain(
      "Book a new appointment using a caller-confirmed slot",
    );
    expect(book_appointment.description).toContain(
      "use reschedule_appointment to move an existing appointment",
    );
    expect(book_appointment.description).toContain(
      "learning who referred the caller or that no doctor referred them",
    );
    expect(book_appointment.description).toContain(
      "Claim booking success only from this tool's successful result",
    );
    expect(book_appointment.description).toContain(
      "duplicate calls are rejected",
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
    ).toContain("Record caller facts only; do not diagnose");
    expect(parameters.safeParse({}).success).toBe(false);
    expect(
      parameters.safeParse({
        appointmentSlotRef: "S1",
        appointmentReason: "eye pain",
        referringDoctor: "none",
        readBack: null,
      }).success,
    ).toBe(true);
  });

  it("keeps the no-referring-doctor marker internal to scheduling tools", () => {
    for (const schedulingTool of [book_appointment, reschedule_appointment]) {
      const parameters = schedulingTool.parameters as {
        shape: Record<string, { description?: string }>;
      };

      expect(parameters.shape.referringDoctor.description).toContain(
        'Use internal value "none" only when the caller says they have no referring doctor',
      );
    }
  });

  it("keeps resolve_patient scoped to patient identity loading", () => {
    expect(resolve_patient.description).not.toMatch(
      /Phone lookup|phone candidates/i,
    );
    expect(resolve_patient.description).toContain(
      "Use caller-provided identity only",
    );
    expect(resolve_patient.description).toContain("firstName");
    expect(resolve_patient.description).toContain("dob:null");
    expect(resolve_patient.description).toContain(
      "Use add_patient for registration",
    );
    expect(resolve_patient.description).not.toContain("insurance updates");
    expect(resolve_patient.description).not.toContain("private account");

    const parameters = resolve_patient.parameters as {
      safeParse: (value: unknown) => { success: boolean };
      shape: Record<string, unknown>;
    };
    expect(Object.keys(parameters.shape)).toEqual(["firstName", "dob"]);
    expect(
      parameters.safeParse({
        firstName: "Jane",
        dob: null,
      }).success,
    ).toBe(true);
    expect(
      parameters.safeParse({
        firstName: "Jane",
        dob: "01/01/1980",
      }).success,
    ).toBe(true);
    expect(parameters.safeParse({ firstName: null, dob: null }).success).toBe(
      true,
    );
    expect(parameters.safeParse({}).success).toBe(false);
    expect(
      parameters.safeParse({
        firstName: null,
        dob: null,
        registrationStatus: "not_registered",
      }).success,
    ).toBe(false);
    expect(parameters.safeParse({ firstName: " ", dob: null }).success).toBe(
      false,
    );
  });
});
