import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildToolsForTrunk } from "../agent.js";
import { buildPrompt, buildTaskPrompt } from "../prompt.js";
import { getOfficeKeyByPhone, SPRING_HILL_OFFICE_PHONE } from "../offices.js";
import {
  getAmdOfficeForToolCall,
  getSpringHillOfficePhone,
  resolveKnowledgeFileForOffice,
} from "../tools.js";

describe("office routing helpers", () => {
  it("maps trunk numbers to office keys", () => {
    expect(getOfficeKeyByPhone("+13523202007")).toBe("crystal-river");
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
      "KNOWLEDGE_EYERADIANCE.md",
    );
    expect(resolveKnowledgeFileForOffice("spring-hill")).toBe(
      "KNOWLEDGE_SPRINGHILL.md",
    );
  });

  it("only exposes Spring Hill routing on Crystal River calls", () => {
    expect(buildToolsForTrunk("+13523202007")).toHaveProperty(
      "route_to_spring_hill",
    );
    expect(buildToolsForTrunk(SPRING_HILL_OFFICE_PHONE)).not.toHaveProperty(
      "route_to_spring_hill",
    );
  });

  it("exposes orchestration tools for identity and registration workflows", () => {
    const tools = buildToolsForTrunk(SPRING_HILL_OFFICE_PHONE);

    expect(tools).toHaveProperty("run_identify_patient_task");
    expect(tools).toHaveProperty("run_registration_task");
    expect(tools).toHaveProperty("run_schedule_task_group");
    expect(tools).toHaveProperty("run_reschedule_task_group");
    expect(tools).toHaveProperty("run_confirm_task_group");
    expect(tools).toHaveProperty("run_cancel_task_group");
    expect(tools).not.toHaveProperty("get_availability");
    expect(tools).not.toHaveProperty("book_appt");
    expect(tools).not.toHaveProperty("confirm_appt");
    expect(tools).not.toHaveProperty("cancel_appt");
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

  it("keeps the inbound caller number question in the registration task prompt", () => {
    const prompt = buildTaskPrompt({
      mode: "register",
      stateSummary: "Current call state:\n- patient: not yet identified",
    });

    expect(prompt).toContain(
      `is the number you're calling from a good one on file?`,
    );
  });

  it("builds a focused task prompt with state summary", () => {
    const prompt = buildTaskPrompt({
      mode: "schedule",
      stateSummary: "Current call state:\n- patient: Maria Santos",
    });

    expect(prompt).toContain("<task_mode>");
    expect(prompt).toContain("schedule");
    expect(prompt).toContain("Current call state:");
    expect(prompt).toContain("patient: Maria Santos");
    expect(prompt).toContain("search one date at a time");
  });

  it("keeps direct new-patient routing explicit in the router prompt", () => {
    const prompt = buildPrompt(undefined, SPRING_HILL_OFFICE_PHONE);

    expect(prompt).toContain(
      "If no, go straight to new patient registration",
    );
    expect(prompt).toContain(
      "if the caller clearly says they are new or says they have not been seen here before, go straight to registration",
    );
  });

  it("pins spoken language and blocks tool internals in the base prompt", () => {
    const prompt = buildPrompt(undefined, SPRING_HILL_OFFICE_PHONE);

    expect(prompt).toContain(
      "stay in that language until they switch or explicitly ask you to",
    );
    expect(prompt).toContain(
      "Do not say tool names, parameters, raw tool outputs, internal reasoning, or technical identifiers",
    );
  });

  it("includes the replacement-visit-reason step in the reschedule task prompt", () => {
    const prompt = buildTaskPrompt({
      mode: "reschedule",
      stateSummary: "Current call state:\n- patient: Maria Santos",
    });

    expect(prompt).toContain(
      "collect or confirm the reason for the replacement visit if needed",
    );
    expect(prompt).toContain("If a registration read-back or appointment confirmation is long, split it into short chunks");
    expect(prompt).toContain("Reschedule order:");
  });

  it("keeps the scheduling pushback-then-transfer rule explicit", () => {
    const prompt = buildPrompt(undefined, SPRING_HILL_OFFICE_PHONE);

    expect(prompt).toContain("ask once what they need");
    expect(prompt).toContain(
      "if it is scheduling, push back once and try to help",
    );
    expect(prompt).toContain("if they ask again, transfer");
  });
});
