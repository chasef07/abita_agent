import {
  AgentSession,
  type AgentSessionOptions,
  type ChatContext,
  initializeLogger,
  tool,
  voice,
} from "@livekit/agents";
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVoiceAgent } from "../agent.js";
import { SPRING_HILL_OFFICE_PHONE } from "../customers/abita/profile.js";
import { CALLER_CANDIDATE_REF, type CallState } from "../state/call-state.js";
import { voiceTurnHandlingOptions } from "../session-options.js";
import { createTestCallState } from "./support/call-state.js";
import { InMemoryOwnedMiddleware } from "./support/owned-middleware.js";

class CapturingLLM extends voice.testing.FakeLLM {
  readonly requests: ChatContext[] = [];

  override chat(options: Parameters<voice.testing.FakeLLM["chat"]>[0]) {
    this.requests.push(options.chatCtx.copy());
    const fakeContext = options.chatCtx.copy();
    const user = [...fakeContext.items]
      .reverse()
      .find((item) => item.type === "message" && item.role === "user");
    if (
      user?.type === "message" &&
      !fakeContext.items.some((item) => item.type === "function_call_output")
    ) {
      fakeContext.addMessage({ role: "user", content: user.textContent ?? "" });
    }
    return super.chat({ ...options, chatCtx: fakeContext });
  }
}

function turn(transcript: string) {
  return {
    endOfUtteranceDelay: 0,
    newTranscript: transcript,
    startedSpeakingAt: undefined,
    stoppedSpeakingAt: undefined,
    transcriptionDelay: 0,
    transcriptConfidence: 0.99,
  };
}

function requestText(context: ChatContext) {
  return context.items
    .flatMap((item) =>
      item.type === "message" ? [item.textContent ?? ""] : [],
    )
    .join(" ");
}

