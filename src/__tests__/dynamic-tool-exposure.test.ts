import {
  AgentSession,
  type ChatContext,
  initializeLogger,
  ToolContext,
  voice,
} from "@livekit/agents";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createVoiceAgent } from "../agent.js";
import {
  DEV_OFFICE_PHONE,
  SPRING_HILL_OFFICE_PHONE,
} from "../customers/abita/profile.js";
import {
  buildToolsForTrunk,
  toolsForCallState,
} from "../runtime/tool-registry.js";
import type { CallState } from "../state/call-state.js";
import { setLastInsuranceEligibilityCheck } from "../scheduling/state.js";
import {
  createConfirmedPatientState,
  createTestCallState,
} from "./support/call-state.js";

class ToolCapturingFakeLLM extends voice.testing.FakeLLM {
  readonly toolRequests: string[][] = [];
  readonly contexts: ChatContext[] = [];

  override chat(options: Parameters<voice.testing.FakeLLM["chat"]>[0]) {
    const toolCtx = options.toolCtx as ToolContext<CallState> | undefined;
    this.toolRequests.push(Object.keys(toolCtx?.functionTools ?? {}).sort());
    this.contexts.push(options.chatCtx.copy());
    return super.chat(options);
  }
}

const BASE_TOOLS = [
  "check_insurance",
  "create_staff_task",
  "end_call",
  "resolve_patient",
  "transfer_call",
];

function visibleTools(state: CallState): string[] {
  const registered = buildToolsForTrunk(SPRING_HILL_OFFICE_PHONE);
  return Object.keys(toolsForCallState(registered, state).functionTools).sort();
}

function visibleTool(state: CallState, trunkPhone: string, name: string) {
  return toolsForCallState(buildToolsForTrunk(trunkPhone), state).functionTools[
    name
  ];
}

function patientProjections(chatCtx: ChatContext): string[] {
  return chatCtx.items.flatMap((item) =>
    item.type === "message" &&
    item.role === "system" &&
    item.textContent?.startsWith("Patient situation:")
      ? [item.textContent]
      : [],
  );
}

