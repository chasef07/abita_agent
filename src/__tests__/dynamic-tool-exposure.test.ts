import {
  AgentSession,
  initializeLogger,
  ToolContext,
  voice,
} from "@livekit/agents";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createVoiceAgent } from "../agent.js";
import { SPRING_HILL_OFFICE_PHONE } from "../customers/abita/profile.js";
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

  override chat(options: Parameters<voice.testing.FakeLLM["chat"]>[0]) {
    const toolCtx = options.toolCtx as ToolContext<CallState> | undefined;
    this.toolRequests.push(Object.keys(toolCtx?.functionTools ?? {}).sort());
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

    const { agent } = createVoiceAgent("no_match", SPRING_HILL_OFFICE_PHONE, {
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
      agent: createVoiceAgent("verified", SPRING_HILL_OFFICE_PHONE, {
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
      agent: createVoiceAgent("no_match", SPRING_HILL_OFFICE_PHONE, {
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
      agent: createVoiceAgent("no_match", SPRING_HILL_OFFICE_PHONE, {
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

  it("returns routine caller-data prerequisites without a LiveKit error", async () => {
    const reminder =
      "Collect the patient's SSN last four before creating a routine-vision chart.";
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
              readBack: true,
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
        content: "What are the last four digits?",
      },
    ]);
    const session = new AgentSession<CallState>({ llm });
    sessions.push(session);
    const state = createTestCallState();
    setLastInsuranceEligibilityCheck(state, {
      accepted: true,
      canonicalPlan: "Self Pay",
      coverageType: "routine_vision",
      currentCarrier: "Self Pay",
      plan: "Self Pay",
    });
    session.userData = state;

    await session.start({
      agent: createVoiceAgent("no_match", SPRING_HILL_OFFICE_PHONE, {
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
      agent: createVoiceAgent("no_match", SPRING_HILL_OFFICE_PHONE, {
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
      agent: createVoiceAgent("no_match", SPRING_HILL_OFFICE_PHONE, {
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

    const activePatient = createConfirmedPatientState({
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
    });
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
        "cancel_appointment",
        "get_availability",
        "reschedule_appointment",
        "update_insurance",
      ].sort(),
    );
  });
});
