import {
  AgentSession,
  type ChatContext,
  initializeLogger,
  voice,
} from "@livekit/agents";
import { afterEach, describe, expect, it } from "vitest";
import { createVoiceAgent } from "../agent.js";
import { SPRING_HILL_OFFICE_PHONE } from "../customers/abita/profile.js";
import { type CallState } from "../state/call-state.js";
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

describe("production LiveKit turn pipeline", () => {
  initializeLogger({ pretty: false, level: "silent" });
  const sessions: AgentSession<CallState>[] = [];

  afterEach(async () => {
    await Promise.all(sessions.splice(0).map((session) => session.close()));
  });

  async function start() {
    const llm = new CapturingLLM([
      { input: "Hello", content: "How can I help?" },
    ]);
    const middleware = new InMemoryOwnedMiddleware();
    const session = new AgentSession<CallState>({
      llm,
      turnHandling: voiceTurnHandlingOptions,
    });
    sessions.push(session);
    const state = createTestCallState({
      officeKey: "spring-hill",
      trunkPhone: SPRING_HILL_OFFICE_PHONE,
    });
    session.userData = state;
    await session.start({
      agent: createVoiceAgent(SPRING_HILL_OFFICE_PHONE, {
        ownedMiddleware: middleware,
        suppressGreeting: true,
        turnClock: {
          now: () => new Date("2026-07-25T03:58:00.000Z"),
        },
      }).agent,
    });
    const activity = await session.waitForIdle();
    return { llm, middleware, session, state, activity };
  }

  it("waits for end of turn before generating with production options", async () => {
    const { activity, llm, session, middleware } = await start();
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
});
