import {
  DEFAULT_API_CONNECT_OPTIONS,
  initializeLogger,
  llm,
  voice,
  type APIConnectOptions,
} from "@livekit/agents";
import { beforeAll, describe, expect, it } from "vitest";
import { Agent } from "../agent.js";
import { DEV_OFFICE_PHONE } from "../customer/profile.js";
import { createInitialFlowState } from "../flow/index.js";
import type { CallState } from "../tooling/call-state.js";
import { bindDynamicToolRefresher } from "../tooling/dynamic-tool-refresh.js";
import {
  applyDynamicToolsToAgent,
  refreshAgentToolsForSession,
} from "../tooling/tool-registry.js";

type ScriptedDecision =
  | {
      type: "tool";
      name: string;
      args?: Record<string, unknown>;
    }
  | {
      type: "message";
      content: string;
    };

describe("agent session flow integration", () => {
  beforeAll(() => {
    initializeLogger({ pretty: false, level: "silent" });
  });

  it("allows safe tools even before record_turn_understanding runs", async () => {
    const llmModel = new ScriptedToolAwareLLM(({ callIndex }) =>
      callIndex === 0
        ? {
            type: "tool",
            name: "lookup_knowledge",
            args: { question: "office hours" },
          }
        : { type: "message", content: "done" },
    );
    const { session, state } = await createFixture({ llmModel });
    state.latestUserTranscript = "I need to move my appointment next week";
    state.turnUnderstandingAppliedForTranscript = null;

    const result = session.run({
      userInput: "I need to move my appointment next week",
    });
    await result.wait();

    expect(functionCallNames(result.events)).toContain("lookup_knowledge");
    expect(functionOutputText(result.events)).not.toContain(
      "turn_understanding_required",
    );
    expect(functionOutputText(result.events)).toContain("Knowledge source:");
    await session.close();
  });

  it("auto-records obvious scheduling intent before the model responds", async () => {
    const llmModel = new ScriptedToolAwareLLM(() => ({
      type: "message",
      content: "done",
    }));
    const { session, state, agent } = await createFixture({ llmModel });
    await agent.onUserTurnCompleted(
      new llm.ChatContext(),
      llm.ChatMessage.create({
        role: "user",
        content: "I need a routine vision appointment next week",
      }),
    );

    expect(state.turnUnderstandingAppliedForTranscript).toBe(
      "I need a routine vision appointment next week",
    );
    expect(state.flow.activeIntent).toBe("new_appointment");
    await session.close();
  });

  it("keeps legacy tool behavior when the flow harness is disabled", async () => {
    const llmModel = new ScriptedToolAwareLLM(({ callIndex }) =>
      callIndex === 0
        ? {
            type: "tool",
            name: "lookup_knowledge",
            args: { question: "office hours" },
          }
        : { type: "message", content: "done" },
    );
    const { session } = await createFixture({
      llmModel,
      flowHarnessEnabled: false,
    });

    const result = session.run({ userInput: "what are your hours?" });
    await result.wait();

    expect(functionCallNames(result.events)).toContain("lookup_knowledge");
    expect(functionOutputText(result.events)).not.toContain(
      "turn_understanding_required",
    );
    expect(functionOutputText(result.events)).toContain("Hours");
    await session.close();
  });

  it("keeps downstream tools visible while automatic turn understanding is pending", async () => {
    const llmModel = new ScriptedToolAwareLLM(() => ({
      type: "message",
      content: "done",
    }));
    const { session, state, agent } = await createFixture({
      llmModel,
      dynamicToolsEnabled: true,
    });
    state.flow.activeFlow = "scheduling";
    state.flow.step = "get_availability";
    state.flow.patientStatus = "verified";
    state.flow.patients[state.flow.activePatientRef!].status = "verified";
    await agent.onUserTurnCompleted(
      new llm.ChatContext(),
      llm.ChatMessage.create({
        role: "user",
        content: "I need a medical appointment next Monday",
      }),
    );

    expect(state.latestToolExposure?.visibleToolNames).not.toContain(
      "record_turn_understanding",
    );
    expect(state.latestToolExposure?.visibleToolNames).toContain(
      "get_availability",
    );
    expect(state.latestToolExposure).toMatchObject({
      reason: "planner_guidance_broad:scheduling:searching_availability",
      refreshReason: "turn_update_auto_recorded",
    });
    await session.close();
  });
});

class ScriptedToolAwareLLM extends llm.LLM {
  private callCount = 0;

  constructor(
    private readonly decide: (input: {
      callIndex: number;
      toolNames: string[];
    }) => ScriptedDecision,
  ) {
    super();
  }