describe("dynamic tool exposure", () => {
  beforeAll(() => {
    initializeLogger({ pretty: false, level: "silent" });
  });

  const sessions: AgentSession<CallState>[] = [];

  afterEach(async () => {
    await Promise.all(sessions.splice(0).map((session) => session.close()));
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("withholds scheduling tools until Call State has an active patient", async () => {
    const llm = new ToolCapturingFakeLLM([
      {
        input: "I need an appointment.",
        content: "I can help with that.",
      },
    ]);
    const session = new AgentSession<CallState>({ llm });
    sessions.push(session);
    session.userData = createTestCallState();

    const { agent } = createVoiceAgent(SPRING_HILL_OFFICE_PHONE, {
      suppressGreeting: true,
    });
    const updateTools = vi.spyOn(agent, "updateTools");

    await session.start({
      agent,
    });
    await session.run({ userInput: "I need an appointment." }).wait();

    expect(llm.toolRequests).toEqual([BASE_TOOLS]);
    expect(updateTools).toHaveBeenCalledTimes(1);
    expect(Object.keys(agent.toolCtx.functionTools).sort()).toEqual(BASE_TOOLS);
    expect(session.history.items).toContainEqual(
      expect.objectContaining({
        type: "agent_config_update",
        toolsRemoved: expect.arrayContaining([
          "add_patient",
          "book_appointment",
          "cancel_appointment",
          "get_availability",
          "reschedule_appointment",
          "update_insurance",
        ]),
      }),
    );
  });

  it("exposes availability only after the patient becomes active", async () => {
    const llm = new ToolCapturingFakeLLM([
      {
        input: "I need an appointment.",
        content: "What is the reason for the visit?",
      },
    ]);
    const session = new AgentSession<CallState>({ llm });
    sessions.push(session);
    session.userData = createConfirmedPatientState();

    await session.start({
      agent: createVoiceAgent(SPRING_HILL_OFFICE_PHONE, {
        suppressGreeting: true,
      }).agent,
    });
    await session.run({ userInput: "I need an appointment." }).wait();

    expect(llm.toolRequests).toEqual([
      [...BASE_TOOLS, "get_availability"].sort(),
    ]);
  });

  it("advances the tool stage after a prerequisite succeeds in the same turn", async () => {
    const verifiedReply =
      "Verified existing patient Jane Doe. No upcoming appointments are loaded.";
    const llm = new ToolCapturingFakeLLM([
      {
        input: "This is for Jane Doe, January 2, 1980.",
        toolCalls: [
          {
            name: "resolve_patient",
            args: {
              firstName: "Jane",
              lastName: "Doe",
              dob: "01/02/1980",
            },
          },
        ],
      },
      {
        input: JSON.stringify(verifiedReply),
        content: "I found the patient record.",
      },
    ]);
    const session = new AgentSession<CallState>({ llm });
    sessions.push(session);
    session.userData = createTestCallState();

    await session.start({
      agent: createVoiceAgent(SPRING_HILL_OFFICE_PHONE, {
        identityLookup: async () => ({
          status: "verified",
          patientId: "patient-1",
          name: "Jane Doe",
          dob: "01/02/1980",
          phone: "+17275551212",
          insuranceCarrier: null,
          insPlanId: null,
          respPartyId: null,
          routing: null,
          allowedProviders: [],
          routingAmbiguous: false,
          preauthRequired: false,
          appointmentsStatus: "none",
          appointmentsMessage: null,
          appointments: [],
          message: null,
        }),
        suppressGreeting: true,
      }).agent,
    });
    await session
      .run({ userInput: "This is for Jane Doe, January 2, 1980." })
      .wait();

    expect(llm.toolRequests).toEqual([
      BASE_TOOLS,
      [...BASE_TOOLS, "get_availability"].sort(),
    ]);
    expect(patientProjections(llm.contexts[0]!)).toEqual([
      "Patient situation: no patient is active.",
    ]);
    expect(patientProjections(llm.contexts[1]!)).toEqual([
      expect.stringContaining("Jane Doe is the active existing patient."),
    ]);
    expect(
      session.history.items
        .filter(
          (item) =>
            item.type === "function_call" ||
            item.type === "function_call_output",
        )
        .map((item) => item.type),
    ).toEqual(["function_call", "function_call_output"]);
    expect(session.history.items).toContainEqual(
      expect.objectContaining({
        type: "agent_config_update",
        toolsAdded: ["get_availability"],
      }),
    );
  });

  it("rejects an out-of-stage tool call before its implementation executes", async () => {
    const error = `Unknown function: book_appointment - available tools: ${BASE_TOOLS.join(", ")}`;
    const llm = new ToolCapturingFakeLLM([
      {
        input: "Book the appointment.",
        toolCalls: [
          {
            name: "book_appointment",
            args: {
              appointmentReason: "Routine visit",
              appointmentSlotRef: "slot-1",
              readBack: true,
              referringDoctor: "None",
            },
          },
        ],
      },
      {
        input: error,
        content: "I need to verify the patient first.",
      },
    ]);
    const session = new AgentSession<CallState>({ llm });
    sessions.push(session);
    session.userData = createTestCallState();

    await session.start({
      agent: createVoiceAgent(SPRING_HILL_OFFICE_PHONE, {
        suppressGreeting: true,
      }).agent,
    });
    await session.run({ userInput: "Book the appointment." }).wait();

    const output = session.history.items.find(
      (item) => item.type === "function_call_output",
    );
    expect(output).toMatchObject({
      isError: true,
      output: error,
    });
    expect(session.userData.runtime.appointmentActions).toEqual([]);
  });

  it("returns the routine read-back prerequisite without a LiveKit error", async () => {
    const reminder =
      "Read back the new patient details first: patient name, date of birth, sex, address, callback phone, email if provided, insurance plan, policyholder name, and member ID. Call add_patient again only after the caller confirms the details are correct.";
    const llm = new ToolCapturingFakeLLM([
      {
        input: "Register Jane.",
        toolCalls: [
          {
            name: "add_patient",
            args: {
              city: "Spring Hill",
              dob: "01/01/1980",
              firstName: "Jane",
              insuranceMemberId: "self pay",
              lastName: "Doe",
              newPatientConfirmed: true,
              phone: "7275551212",
              sex: "female",
              state: "FL",
              street: "123 Main St",
              subscriberName: "Jane Doe",
              zip: "34606",
            },
          },
        ],
      },
      {
        input: JSON.stringify(reminder),
        content: "Let me read those details back for you.",
      },
    ]);
    const session = new AgentSession<CallState>({ llm });
    sessions.push(session);
    const state = createTestCallState();
    setLastInsuranceEligibilityCheck(state, {
      accepted: true,
      canonicalPlan: "VSP",
      coverageType: "routine_vision",
      currentCarrier: "VSP",
      plan: "VSP",
    });
    session.userData = state;

    await session.start({
      agent: createVoiceAgent(SPRING_HILL_OFFICE_PHONE, {
        suppressGreeting: true,
      }).agent,
    });
    await session.run({ userInput: "Register Jane." }).wait();

    expect(
      session.history.items.find(
        (item) => item.type === "function_call_output",
      ),
    ).toMatchObject({ isError: false, output: JSON.stringify(reminder) });
  });

  it("sends a recoverable operation failure to the model as a ToolError", async () => {
    vi.stubEnv(
      "ACUITY_PRODUCT_HANDOFF_URL",
      "https://product.example/v1/handoffs",
    );
    vi.stubEnv("ABITA_EYE_GROUP_PRODUCT_SERVICE_SECRET", "production-secret");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 503 })),
    );
    const failure =
      "I couldn't send the message. I can transfer you to the office.";
    const llm = new ToolCapturingFakeLLM([
      {
        input: "Send the office a message.",
        toolCalls: [
          {
            name: "create_staff_task",
            args: {
              category: "other",
              message: "Caller asked the office to return their call.",
              summary: "Caller requests a return call.",
              urgency: "normal",
            },
          },
        ],
      },
      { input: failure, content: "I can transfer you to the office." },
    ]);
    const session = new AgentSession<CallState>({ llm });
    sessions.push(session);
    session.userData = createTestCallState();

    await session.start({
      agent: createVoiceAgent(SPRING_HILL_OFFICE_PHONE, {
        suppressGreeting: true,
      }).agent,
    });
    await session.run({ userInput: "Send the office a message." }).wait();

    expect(
      session.history.items.find(
        (item) => item.type === "function_call_output",
      ),
    ).toMatchObject({ isError: true, output: failure });
  });

  it("lets LiveKit mask deterministic internal tool errors", async () => {
    const maskedError = "An internal error occurred";
    const llm = new ToolCapturingFakeLLM([
      {
        input: "Send the office a message.",
        toolCalls: [
          {
            name: "create_staff_task",
            args: {
              category: "other",
              message: "Caller asked the office to return their call.",
              summary: "Caller requests a return call.",
              urgency: "normal",
            },
          },
        ],
      },
      { input: maskedError, content: "I can connect you with the office." },
    ]);
    const session = new AgentSession<CallState>({ llm });
    sessions.push(session);
    session.userData = createTestCallState();

    await session.start({
      agent: createVoiceAgent(SPRING_HILL_OFFICE_PHONE, {
        suppressGreeting: true,
      }).agent,
    });
    await session.run({ userInput: "Send the office a message." }).wait();

    expect(
      session.history.items.find(
        (item) => item.type === "function_call_output",
      ),
    ).toMatchObject({ isError: true, output: maskedError });
  });

  it("advertises one legal scheduling stage at a time", () => {
    const unknownPatient = createTestCallState();
    expect(visibleTools(unknownPatient)).toEqual(BASE_TOOLS);

    setLastInsuranceEligibilityCheck(unknownPatient, {
      accepted: true,
      canonicalPlan: "Self Pay",
      coverageType: "medical",
      currentCarrier: "Self Pay",
      plan: "Self Pay",
    });
    expect(visibleTools(unknownPatient)).toEqual(
      [...BASE_TOOLS, "add_patient"].sort(),
    );

    const activePatient = createConfirmedPatientState();
    activePatient.identity.activePatient = {
      ...activePatient.identity.activePatient!,
      appointmentsStatus: "found",
      appointments: [
        {
          id: 1,
          date: "Monday, June 1, 2026",
          time: "9:00 AM",
          provider: "Dr. Bach",
          type: "Follow-up",
          facility: "Spring Hill",
          confirmed: false,
        },
      ],
    };
    setLastInsuranceEligibilityCheck(activePatient, {
      accepted: true,
      canonicalPlan: "Self Pay",
      coverageType: "medical",
      currentCarrier: "Self Pay",
      plan: "Self Pay",
    });
    expect(visibleTools(activePatient)).toEqual(
      [
        ...BASE_TOOLS,
        "add_patient",
        "cancel_appointment",
        "get_availability",
        "update_insurance",
      ].sort(),
    );

    activePatient.availability.slots = [
      {
        slotId: "S1",
        spoken: "Monday, June 8 at 9:00 AM",
        provider: "Dr. Bach",
        date: "2026-06-08",
        time: "9:00 AM",
        datetime: "2026-06-08T09:00:00-04:00",
        routing: "all_three",
      },
    ];
    activePatient.workflow.current = {
      appointmentLane: "medical_md",
      intent: "schedule",
    };
    expect(visibleTools(activePatient)).toEqual(
      [
        ...BASE_TOOLS,
        "add_patient",
        "book_appointment",
        "cancel_appointment",
        "get_availability",
        "update_insurance",
      ].sort(),
    );

    activePatient.workflow.current.intent = "change_appointment";
    expect(visibleTools(activePatient)).toEqual(
      [
        ...BASE_TOOLS,
        "add_patient",
        "cancel_appointment",
        "get_availability",
        "reschedule_appointment",
        "update_insurance",
      ].sort(),
    );
  });

  it("keeps dynamically exposed rheumatology registration tools medical-only", () => {
    const unknownPatient = createTestCallState();
    setLastInsuranceEligibilityCheck(unknownPatient, {
      accepted: true,
      canonicalPlan: "Self Pay",
      coverageType: "medical",
      currentCarrier: "Self Pay",
      plan: "Self Pay",
    });
    const addPatient = visibleTool(
      unknownPatient,
      DEV_OFFICE_PHONE,
      "add_patient",
    );
    const addPatientSchema = z.toJSONSchema(addPatient!.parameters) as {
      properties: Record<string, { description?: string }>;
    };

    expect(addPatientSchema.properties).not.toHaveProperty("ssnLast4");
    expect(addPatient!.description).not.toMatch(/routine.?vision|SSN/i);
    expect(
      Object.values(addPatientSchema.properties)
        .map(({ description }) => description ?? "")
        .join(" "),
    ).not.toMatch(/routine.?vision|SSN/i);

    const activePatient = createConfirmedPatientState();
    setLastInsuranceEligibilityCheck(activePatient, {
      accepted: true,
      canonicalPlan: "Self Pay",
      coverageType: "medical",
      currentCarrier: "Self Pay",
      plan: "Self Pay",
    });
    const updateInsurance = visibleTool(
      activePatient,
      DEV_OFFICE_PHONE,
      "update_insurance",
    );

    expect(updateInsurance!.description).toContain("medical coverage");
    expect(updateInsurance!.description).not.toMatch(/routine.?vision/i);
  });
});
