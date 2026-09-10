import {
  AgentSession,
  type ChatContext,
  initializeLogger,
  isFunctionTool,
  voice,
} from "@livekit/agents";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createResolvePatientTool } from "../tools/resolve-patient.js";
import { createVoiceAgent } from "../agent.js";
import {
  SPRING_HILL_OFFICE_PHONE,
  SWEETWATER_OFFICE_PHONE,
  SWEETWATER_TRUNK_PHONES,
} from "../customers/abita/profile.js";
import { simulationTools } from "../runtime/simulation.js";
import type { CallState } from "../state/call-state.js";
import { staffTaskReceipts } from "../state/observability.js";
import {
  confirmedActivePatient,
  createConfirmedPatientState,
  createTestCallState,
} from "./support/call-state.js";
import { InMemoryOwnedMiddleware } from "./support/owned-middleware.js";
import { staffTaskCases } from "./support/staff-task-cases.js";
import { captureStaffTaskTransport } from "./support/staff-task-transport.js";

// The LLM boundary is scripted. These tests prove context delivery and actual
// execution/receipts, not an unscripted model's language understanding.
class CapturingLLM extends voice.testing.FakeLLM {
  contexts: ChatContext[] = [];
  override chat(options: Parameters<voice.testing.FakeLLM["chat"]>[0]) {
    this.contexts.push(options.chatCtx.copy());
    const chatCtx = options.chatCtx.copy();
    if (chatCtx.items.at(-1)?.type === "message") {
      const user = [...chatCtx.items]
        .reverse()
        .find((item) => item.type === "message" && item.role === "user");
      if (user?.type === "message")
        chatCtx.addMessage({ role: "user", content: user.textContent ?? "" });
    }
    return super.chat({ ...options, chatCtx });
  }
}

const sessions: AgentSession<CallState>[] = [];
beforeAll(() => initializeLogger({ pretty: false, level: "silent" }));
beforeEach(() => {
  vi.stubEnv(
    "ACUITY_PRODUCT_HANDOFF_URL",
    "https://staff-task.invalid/v1/handoffs",
  );
  vi.stubEnv("ABITA_EYE_GROUP_PRODUCT_SERVICE_SECRET", "synthetic-only");
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Network forbidden");
    }),
  );
});
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function start(llm: CapturingLLM, state = createConfirmedPatientState()) {
  const transport = captureStaffTaskTransport();
  const session = new AgentSession<CallState>({ llm, userData: state });
  sessions.push(session);
  const { agent } = createVoiceAgent(state.runtime.trunkPhone, {
    ownedMiddleware: new InMemoryOwnedMiddleware(),
    suppressGreeting: true,
    staffTaskFetch: transport.fetch,
  });
  const task = agent.toolCtx.tools.find(
    (entry) => isFunctionTool(entry) && entry.name === "create_staff_task",
  );
  if (!task) throw new Error("Task not registered");
  // Only this test fixture restores the real task with an inert HTTP boundary.
  // The hosted simulation entry point still excludes both effectful tools.
  await agent.updateTools([...simulationTools(agent.toolCtx.tools), task]);
  await session.start({ agent });
  return { session, state, transport };
}

async function turn(session: AgentSession<CallState>, transcript: string) {
  const activity = await session.waitForIdle();
  await activity.onEndOfTurn({
    endOfUtteranceDelay: 0,
    newTranscript: transcript,
    startedSpeakingAt: undefined,
    stoppedSpeakingAt: undefined,
    transcriptionDelay: 0,
    transcriptConfidence: 0.99,
  });
  await session.waitForIdle();
}

function args(scenario: (typeof staffTaskCases)[number]) {
  return {
    category: scenario.category,
    urgency: "normal",
    summary: scenario.id.replaceAll("_", " "),
    message: scenario.message,
  };
}
function modelText(llm: CapturingLLM) {
  return llm.contexts
    .flatMap((ctx) =>
      ctx.items.flatMap((item) =>
        item.type === "message" ? [item.textContent ?? ""] : [],
      ),
    )
    .join("\n");
}