  label(): string {
    return "scripted-tool-aware-llm";
  }

  chat({
    chatCtx,
    toolCtx,
    connOptions = DEFAULT_API_CONNECT_OPTIONS,
  }: {
    chatCtx: llm.ChatContext;
    toolCtx?: llm.ToolContext;
    connOptions?: APIConnectOptions;
  }): llm.LLMStream {
    const callIndex = this.callCount++;
    return new ScriptedToolAwareLLMStream(this, {
      chatCtx,
      toolCtx,
      connOptions,
      decision: this.decide({
        callIndex,
        toolNames: Object.keys(toolCtx ?? {}),
      }),
      callIndex,
    });
  }
}

class ScriptedToolAwareLLMStream extends llm.LLMStream {
  constructor(
    llmModel: llm.LLM,
    private readonly options: {
      chatCtx: llm.ChatContext;
      toolCtx?: llm.ToolContext;
      connOptions: APIConnectOptions;
      decision: ScriptedDecision;
      callIndex: number;
    },
  ) {
    super(llmModel, options);
  }

  protected async run(): Promise<void> {
    if (this.options.decision.type === "message") {
      this.queue.put({
        id: `scripted-${this.options.callIndex}`,
        delta: {
          role: "assistant",
          content: this.options.decision.content,
        },
      });
      return;
    }

    this.queue.put({
      id: `scripted-${this.options.callIndex}`,
      delta: {
        role: "assistant",
        toolCalls: [
          llm.FunctionCall.create({
            callId: `scripted_call_${this.options.callIndex}`,
            name: this.options.decision.name,
            args: JSON.stringify(this.options.decision.args ?? {}),
          }),
        ],
      },
    });
  }
}

async function createFixture({
  llmModel,
  flowHarnessEnabled = true,
  dynamicToolsEnabled = false,
}: {
  llmModel: llm.LLM;
  flowHarnessEnabled?: boolean;
  dynamicToolsEnabled?: boolean;
}) {
  const state = createCallState({ flowHarnessEnabled, dynamicToolsEnabled });
  const session = new voice.AgentSession<CallState>({
    llm: llmModel,
    userData: state,
    maxToolSteps: 5,
  });
  const agent = new Agent(null, DEV_OFFICE_PHONE, {
    suppressGreeting: true,
  });

  if (dynamicToolsEnabled) {
    await applyDynamicToolsToAgent(agent, state, "startup");
    bindDynamicToolRefresher(session, (reason) =>
      refreshAgentToolsForSession(session, reason),
    );
  }

  await session.start({ agent });

  return { session, agent, state };
}

function createCallState(overrides: Partial<CallState> = {}): CallState {
  return {
    flow: createInitialFlowState({
      officeKey: "dev",
      patientId: "patient-1",
      patientName: "Jane Doe",
      dob: "01/01/1980",
      callerPhone: "+17275551212",
      routing: "all_three",
      coverageType: "medical",
    }),
    flowHarnessEnabled: true,
    flowGuardObservations: [],
    preCallLookup: {
      status: "verified",
      durationMs: 12,
    },
    latestUserTranscript: null,
    turnUnderstandingAppliedForTranscript: null,
    officeKey: "dev",
    amdOfficePhone: DEV_OFFICE_PHONE,
    sipRoomName: "room",
    sipParticipantIdentity: "caller",
    callId: "call-123",
    callerPhone: "+17275551212",
    trunkPhone: DEV_OFFICE_PHONE,
    patientId: "patient-1",
    patientName: "Jane Doe",
    dob: "01/01/1980",
    insuranceCarrier: "Aetna",
    insPlanId: "plan-1",
    respPartyId: "resp-1",
    checkedInsurancePlan: "Aetna",
    checkedInsuranceCoverageType: "medical",
    routing: "all_three",
    lastAvailabilityRouting: null,
    lastAvailabilitySlots: [],
    allowedProviders: [],
    routingAmbiguous: false,
    preauthRequired: false,
    appointmentsStatus: null,
    appointments: [],
    transferred: false,
    transferInFlight: false,
    ...overrides,
  };
}

function functionCallNames(events: Array<{ type: string; item: unknown }>) {
  return events
    .filter((event) => event.type === "function_call")
    .map((event) => (event.item as { name: string }).name);
}

function functionOutputText(events: Array<{ type: string; item: unknown }>) {
  return events
    .filter((event) => event.type === "function_call_output")
    .map((event) => JSON.stringify(event.item))
    .join("\n");
}
