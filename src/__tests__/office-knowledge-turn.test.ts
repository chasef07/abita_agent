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
import { InMemoryOwnedMiddleware } from "./support/owned-middleware.js";
import {
  RHEUMATOLOGY_DEMO_TRUNK_PHONE,
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
  await activity.onEndOfTurn(turn);
}

const ownedMiddleware = new InMemoryOwnedMiddleware();

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
    const { agent } = createVoiceAgent(SPRING_HILL_OFFICE_PHONE, {
      ownedMiddleware,
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
    expect(requestKnowledge[0]).toContain("## Hours");
    expect(knowledgeMessages(session.currentAgent.chatCtx)).toEqual([]);
    expect(toolNames(session.currentAgent.toolCtx.tools).sort()).toEqual(
      [
        "add_patient",
        "book_appointment",
        "cancel_appointment",
        "check_insurance",
        "create_staff_task",
        "end_call",
        "list_available_appointments",
        "reschedule_appointment",
        "resolve_patient",
        "transfer_call",
        "update_insurance",
      ].sort(),
    );
  });

  it.each([
    ["How much is the visit without insurance?", "## Self-Pay Pricing", "$250"],
    ["What do you charge for cash?", "## Self-Pay Pricing", "$250"],
    [
      "¿Cuánto sería el monto a pagar? La consulta.",
      "## Self-Pay Pricing",
      "$250",
    ],
    ["Optical billing.", "## Billing", "(786) 446-8333"],
    ["Can you text me the address?", "## Location and Contact", "write down"],
    [
      "Can you email my confirmation?",
      "## Appointment Expectations",
      "typically sends an email confirmation",
    ],
  ])(
    "grounds the actual answering turn for %s",
    async (input, heading, fact) => {
      const llm = new CapturingFakeLLM([
        { input, content: "I can explain the supplied office information." },
      ]);
      const session = new AgentSession({ llm });
      sessions.push(session);
      session.userData = createTestCallState({
        officeKey: "spring-hill",
        trunkPhone: SPRING_HILL_OFFICE_PHONE,
      });
      await session.start({
        agent: createVoiceAgent(SPRING_HILL_OFFICE_PHONE, {
          ownedMiddleware,
          suppressGreeting: true,
        }).agent,
      });
      await completeUserTurn(session, input);
      await vi.waitFor(() => expect(llm.requests).toHaveLength(1));
      await session.waitForIdle();
      const references = knowledgeMessages(llm.requests[0]!);
      expect(references).toHaveLength(1);
      expect(references[0]).toContain(heading);
      expect(references[0]).toContain(fact);
      expect(knowledgeMessages(session.currentAgent.chatCtx)).toEqual([]);
    },
  );

  it("uses the active Call State office and the immediately preceding exchange", async () => {
    const session = new AgentSession();
    sessions.push(session);
    session.userData = createTestCallState({
      officeKey: "spring-hill",
      trunkPhone: SPRING_HILL_OFFICE_PHONE,
    });
    const { agent } = createVoiceAgent(SPRING_HILL_OFFICE_PHONE, {
      ownedMiddleware,
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
  });

  it("skips unrelated turns and injects unavailable facts", async () => {
    const unrelatedSession = new AgentSession();
    sessions.push(unrelatedSession);
    unrelatedSession.userData = createTestCallState({
      officeKey: "spring-hill",
      trunkPhone: SPRING_HILL_OFFICE_PHONE,
    });
    await unrelatedSession.start({
      agent: createVoiceAgent(SPRING_HILL_OFFICE_PHONE, {
        ownedMiddleware,
        suppressGreeting: true,
      }).agent,
    });
    const unrelatedContext = unrelatedSession.currentAgent.chatCtx.copy();
    unrelatedContext.addMessage({
      role: "system",
      content: "Internal state mentions office hours.",
    });
    await unrelatedSession.currentAgent.onUserTurnCompleted(
      unrelatedContext,
      ChatMessage.create({ role: "user", content: "What about that?" }),
    );

    expect(knowledgeMessages(unrelatedContext)).toEqual([]);

    const unavailableSession = new AgentSession();
    sessions.push(unavailableSession);
    unavailableSession.userData = createTestCallState({
      officeKey: "rheumatology-demo",
      trunkPhone: RHEUMATOLOGY_DEMO_TRUNK_PHONE,
    });
    await unavailableSession.start({
      agent: createVoiceAgent(RHEUMATOLOGY_DEMO_TRUNK_PHONE, {
        ownedMiddleware,
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
  });

  it("logs a sanitized failure and lets the reply path continue", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const session = new AgentSession();
    sessions.push(session);
    session.userData = createTestCallState({
      officeKey: "spring-hill",
      trunkPhone: SPRING_HILL_OFFICE_PHONE,
    });
    await session.start({
      agent: createVoiceAgent(SPRING_HILL_OFFICE_PHONE, {
        ownedMiddleware,
        officeKnowledgeResolver: () => {
          throw new Error("raw caller content and office document");
        },
        suppressGreeting: true,
      }).agent,
    });
    const turnContext = session.currentAgent.chatCtx.copy();

    await expect(
      session.currentAgent.onUserTurnCompleted(
        turnContext,
        ChatMessage.create({
          role: "user",
          content: "What are your hours?",
        }),
      ),
    ).resolves.toBeUndefined();

    expect(knowledgeMessages(turnContext)).toEqual([]);
    expect(warning).toHaveBeenCalledExactlyOnceWith(
      "[office_knowledge] retrieval failed office=spring-hill",
    );
    warning.mockRestore();
  });
});
