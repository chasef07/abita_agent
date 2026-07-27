import {
  AgentSession,
  type ChatContext,
  initializeLogger,
  voice,
} from "@livekit/agents";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createVoiceAgent } from "../agent.js";
import { SPRING_HILL_OFFICE_PHONE } from "../customers/abita/profile.js";
import { createTestCallState } from "./support/call-state.js";

const ACTIVE_KNOWLEDGE_MARKER = "ACTIVE OFFICE KNOWLEDGE CONTEXT";

class CapturingFakeLLM extends voice.testing.FakeLLM {
  readonly requests: ChatContext[] = [];

  override chat(options: Parameters<voice.testing.FakeLLM["chat"]>[0]) {
    this.requests.push(options.chatCtx.copy());
    const fakeContext = options.chatCtx.copy();
    const lastItem = fakeContext.items.at(-1);
    const lastUserMessage = [...fakeContext.items]
      .reverse()
      .find((item) => item.type === "message" && item.role === "user");
    if (
      lastItem?.type === "message" &&
      lastItem.role !== "user" &&
      lastUserMessage?.type === "message"
    ) {
      fakeContext.addMessage({
        role: "user",
        content: lastUserMessage.textContent ?? "",
      });
    }
    return super.chat({ ...options, chatCtx: fakeContext });
  }
}

function activeKnowledgeMessages(chatCtx: ChatContext): string[] {
  return chatCtx.items.flatMap((item) =>
    item.type === "message" &&
    item.role === "system" &&
    item.textContent?.includes(ACTIVE_KNOWLEDGE_MARKER)
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

describe("Office Knowledge model context", () => {
  beforeAll(() => {
    initializeLogger({ pretty: false, level: "silent" });
  });

  const sessions: AgentSession[] = [];

  afterEach(async () => {
    await Promise.all(sessions.splice(0).map((session) => session.close()));
  });

  it("grounds every completed caller turn with the full active-office document", async () => {
    const llm = new CapturingFakeLLM([
      { input: "How are you?", content: "I am ready to help." },
    ]);
    const session = new AgentSession({ llm });
    sessions.push(session);
    session.userData = createTestCallState({
      officeKey: "spring-hill",
      trunkPhone: SPRING_HILL_OFFICE_PHONE,
    });
    const { agent } = createVoiceAgent("no_match", SPRING_HILL_OFFICE_PHONE, {
      suppressGreeting: true,
    });

    await session.start({ agent });
    await completeUserTurn(session, "How are you?");
    await vi.waitFor(() => expect(llm.requests).toHaveLength(1));

    const contexts = activeKnowledgeMessages(llm.requests[0]!);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toContain("Schema: abita-office-knowledge/v1");
    expect(contexts[0]).toContain("## Payments");
    expect(contexts[0]).toContain("## Billing");
    expect(session.userData.runtime.knowledgeContexts).toHaveLength(1);
    expect(session.userData.runtime.knowledgeContexts[0]).toMatchObject({
      officeKey: "spring-hill",
      schemaVersion: "abita-office-knowledge/v1",
    });
    expect(session.userData.runtime.knowledgeContexts[0]?.documentHash).toMatch(
      /^[a-f0-9]{64}$/,
    );
  });

  it("replaces the document when Call State changes the active office", async () => {
    const llm = new CapturingFakeLLM([
      { input: "How are you?", content: "I am ready to help." },
    ]);
    const session = new AgentSession({ llm });
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
    await completeUserTurn(session, "How are you?");
    await vi.waitFor(() => expect(llm.requests).toHaveLength(1));

    const contexts = activeKnowledgeMessages(llm.requests[0]!);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toContain(
      "# Office Knowledge: Eye Radiance powered by Abeeta Eye Group",
    );
    expect(contexts[0]).not.toContain(
      "# Office Knowledge: Abita Eye Group, Spring Hill",
    );
  });

  it("grounds preemptive generation without waiting for topic detection", async () => {
    const llm = new CapturingFakeLLM([
      {
        input: "Do you take payment plans?",
        content: "I can explain the office policy.",
      },
    ]);
    const session = new AgentSession({ llm });
    sessions.push(session);
    session.userData = createTestCallState({
      officeKey: "spring-hill",
      trunkPhone: SPRING_HILL_OFFICE_PHONE,
    });
    const { agent } = createVoiceAgent("no_match", SPRING_HILL_OFFICE_PHONE, {
      suppressGreeting: true,
    });

    await session.start({ agent });
    await completeUserTurn(session, "Do you take payment plans?", true);
    await vi.waitFor(() => expect(llm.requests).toHaveLength(1));

    const contexts = activeKnowledgeMessages(llm.requests[0]!);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toContain("## Payments");
  });

  it("observes the document supplied after a tool changes the active office", async () => {
    const toolReply =
      "No matching patient was found. Confirm the spelling and date of birth, or ask whether the patient is already registered with us.";
    const llm = new CapturingFakeLLM([
      {
        input: "This is Jane Doe, January 2, 1980.",
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
        input: JSON.stringify(toolReply),
        content: "I could not find that patient.",
      },
    ]);
    const session = new AgentSession({ llm });
    sessions.push(session);
    const state = createTestCallState({
      officeKey: "spring-hill",
      trunkPhone: SPRING_HILL_OFFICE_PHONE,
    });
    session.userData = state;
    const { agent } = createVoiceAgent("no_match", SPRING_HILL_OFFICE_PHONE, {
      identityLookup: async () => {
        state.office.activeKey = "crystal-river";
        return { status: "not_found" };
      },
      suppressGreeting: true,
    });

    await session.start({ agent });
    await completeUserTurn(session, "This is Jane Doe, January 2, 1980.");
    await vi.waitFor(() => expect(llm.requests).toHaveLength(2));
    await session.waitForIdle();

    expect(activeKnowledgeMessages(llm.requests[0]!)[0]).toContain(
      "# Office Knowledge: Abita Eye Group, Spring Hill",
    );
    expect(activeKnowledgeMessages(llm.requests[1]!)[0]).toContain(
      "# Office Knowledge: Eye Radiance powered by Abeeta Eye Group",
    );
    expect(
      state.runtime.knowledgeContexts.map(({ officeKey }) => officeKey),
    ).toEqual(["spring-hill", "crystal-river"]);
  });
});
