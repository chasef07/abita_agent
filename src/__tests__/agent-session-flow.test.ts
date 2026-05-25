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

  it("records turn understanding and then allows a follow-up tool", async () => {
    const llmModel = new ScriptedToolAwareLLM(({ callIndex }) => {
      if (callIndex === 0) {
        return {
          type: "tool",
          name: "record_turn_understanding",
          args: scheduleUnderstanding(),
        };
      }
      if (callIndex === 1) {
        return {
          type: "tool",
          name: "lookup_knowledge",
          args: { question: "office hours" },
        };
      }
      return { type: "message", content: "done" };
    });
    const { session, state } = await createFixture({ llmModel });
    state.latestUserTranscript =
      "I need a routine vision appointment next week";
    state.turnUnderstandingAppliedForTranscript = null;

    const result = session.run({
      userInput: "I need a routine vision appointment next week",
    });
    await result.wait();

    expect(state.turnUnderstandingAppliedForTranscript).toBe(
      "I need a routine vision appointment next week",
    );
    expect(state.flow.activeIntent).toBe("new_appointment");
    expect(functionCallNames(result.events)).toEqual([
      "record_turn_understanding",
      "lookup_knowledge",
    ]);
    expect(functionOutputText(result.events)).not.toContain(
      "turn_understanding_required",
    );
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

  it("keeps downstream tools visible while record_turn_understanding is pending", async () => {
    const seenToolSets: string[][] = [];
    const llmModel = new ScriptedToolAwareLLM(({ callIndex, toolNames }) => {
      seenToolSets.push(toolNames);
      if (callIndex === 0) {
        return {
          type: "tool",
          name: "record_turn_understanding",
          args: scheduleUnderstanding(),
        };
      }
      if (callIndex === 1) {
        return toolNames.includes("get_availability")
          ? {
              type: "tool",
              name: "lookup_knowledge",
              args: { question: "office hours" },
            }
          : {
              type: "tool",
              name: "missing_tool",
              args: {},
            };
      }
      return { type: "message", content: "done" };
    });
    const { session, state } = await createFixture({
      llmModel,
      dynamicToolsEnabled: true,
    });
    state.latestUserTranscript = "I need a medical appointment next Monday";
    state.turnUnderstandingAppliedForTranscript = null;
    state.flow.activeFlow = "scheduling";
    state.flow.step = "get_availability";
    await refreshAgentToolsForSession(session, "turn_update_pending");

    const result = session.run({
      userInput: "I need a medical appointment next Monday",
    });
    await result.wait();

    expect(seenToolSets[0][0]).toBe("record_turn_understanding");
    expect(seenToolSets[0]).toContain("get_availability");
    expect(seenToolSets[1]).toContain("get_availability");
    expect(functionCallNames(result.events)).toEqual([
      "record_turn_understanding",
      "lookup_knowledge",
    ]);
    expect(state.latestToolExposure).toMatchObject({
      reason: "planner_guidance_broad:scheduling:needs_verified_patient",
      refreshReason: "turn_understanding_recorded",
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
    appointments: [],
    transferred: false,
    transferInFlight: false,
    ...overrides,
  };
}

function scheduleUnderstanding() {
  return {
    goal: "schedule",
    patient: {
      patientMentioned: "caller",
      relationshipToCaller: "self",
    },
    scheduling: {
      visitType: "medical",
      visitReason: "eye exam",
      preferredWindow: "next Monday",
    },
    interruption: "none",
    confidence: 0.92,
    evidence: ["appointment", "next Monday"],
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
