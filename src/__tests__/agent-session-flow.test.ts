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

  it("applies pre-call first-name confirmation even when there is no scheduling intent", async () => {
    const llmModel = new ScriptedToolAwareLLM(() => ({
      type: "message",
      content: "done",
    }));
    const { session, state, agent } = await createFixture({ llmModel });
    state.flow.preCall = {
      status: "single_match_pending_confirmation",
      source: "phone_lookup",
      callerPhone: "+17275551212",
      candidates: [
        {
          ref: "caller",
          firstName: "Jane",
          lastName: "Doe",
          dob: "01/01/1980",
          patientId: "patient-1",
          relationshipToCaller: "self",
          appointments: [],
        },
      ],
      selectedCandidateRef: "caller",
      identityPromotion: "none",
    };

    await agent.onUserTurnCompleted(
      new llm.ChatContext(),
      llm.ChatMessage.create({
        role: "user",
        content: "Jane",
      }),
    );

    expect(state.turnUnderstandingAppliedForTranscript).toBe("Jane");
    expect(state.flow.preCall.status).toBe("single_match_confirmed");
    expect(state.flow.patientStatus).toBe("verified");
    await session.close();
  });

  it("activates a full pre-call multiple-match candidate and stores its details", async () => {
    const llmModel = new ScriptedToolAwareLLM(() => ({
      type: "message",
      content: "done",
    }));
    const { session, state, agent } = await createFixture({ llmModel });
    state.flow.preCall = {
      status: "multiple_matches_pending_selection",
      source: "phone_lookup",
      callerPhone: "+17275551212",
      candidates: [
        {
          ref: "precall:1",
          firstName: "Jane",
          lastName: "Doe",
          dob: "01/01/1980",
          patientId: "patient-1",
          appointments: [],
          appointmentsStatus: "none",
          insuranceCarrier: "Aetna",
          routing: "all_three",
          allowedProviders: ["Dr. Bach"],
          appointmentCancelTokens: {},
          preauthRequired: false,
        },
        {
          ref: "precall:2",
          firstName: "Maria",
          lastName: "Doe",
          dob: "02/02/1985",
          patientId: "patient-2",
          appointments: [
            {
              id: 456,
              date: "Tuesday, June 2, 2026",
              time: "9:00 AM",
              provider: "Dr. Bach",
              type: "Follow-up",
              facility: "Spring Hill",
              confirmed: true,
            },
          ],
          appointmentsStatus: "found",
          appointmentCancelTokens: { "456": "cancel-token-456" },
          insuranceCarrier: "Humana",
          insPlanId: "plan-2",
          respPartyId: "resp-2",
          routing: "bach_only",
          allowedProviders: ["Dr. Bach"],
          routingAmbiguous: false,
          preauthRequired: true,
        },
      ],
      identityPromotion: "none",
    };

    await agent.onUserTurnCompleted(
      new llm.ChatContext(),
      llm.ChatMessage.create({
        role: "user",
        content: "Maria",
      }),
    );

    expect(state.turnUnderstandingAppliedForTranscript).toBe("Maria");
    expect(state.flow.preCall).toMatchObject({
      status: "multiple_match_confirmed",
      selectedCandidateRef: "precall:2",
    });
    expect(state.flow.patientStatus).toBe("verified");
    expect(state.flow.activePatientRef).toBe("precall:2");
    expect(state.patientId).toBe("patient-2");
    expect(state.patientName).toBe("Maria Doe");
    expect(state.dob).toBe("02/02/1985");
    expect(state.insuranceCarrier).toBe("Humana");
    expect(state.insPlanId).toBe("plan-2");
    expect(state.respPartyId).toBe("resp-2");
    expect(state.routing).toBe("bach_only");
    expect(state.preauthRequired).toBe(true);
    expect(state.allowedProviders).toEqual(["Dr. Bach"]);
    expect(state.appointments).toEqual([expect.objectContaining({ id: 456 })]);
    expect(state.appointmentsStatus).toBe("found");
    expect(state.appointmentCancelTokens).toEqual({
      "456": "cancel-token-456",
    });
    await session.close();
  });

  it("auto-confirms a single pre-call match when spelled STT drops the leading first-name initial", async () => {
    const llmModel = new ScriptedToolAwareLLM(() => ({
      type: "message",
      content: "done",
    }));
    const { session, state, agent } = await createFixture({ llmModel });
    state.flow = createInitialFlowState({
      officeKey: "sweetwater",
      patientId: "17611424",
      patientName: "HERNANDEZ, BELTRAN",
      dob: "11/10/2022",
      appointments: [
        {
          id: 20755875,
          date: "Tuesday, June 16, 2026",
          time: "2:00 PM",
          provider: "Dr. Austin Bach",
          type: "New Pediatric Medical",
          facility: "Abita Eye Group Hollywood",
        },
      ],
      appointmentsStatus: "found",
      callerPhone: "+13058247019",
      preCall: {
        status: "single_match_pending_confirmation",
        source: "phone_lookup",
        callerPhone: "+13058247019",
        candidates: [
          {
            ref: "caller",
            firstName: "BELTRAN",
            lastName: "HERNANDEZ",
            dob: "11/10/2022",
            patientId: "17611424",
            relationshipToCaller: "self",
            appointments: [],
            appointmentsStatus: "found",
          },
        ],
        selectedCandidateRef: "caller",
        identityPromotion: "none",
      },
    });

    await agent.onUserTurnCompleted(
      new llm.ChatContext(),
      llm.ChatMessage.create({
        role: "user",
        content: "E-L-T-R-A-N.",
      }),
    );

    expect(state.turnUnderstandingAppliedForTranscript).toBe("E-L-T-R-A-N.");
    expect(state.flow.preCall?.status).toBe("single_match_confirmed");
    expect(state.flow.patientStatus).toBe("verified");
    expect(state.flow.activePatientRef).toBe("caller");
    expect(Object.keys(state.flow.patients)).toEqual(["caller"]);
    await session.close();
  });

  it("clears patient-scoped state when pre-call identity switches patients", async () => {
    const llmModel = new ScriptedToolAwareLLM(() => ({
      type: "message",
      content: "done",
    }));
    const { session, state, agent } = await createFixture({ llmModel });
    state.flow.preCall = {
      status: "single_match_pending_confirmation",
      source: "phone_lookup",
      callerPhone: "+17275551212",
      candidates: [
        {
          ref: "caller",
          firstName: "Jane",
          patientId: "patient-1",
          relationshipToCaller: "self",
          appointments: [],
        },
      ],
      selectedCandidateRef: "caller",
      identityPromotion: "none",
    };
    state.flow.availabilitySearches = [
      {
        id: "search-1",
        patientRef: "caller",
        officeKey: "dev",
        searchedKeys: [],
        cachedSlots: [],
        rejectedSlotHashes: [],
        exactSearchCount: 0,
        broadenCount: 0,
        duplicateSearchCount: 0,
        maxSearches: 3,
        failureReasons: [],
        status: "active",
      },
    ];
    state.flow.pendingActions = [
      {
        id: "pending_cancel_1",
        type: "cancel_appt",
        patientRef: "caller",
        appointmentId: 123,
        argsHash: "cancel-123",
        spokenSummary: "cancel old appointment",
        confirmed: true,
        consumed: false,
        createdTurnId: "turn-1",
      },
    ];
    state.lastAvailabilityRouting = "all_three";
    state.lastAvailabilitySlots = [
      {
        slotId: "slot-1",
        spoken: "Monday at 9 AM",
        provider: "Dr. Bach",
        date: "2026-06-01",
        time: "9:00 AM",
        datetime: "2026-06-01T09:00:00",
        routing: "all_three",
      },
    ];
    state.appointments = [
      {
        id: 123,
        date: "2026-06-01",
        time: "9:00 AM",
        provider: "Dr. Bach",
        type: "Follow-up",
        facility: "Spring Hill",
        confirmed: true,
      },
    ];
    state.appointmentCancelTokens = { "123": "stale-token" };

    await agent.onUserTurnCompleted(
      new llm.ChatContext(),
      llm.ChatMessage.create({
        role: "user",
        content: "Maria",
      }),
    );

    expect(state.flow.activePatientRef).toMatch(/^candidate:/);
    expect(state.patientId).toBeNull();
    expect(state.patientName).toBe("Maria");
    expect(state.dob).toBeNull();
    expect(state.checkedInsurancePlan).toBeNull();
    expect(state.routing).toBeNull();
    expect(state.appointments).toEqual([]);
    expect(state.appointmentCancelTokens).toEqual({});
    expect(state.lastAvailabilityRouting).toBeNull();
    expect(state.lastAvailabilitySlots).toEqual([]);
    expect(state.flow.availabilitySearches[0]).toMatchObject({
      status: "invalidated",
      lastInvalidationReason: "patient_changed",
    });
    expect(state.flow.pendingActions[0]).toMatchObject({
      invalidated: true,
      invalidationReason: "patient_changed",
    });
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
  dynamicToolsEnabled = false,
}: {
  llmModel: llm.LLM;
  dynamicToolsEnabled?: boolean;
}) {
  const state = createCallState({ dynamicToolsEnabled });
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