describe("controlled staff-intake conversation execution", () => {
  it("tells the model which caller-reported task patient supersedes earlier chart context", async () => {
    const state = createConfirmedPatientState();
    await createResolvePatientTool(new InMemoryOwnedMiddleware()).execute(
      { firstName: "Morgan", lastName: null, dob: null },
      {
        ctx: {
          session: { userData: state },
          disallowInterruptions() {},
        } as never,
        toolCallId: "partial-target",
      } as never,
    );
    const input =
      "I cannot provide Morgan's last name or DOB. Please send the records request for Morgan.";
    const llm = new CapturingLLM([
      {
        input,
        toolCalls: [
          {
            name: "create_staff_task",
            args: {
              category: "documentation",
              urgency: "normal",
              summary: "Morgan records request",
              message:
                "Morgan requests records. Missing details: surname and DOB.",
            },
          },
        ],
      },
    ]);
    const { session, transport } = await start(llm, state);
    await session.run({ userInput: input }).wait();
    expect(modelText(llm)).toContain(
      'Staff Task patient is caller-reported: {"name":"Morgan"}',
    );
    expect(modelText(llm)).toContain(
      "Earlier active-chart details belong to earlier work",
    );
    expect(transport.payloads[0]?.patient).toEqual({ name: "Morgan" });
  });

  it.each(staffTaskCases)(
    "preserves $id intake through the registered tool and receipt",
    async (scenario) => {
      const llm = new CapturingLLM([
        {
          input: scenario.caller,
          toolCalls: [{ name: "create_staff_task", args: args(scenario) }],
        },
      ]);
      const state =
        scenario.id === "patient_incomplete"
          ? createTestCallState()
          : createConfirmedPatientState({
              activePatient: confirmedActivePatient({
                name: "Alex Example",
                dob: "02/03/1990",
              }),
            });
      const { session, transport } = await start(llm, state);
      await session.run({ userInput: scenario.caller }).wait();
      expect(transport.payloads).toHaveLength(1);
      expect(transport.payloads[0]).toMatchObject({
        ...args(scenario),
        callId: "call-test",
        source: "agent",
        officeKey: "spring-hill",
        callerPhone: "+17275551212",
      });
      expect(staffTaskReceipts(state)).toMatchObject([
        { status: "created", taskId: "synthetic-task-1" },
      ]);
      expect(modelText(llm)).toContain(
        "staff review, not that the underlying issue is resolved",
      );
      if (scenario.category === "documentation") {
        expect(modelText(llm)).toContain(
          "both the records request and patient authorization",
        );
        expect(modelText(llm)).toContain(
          "full visit notes are excluded from patient email delivery",
        );
      }
      if (scenario.id === "patient_incomplete")
        expect(transport.payloads[0]).not.toHaveProperty("patient");
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("keeps two distinct needs in the same bucket and a medication/service PA pair independent on the called office", async () => {
    const cases = staffTaskCases.filter((item) =>
      [
        "expedited_glasses",
        "expedited_contacts",
        "pharmacy_pa",
        "test_authorization",
      ].includes(item.id),
    );
    const llm = new CapturingLLM(
      cases.map((scenario) => ({
        input: scenario.caller,
        toolCalls: [{ name: "create_staff_task", args: args(scenario) }],
      })),
    );
    const { session, transport } = await start(
      llm,
      createConfirmedPatientState({
        officeKey: "sweetwater",
        amdOfficePhone: SWEETWATER_OFFICE_PHONE,
        trunkPhone: SWEETWATER_TRUNK_PHONES[1],
      }),
    );
    for (const scenario of cases)
      await session.run({ userInput: scenario.caller }).wait();
    expect(transport.payloads.map((payload) => payload.category)).toEqual([
      "optical",
      "optical",
      "medication",
      "insurance",
    ]);
    expect(
      new Set(transport.payloads.map((payload) => payload.idempotencyKey)).size,
    ).toBe(4);
    for (const payload of transport.payloads)
      expect(payload).toMatchObject({
        callId: "call-test",
        officeKey: "sweetwater",
        inboundOfficePhone: SWEETWATER_TRUNK_PHONES[1],
      });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [
      "How much is a self-pay medical visit for a new patient?",
      "Self-Pay Pricing",
      "$250",
    ],
    [
      "I have a question about the balance on my bill.",
      "Billing",
      "(786) 446-8333",
    ],
  ])(
    "supplies the approved answer and creates no task for %s",
    async (input, heading, evidence) => {
      const llm = new CapturingLLM([
        { input, content: "Here is the supplied office information." },
      ]);
      const { session, state, transport } = await start(llm);
      await turn(session, input);
      expect(modelText(llm)).toContain(`## ${heading}`);
      expect(modelText(llm)).toContain(evidence);
      expect(transport.payloads).toEqual([]);
      expect(state.runtime.knowledgeRetrievals).toMatchObject([
        { outcome: "matched" },
      ]);
      expect(modelText(llm)).toContain(
        "A satisfied question or completed scheduling action needs no Task",
      );
    },
  );

  it("retains unresolved staff help after a supplied answer, including mixed billing and records", async () => {
    const scenario = staffTaskCases.find(
      (item) => item.id === "patient_email_full_notes",
    )!;
    const input = `I have a billing question and also: ${scenario.caller}`;
    const llm = new CapturingLLM([
      {
        input,
        toolCalls: [{ name: "create_staff_task", args: args(scenario) }],
      },
    ]);
    const { session, transport } = await start(llm);
    await turn(session, input);
    expect(modelText(llm)).toContain("(786) 446-8333");
    expect(transport.payloads.map((item) => item.category)).toEqual([
      "documentation",
    ]);
  });

  it("keeps short clarification and urgent transfer precedence in the real model context", async () => {
    const input = "I need help with my prescription.";
    const llm = new CapturingLLM([
      {
        input,
        content:
          "Is that a glasses or contact lens prescription, or medication?",
      },
    ]);
    const { session, transport } = await start(llm);
    await session.run({ userInput: input }).wait();
    const context = modelText(llm);
    expect(context).toContain(
      "Briefly clarify ambiguous prescriptions (glasses/contacts or medication)",
    );
    expect(context).toContain(
      "authorizations (medication, service, or records release)",
    );
    expect(context).toContain("before or after surgery");
    expect(context).toContain(
      "Immediately call transfer_call only for an eye emergency",
    );
    expect(context).toContain(
      "leave clinical advice to staff and transfer before intake when required",
    );
    expect(transport.payloads).toEqual([]);
    expect(SPRING_HILL_OFFICE_PHONE).toBe(session.userData.runtime.trunkPhone);
  });
});