describe("preemptive generation through the LiveKit turn pipeline", () => {
  initializeLogger({ pretty: false, level: "silent" });
  const sessions: AgentSession[] = [];

  afterEach(async () => {
    await Promise.all(sessions.splice(0).map((session) => session.close()));
  });

  async function start(
    options: {
      state?: CallState;
      now?: () => Date;
      responses?: ConstructorParameters<typeof CapturingLLM>[0];
      turnHandling?: AgentSessionOptions<CallState>["turnHandling"];
    } = {},
  ) {
    const llm = new CapturingLLM(
      options.responses ?? [{ input: "Hello", content: "How can I help?" }],
    );
    const middleware = new InMemoryOwnedMiddleware();
    const session = new AgentSession<CallState>({
      llm,
      turnHandling: options.turnHandling ?? {
        ...voiceTurnHandlingOptions,
        preemptiveGeneration: { enabled: true, preemptiveTts: false },
      },
    });
    sessions.push(session);
    const state =
      options.state ??
      createTestCallState({
        officeKey: "spring-hill",
        trunkPhone: SPRING_HILL_OFFICE_PHONE,
      });
    session.userData = state;
    await session.start({
      agent: createVoiceAgent(SPRING_HILL_OFFICE_PHONE, {
        ownedMiddleware: middleware,
        suppressGreeting: true,
        turnClock: {
          now: options.now ?? (() => new Date("2026-07-25T03:58:00.000Z")),
        },
      }).agent,
    });
    const activity = await session.waitForIdle();
    return { llm, middleware, session, state, activity };
  }

  it("waits for end of turn before generating with production options", async () => {
    const { activity, llm, session, middleware } = await start({
      turnHandling: voiceTurnHandlingOptions,
    });
    activity.onPreemptiveGeneration(turn("Hello"));
    await new Promise((resolve) => setImmediate(resolve));
    expect(llm.requests).toHaveLength(0);
    expect(middleware.operations).toEqual([]);

    await activity.onEndOfTurn(turn("Hello"));
    await session.waitForIdle();
    expect(llm.requests).toHaveLength(1);
    expect(requestText(session.currentAgent.chatCtx.copy())).toContain(
      "How can I help?",
    );
  });

  it("starts the model before end of turn and reuses its request for a stable turn", async () => {
    const { activity, llm, session, middleware, state } = await start();
    const before = JSON.stringify(state);
    activity.onPreemptiveGeneration(turn("Hello"));
    await vi.waitFor(() => expect(llm.requests).toHaveLength(1));
    expect(JSON.stringify(state)).toBe(before);
    expect(middleware.operations).toEqual([]);
    expect(requestText(session.currentAgent.chatCtx.copy())).not.toContain(
      "How can I help?",
    );
    await activity.onEndOfTurn(turn("Hello"));
    await session.waitForIdle();
    expect(llm.requests).toHaveLength(1);
    expect(requestText(session.currentAgent.chatCtx.copy())).toContain(
      "How can I help?",
    );
    expect(requestText(session.currentAgent.chatCtx.copy())).not.toContain(
      "Current clinic-local date",
    );
  });

  it("reuses a fresh speculative request after the previous turn's clock changes", async () => {
    let now = new Date("2026-07-25T03:58:00.000Z");
    const { activity, llm, session } = await start({ now: () => now });
    await activity.onEndOfTurn(turn("Hello"));
    await session.waitForIdle();
    expect(llm.requests).toHaveLength(1);
    now = new Date("2026-07-25T03:59:00.000Z");
    activity.onPreemptiveGeneration(turn("Hello"));
    await vi.waitFor(() => expect(llm.requests).toHaveLength(2));
    await activity.onEndOfTurn(turn("Hello"));
    await session.waitForIdle();
    expect(llm.requests).toHaveLength(2);
  });

  it("keeps a name mention unresolved through speculative and committed turns", async () => {
    const state = createTestCallState({
      officeKey: "spring-hill",
      trunkPhone: SPRING_HILL_OFFICE_PHONE,
      preCallCandidates: [
        {
          status: "verified",
          ref: CALLER_CANDIDATE_REF,
          firstName: "LARRY",
          lastName: "TEST",
          dob: "08/18/2020",
          patientId: "patient-larry",
          appointments: [],
          appointmentsStatus: "none",
        },
      ],
    });
    const { activity, llm, session } = await start({ state });
    activity.onPreemptiveGeneration(turn("L-A-R-R-Y"));
    await vi.waitFor(() => expect(llm.requests).toHaveLength(1));
    expect(state.identity.activePatient).toBeNull();
    await activity.onEndOfTurn(turn("L-A-R-R-Y"));
    await session.waitForIdle();
    expect(llm.requests).toHaveLength(1);
    expect(requestText(llm.requests[0]!)).toContain("no patient is active");
    expect(requestText(llm.requests[0]!)).toContain("1 possible patient");
    expect(state.identity.activePatient).toBeNull();
  });

  it("discards speculation when availability changes before the turn hook", async () => {
    const { activity, llm, session, state } = await start();
    activity.onPreemptiveGeneration(turn("Hello"));
    await vi.waitFor(() => expect(llm.requests).toHaveLength(1));
    state.availability.slots = [
      {
        slotId: "slot-1",
        provider: "Test Doctor",
        date: "07/28/2026",
        time: "10:00 AM",
        datetime: "2026-07-28T10:00:00",
        routing: null,
      },
    ];
    await activity.onEndOfTurn(turn("Hello"));
    await session.waitForIdle();
    expect(llm.requests).toHaveLength(2);
    expect(requestText(llm.requests[0]!)).not.toContain("slot-1");
    expect(requestText(llm.requests[1]!)).toContain("slot-1");
  });

  it("discards speculation across a clinic date change", async () => {
    let now = new Date("2026-07-25T03:59:59.000Z");
    const { activity, llm, session } = await start({ now: () => now });
    activity.onPreemptiveGeneration(turn("Hello"));
    await vi.waitFor(() => expect(llm.requests).toHaveLength(1));
    now = new Date("2026-07-25T04:00:00.000Z");
    await activity.onEndOfTurn(turn("Hello"));
    await session.waitForIdle();
    expect(llm.requests).toHaveLength(2);
    expect(requestText(llm.requests[0]!)).toContain("Friday, July 24th");
    expect(requestText(llm.requests[1]!)).toContain("Saturday, July 25th");
  });

  it("does not let an overlapping recovery request mask stale speculation", async () => {
    const { activity, llm, session, state } = await start();
    activity.onPreemptiveGeneration(turn("Hello"));
    await vi.waitFor(() => expect(llm.requests).toHaveLength(1));
    state.office.activeKey = "crystal-river";
    const beforeRecovery = session.currentAgent.chatCtx.copy();
    const recovery = session.generateReply({
      instructions: "Ask the caller to repeat.",
    });
    await vi.waitFor(() => expect(llm.requests).toHaveLength(2));
    await recovery.waitForPlayout();
    // The empty fake recovery leaves history unchanged, so the SDK's ordinary
    // history comparison alone cannot detect the stale speculative request.
    expect(
      session.currentAgent.chatCtx.copy().isEquivalent(beforeRecovery),
    ).toBe(true);
    await activity.onEndOfTurn(turn("Hello"));
    await session.waitForIdle();
    expect(llm.requests).toHaveLength(3);
  });

  it("does not execute a speculative tool until the user turn commits", async () => {
    const execute = vi.fn(async () => "Recorded");
    const { activity, llm, session } = await start({
      responses: [
        { input: "Hello", toolCalls: [{ name: "record_action", args: {} }] },
      ],
    });
    await session.currentAgent.updateTools([
      tool({
        name: "record_action",
        description: "Record the confirmed action",
        parameters: z.object({}),
        execute,
      }),
    ]);
    activity.onPreemptiveGeneration(turn("Hello"));
    await vi.waitFor(() => expect(llm.requests).toHaveLength(1));
    // Let the fake LLM produce its tool call while speech remains unscheduled.
    await new Promise((resolve) => setImmediate(resolve));
    expect(execute).not.toHaveBeenCalled();
    await activity.onEndOfTurn(turn("Hello"));
    await session.waitForIdle();
    expect(execute).toHaveBeenCalledOnce();
  });

  it("defers resolver promotion until commitment and refreshes the next model input", async () => {
    const state = createTestCallState({
      preCallCandidates: [
        {
          status: "verified",
          ref: CALLER_CANDIDATE_REF,
          firstName: "Larry",
          lastName: "Test",
          dob: "01/01/1980",
          patientId: "patient-larry",
          appointments: [],
          appointmentsStatus: "none",
        },
      ],
    });
    const { activity, llm, session, middleware } = await start({
      state,
      responses: [
        {
          input: "This is Larry.",
          toolCalls: [
            {
              name: "resolve_patient",
              args: {
                patientContext: null,
                firstName: "Larry",
                lastName: null,
                dob: null,
              },
            },
          ],
        },
      ],
    });
    activity.onPreemptiveGeneration(turn("This is Larry."));
    await vi.waitFor(() => expect(llm.requests).toHaveLength(1));
    await new Promise((resolve) => setImmediate(resolve));
    expect(state.identity.activePatient).toBeNull();
    await activity.onEndOfTurn(turn("This is Larry."));
    await session.waitForIdle();
    expect(state.identity.activePatient?.patientId).toBe("patient-larry");
    expect(requestText(llm.requests[0]!)).toContain("no patient is active");
    expect(requestText(llm.requests.at(-1)!)).toContain(
      "Larry Test is the active",
    );
    expect(middleware.operations).toEqual([]);
  });

  it("never executes a discarded speculative tool call", async () => {
    const execute = vi.fn(async () => "Recorded");
    const { activity, llm, session } = await start({
      responses: [
        { input: "Hello", toolCalls: [{ name: "record_action", args: {} }] },
      ],
    });
    await session.currentAgent.updateTools([
      tool({
        name: "record_action",
        description: "Record the confirmed action",
        parameters: z.object({}),
        execute,
      }),
    ]);
    activity.onPreemptiveGeneration(turn("Hello"));
    await vi.waitFor(() => expect(llm.requests).toHaveLength(1));
    await new Promise((resolve) => setImmediate(resolve));
    await activity.onEndOfTurn(turn("Actually, never mind"));
    await session.waitForIdle();
    expect(llm.requests).toHaveLength(2);
    expect(execute).not.toHaveBeenCalled();
  });
});
