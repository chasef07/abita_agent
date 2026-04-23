import { llm } from "@livekit/agents";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Agent, buildToolsForTrunk } from "../agent.js";
import { buildPrompt, buildTaskPrompt } from "../prompt.js";
import { getOfficeKeyByPhone, SPRING_HILL_OFFICE_PHONE } from "../offices.js";
import {
  buildTurnStateSummary,
  createInitialCallState,
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
    expect(prompt).toContain("use request_workflow_change");
    expect(prompt).toContain("do not recap the whole workflow");
  });

  it("keeps new-patient routing explicit while gating direct registration in the router prompt", () => {
    const prompt = buildPrompt(undefined, SPRING_HILL_OFFICE_PHONE);

    expect(prompt).toContain(
      "once the caller's scheduling intent is clear, launch the appropriate workflow immediately",
    );
    expect(prompt).toContain(
      "If no, move into the identify or scheduling workflow so it can safely allow registration",
    );
    expect(prompt).toContain(
      "if the caller clearly says they are new or says they have not been seen here before, prefer `run_schedule_task_group` for scheduling or `run_identify_patient_task`",
    );
    expect(prompt).toContain(
      "use `run_registration_task` only after the identity flow has already allowed registration",
    );
  });

  it("does not treat phone lookup outages as no-match caller context", () => {
    const prompt = buildPrompt(
      {
        status: "lookup_error",
        message: "Phone lookup is temporarily unavailable.",
      },
      SPRING_HILL_OFFICE_PHONE,
    );

    expect(prompt).toContain("PHONE LOOKUP UNAVAILABLE");
    expect(prompt).toContain(`Do not treat this as "no match."`);
    expect(prompt).not.toContain("NO MATCH — This number is not in the system");
  });

  it("injects Crystal River routing rules into task prompts before routing", () => {
    const prompt = buildTaskPrompt({
      mode: "schedule",
      stateSummary: "Current call state:\n- patient: not yet identified",
      officeKey: "crystal-river",
      effectiveOfficeKey: "crystal-river",
    });

    expect(prompt).toContain("Crystal River routing rules.");
    expect(prompt).toContain(
      "If routing becomes necessary after the workflow has already started, use the routing tool",
    );
  });

  it("shows routed office context in task prompts after Spring Hill routing is active", () => {
    const prompt = buildTaskPrompt({
      mode: "schedule",
      stateSummary: "Current call state:\n- patient: Maria Santos",
      officeKey: "crystal-river",
      effectiveOfficeKey: "spring-hill",
    });

    expect(prompt).toContain("Inbound office: Eye Radiance.");
    expect(prompt).toContain(
      "Scheduling tools are already routed to Abita Eye Group.",
    );
    expect(prompt).not.toContain("Crystal River routing rules.");
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
    expect(prompt).toContain(
      "If a registration read-back or appointment confirmation is long, split it into short chunks",
    );
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

  it("returns no turn summary when no workflow is active", () => {
    const state = createInitialCallState({
      officeKey: "spring-hill",
      officePhone: SPRING_HILL_OFFICE_PHONE,
      amdOfficePhone: SPRING_HILL_OFFICE_PHONE,
      sipRoomName: "room",
      sipParticipantIdentity: "sip",
      callerPhone: "+18135551234",
    });

    expect(buildTurnStateSummary(state)).toBeNull();
  });

  it("builds a compact turn summary for active booking state", () => {
    const state = createInitialCallState({
      officeKey: "spring-hill",
      officePhone: SPRING_HILL_OFFICE_PHONE,
      amdOfficePhone: SPRING_HILL_OFFICE_PHONE,
      sipRoomName: "room",
      sipParticipantIdentity: "sip",
      callerPhone: "+18135551234",
      phoneLookup: {
        status: "verified",
        patientId: "P123",
        name: "Maria Santos",
        dob: "03/05/1982",
        phone: "+18135551234",
        insuranceCarrier: "Florida Blue",
        insPlanId: "IP1",
        respPartyId: "RP1",
        routing: "accepted",
        allowedProviders: [],
        routingAmbiguous: false,
        appointments: [],
      },
    });
    state.workflow.intent = "schedule";
    state.workflow.activeFlow = "booking";
    state.scheduling.reasonForVisit = "blurry vision";
    state.scheduling.lastAvailabilitySummary =
      "Found 1 opening for 2026-04-24.";
    state.scheduling.selectedSlot = {
      startDatetime: "2026-04-24T10:00",
      columnId: 11,
      profileId: 22,
      duration: 30,
      appointmentTypeId: 1007,
    };

    const summary = buildTurnStateSummary(state);

    expect(summary).toContain("Current workflow state:");
    expect(summary).toContain("active step: booking");
    expect(summary).toContain("patient: Maria Santos");
    expect(summary).toContain("visit reason: blurry vision");
    expect(summary).toContain("selected slot: 2026-04-24T10:00");
    expect(summary).toContain(
      "next focus: confirm and book the selected slot already in state",
    );
  });

  it("injects a turn summary into the temporary chat context for the current reply only", async () => {
    const state = createInitialCallState({
      officeKey: "spring-hill",
      officePhone: SPRING_HILL_OFFICE_PHONE,
      amdOfficePhone: SPRING_HILL_OFFICE_PHONE,
      sipRoomName: "room",
      sipParticipantIdentity: "sip",
      callerPhone: "+18135551234",
      phoneLookup: {
        status: "verified",
        patientId: "P123",
        name: "Maria Santos",
        dob: "03/05/1982",
        phone: "+18135551234",
        insuranceCarrier: "Florida Blue",
        insPlanId: "IP1",
        respPartyId: "RP1",
        routing: "accepted",
        allowedProviders: [],
        routingAmbiguous: false,
        appointments: [],
      },
    });
    state.workflow.intent = "schedule";
    state.workflow.activeFlow = "availability";
    state.scheduling.reasonForVisit = "blurry vision";
    state.scheduling.lastAvailabilitySummary =
      "No openings returned for 2026-04-24.";

    const agent = new Agent(undefined, SPRING_HILL_OFFICE_PHONE);
    (agent as any)._agentActivity = { agentSession: { userData: state } };

    const chatCtx = llm.ChatContext.empty();

    await agent.onUserTurnCompleted(
      chatCtx,
      llm.ChatMessage.create({ role: "user", content: "Friday works" }),
    );

    const turnStateMessages = chatCtx.items.filter(
      (item) =>
        item.type === "message" &&
        item.role === "system" &&
        item.textContent?.includes("<turn_state>"),
    );

    expect(turnStateMessages).toHaveLength(1);
    expect(turnStateMessages[0]?.textContent).toContain(
      "active step: availability",
    );
    expect(turnStateMessages[0]?.textContent).toContain(
      "last availability: No openings returned for 2026-04-24.",
    );
  });

  it("describes appointment selection as its own workflow step", () => {
    const state = createInitialCallState({
      officeKey: "spring-hill",
      officePhone: SPRING_HILL_OFFICE_PHONE,
      amdOfficePhone: SPRING_HILL_OFFICE_PHONE,
      sipRoomName: "room",
      sipParticipantIdentity: "sip",
      callerPhone: "+18135551234",
      phoneLookup: {
        status: "verified",
        patientId: "P123",
        name: "Maria Santos",
        dob: "03/05/1982",
        phone: "+18135551234",
        insuranceCarrier: "Florida Blue",
        insPlanId: "IP1",
        respPartyId: "RP1",
        routing: "accepted",
        allowedProviders: [],
        routingAmbiguous: false,
        appointments: [],
      },
    });
    state.workflow.intent = "confirm";
    state.workflow.activeFlow = "existing_appointment";

    const summary = buildTurnStateSummary(state);

    expect(summary).toContain("active step: existing_appointment");
    expect(summary).toContain(
      "next focus: select the correct existing appointment before continuing",
    );
  });
});
