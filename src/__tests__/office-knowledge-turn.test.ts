import {
  AgentSession,
  type ChatContext,
  ChatMessage,
  initializeLogger,
  isToolset,
  type ToolContextEntry,
  voice,
} from "@livekit/agents";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createVoiceAgent } from "../agent.js";
import {
  DEV_OFFICE_PHONE,
  SPRING_HILL_OFFICE_PHONE,
} from "../customers/abita/profile.js";
import { createTestCallState } from "./support/call-state.js";

const KNOWLEDGE_REFERENCE_MARKER = "OFFICE KNOWLEDGE FOR THIS REPLY";

class CapturingFakeLLM extends voice.testing.FakeLLM {
  readonly requests: ChatContext[] = [];

  override chat(options: Parameters<voice.testing.FakeLLM["chat"]>[0]) {
    this.requests.push(options.chatCtx.copy());
    const fakeContext = options.chatCtx.copy();
    const lastUserMessage = [...fakeContext.items]
      .reverse()
      .find((item) => item.type === "message" && item.role === "user");
    if (lastUserMessage?.type === "message") {
      fakeContext.addMessage({
        role: "user",
        content: lastUserMessage.textContent ?? "",
      });
    }
    return super.chat({ ...options, chatCtx: fakeContext });
  }
}

function toolNames(entries: readonly ToolContextEntry[]): string[] {
  return entries.flatMap((entry) =>
    isToolset(entry) ? toolNames(entry.tools) : [entry.id],
  );
}

function knowledgeMessages(chatCtx: ChatContext): string[] {
  return chatCtx.items.flatMap((item) =>
    item.type === "message" &&
    item.role === "assistant" &&
    item.textContent?.includes(KNOWLEDGE_REFERENCE_MARKER)
      ? [item.textContent]
      : [],
  );
}

async function completeUserTurn(
  session: AgentSession,
  transcript: string,
  preemptive = false,
): Promise<void> {
  const activity = await session.waitForIdle();
  const turn = {
    endOfUtteranceDelay: 0,
    newTranscript: transcript,
    startedSpeakingAt: undefined,
    stoppedSpeakingAt: undefined,
    transcriptionDelay: 0,
    transcriptConfidence: 0.99,
  };
  if (preemptive) activity.onPreemptiveGeneration(turn);
  await activity.onEndOfTurn(turn);
}

describe("Office Knowledge turn enrichment", () => {
  beforeAll(() => {
    initializeLogger({ pretty: false, level: "silent" });
  });

  const sessions: AgentSession[] = [];

  afterEach(async () => {
    await Promise.all(sessions.splice(0).map((session) => session.close()));
  });

  it("grounds the next model request without persisting knowledge or exposing a tool", async () => {
    const llm = new CapturingFakeLLM([
      {
        input: "¿Cuál es su horario?",
        content: "Our office hours are in the supplied reference.",
      },
    ]);
    const session = new AgentSession({ llm });
    sessions.push(session);
    session.userData = createTestCallState({
      officeKey: "spring-hill",
      amdOfficePhone: SPRING_HILL_OFFICE_PHONE,
      trunkPhone: SPRING_HILL_OFFICE_PHONE,
    });
    const { agent } = createVoiceAgent("no_match", SPRING_HILL_OFFICE_PHONE, {
      suppressGreeting: true,
    });

    await session.start({ agent });
    await completeUserTurn(session, "¿Cuál es su horario?");
    await vi.waitFor(() => expect(llm.requests).toHaveLength(1));
    await session.waitForIdle();

    expect(llm.requests).toHaveLength(1);
    const requestKnowledge = knowledgeMessages(llm.requests[0]!);
    expect(requestKnowledge).toHaveLength(1);
    expect(requestKnowledge[0]).toContain("active office: Abita Eye Group");
    expect(requestKnowledge[0]).toContain("## Location + Contact");
    expect(knowledgeMessages(session.currentAgent.chatCtx)).toEqual([]);
    expect(toolNames(session.currentAgent.toolCtx.tools).sort()).toEqual(
      [
        "add_patient",
        "book_appointment",
        "cancel_appointment",
        "check_insurance",
        "create_staff_task",
        "end_call",
        "get_availability",
        "get_current_datetime",
        "reschedule_appointment",
        "resolve_patient",
        "transfer_call",
        "update_insurance",
      ].sort(),
    );
  });

  it("reuses an equivalent preemptive reply and invalidates one that needs grounding", async () => {
    const unrelatedLlm = new CapturingFakeLLM([
      { input: "How are you?", content: "I am ready to help." },
    ]);
    const unrelatedSession = new AgentSession({ llm: unrelatedLlm });
    sessions.push(unrelatedSession);
    unrelatedSession.userData = createTestCallState({
      officeKey: "spring-hill",
      trunkPhone: SPRING_HILL_OFFICE_PHONE,
    });
    await unrelatedSession.start({
      agent: createVoiceAgent("no_match", SPRING_HILL_OFFICE_PHONE, {
        suppressGreeting: true,
      }).agent,
    });

    await completeUserTurn(unrelatedSession, "How are you?", true);
    await vi.waitFor(() => expect(unrelatedLlm.requests).toHaveLength(1));
    await unrelatedSession.waitForIdle();
    expect(knowledgeMessages(unrelatedLlm.requests[0]!)).toEqual([]);

    const groundedLlm = new CapturingFakeLLM([
      {
        input: "What are your office hours?",
        content: "The preemptive answer is not grounded.",
      },
      {
        input: "What are your office hours?",
        content: "The supplied hours are available.",
      },
    ]);
    const groundedSession = new AgentSession({ llm: groundedLlm });
    sessions.push(groundedSession);
    groundedSession.userData = createTestCallState({
      officeKey: "spring-hill",
      trunkPhone: SPRING_HILL_OFFICE_PHONE,
    });
    await groundedSession.start({
      agent: createVoiceAgent("no_match", SPRING_HILL_OFFICE_PHONE, {
        suppressGreeting: true,
      }).agent,
    });

    await completeUserTurn(
      groundedSession,
      "What are your office hours?",
      true,
    );
    await vi.waitFor(() => expect(groundedLlm.requests).toHaveLength(2));
    await groundedSession.waitForIdle();
    expect(knowledgeMessages(groundedLlm.requests[0]!)).toEqual([]);
    expect(knowledgeMessages(groundedLlm.requests[1]!)).toHaveLength(1);
  });

  it("uses the active Call State office and the immediately preceding exchange", async () => {
    const session = new AgentSession();
    sessions.push(session);
    session.userData = createTestCallState({
      officeKey: "spring-hill",
      trunkPhone: SPRING_HILL_OFFICE_PHONE,
    });
    const { agent } = createVoiceAgent("no_match", SPRING_HILL_OFFICE_PHONE, {
      suppressGreeting: true,
    });
    await session.start({ agent });
    session.userData.office.activeKey = "crystal-river";
    const turnContext = session.currentAgent.chatCtx.copy();
    turnContext.addMessage({
      role: "user",
      content: "Where are you located?",
    });
    turnContext.addMessage({
      role: "assistant",
      content: "I can help with the office location.",
    });

    await session.currentAgent.onUserTurnCompleted(
      turnContext,
      ChatMessage.create({ role: "user", content: "What about that?" }),
    );

    const messages = knowledgeMessages(turnContext);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("active office: Eye Radiance");
    expect(messages[0]).toContain("1100 N Lyle Avenue");
    expect(session.userData.runtime).toMatchObject({
      knowledgeRetrievals: [
        {
          language: "en",
          officeKey: "crystal-river",
          outcome: "matched",
          sectionCount: 1,
          topic: "location_contact",
        },
      ],
    });
  });

  it("preserves context equivalence for unrelated turns and injects unavailable facts", async () => {
    const unrelatedSession = new AgentSession();
    sessions.push(unrelatedSession);
    unrelatedSession.userData = createTestCallState({
      officeKey: "spring-hill",
      trunkPhone: SPRING_HILL_OFFICE_PHONE,
    });
    await unrelatedSession.start({
      agent: createVoiceAgent("no_match", SPRING_HILL_OFFICE_PHONE, {
        suppressGreeting: true,
      }).agent,
    });
    const unrelatedContext = unrelatedSession.currentAgent.chatCtx.copy();
    unrelatedContext.addMessage({
      role: "system",
      content: "Internal state mentions office hours.",
    });
    const before = unrelatedContext.copy();

    await unrelatedSession.currentAgent.onUserTurnCompleted(
      unrelatedContext,
      ChatMessage.create({ role: "user", content: "What about that?" }),
    );

    expect(unrelatedContext.isEquivalent(before)).toBe(true);
    expect(unrelatedSession.userData.runtime).toMatchObject({
      knowledgeRetrievals: [
        {
          outcome: "skipped",
          sectionCount: 0,
          topic: null,
        },
      ],
    });

    const unavailableSession = new AgentSession();
    sessions.push(unavailableSession);
    unavailableSession.userData = createTestCallState({
      officeKey: "dev",
      trunkPhone: DEV_OFFICE_PHONE,
    });
    await unavailableSession.start({
      agent: createVoiceAgent("no_match", DEV_OFFICE_PHONE, {
        suppressGreeting: true,
      }).agent,
    });
    const unavailableContext = unavailableSession.currentAgent.chatCtx.copy();

    await unavailableSession.currentAgent.onUserTurnCompleted(
      unavailableContext,
      ChatMessage.create({
        role: "user",
        content: "What is your Instagram?",
      }),
    );

    const unavailableMessages = knowledgeMessages(unavailableContext);
    expect(unavailableMessages).toHaveLength(1);
    expect(unavailableMessages[0]).toContain(
      "active office has no supplied information",
    );
    expect(unavailableSession.userData.runtime).toMatchObject({
      knowledgeRetrievals: [
        {
          officeKey: "dev",
          outcome: "unavailable",
          sectionCount: 0,
          topic: "social_follow_up",
        },
      ],
    });
  });

  it("records a sanitized failure and lets the reply path continue", async () => {
    const session = new AgentSession();
    sessions.push(session);
    session.userData = createTestCallState({
      officeKey: "spring-hill",
      trunkPhone: SPRING_HILL_OFFICE_PHONE,
    });
    await session.start({
      agent: createVoiceAgent("no_match", SPRING_HILL_OFFICE_PHONE, {
        officeKnowledgeResolver: () => {
          throw new Error("raw caller content and office document");
        },
        suppressGreeting: true,
      }).agent,
    });
    const turnContext = session.currentAgent.chatCtx.copy();
    const before = turnContext.copy();

    await expect(
      session.currentAgent.onUserTurnCompleted(
        turnContext,
        ChatMessage.create({
          role: "user",
          content: "What are your hours?",
        }),
      ),
    ).resolves.toBeUndefined();

    expect(turnContext.isEquivalent(before)).toBe(true);
    expect(session.userData.runtime.latestUserTranscript).toBe(
      "What are your hours?",
    );
    expect(session.userData.runtime).toMatchObject({
      knowledgeRetrievals: [
        {
          language: "unknown",
          officeKey: "spring-hill",
          outcome: "failure",
          sectionCount: 0,
          topic: null,
        },
      ],
    });
    expect(
      JSON.stringify(session.userData.runtime.knowledgeRetrievals),
    ).not.toContain("raw caller content");
  });
});
