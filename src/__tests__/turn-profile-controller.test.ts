import {
  AgentSessionEventTypes,
  ChatMessage,
  type AgentSession,
} from "@livekit/agents";
import { describe, expect, it, vi } from "vitest";
import { observeAssistantText } from "../agent.js";
import {
  attachTurnProfileLifecycle,
  createTurnProfileController,
} from "../runtime/turn-profile-controller.js";
import { getAssemblyAISttProfileOptions } from "../stt-config.js";
import type { CallState } from "../state/call-state.js";

class TestSession {
  readonly listeners = new Map<string, (event: never) => void>();
  on(event: string, listener: (event: never) => void) {
    this.listeners.set(event, listener);
  }
  emit(event: string, payload: unknown) {
    this.listeners.get(event)?.(payload as never);
  }
}

function setup() {
  const updateOptions = vi.fn();
  const controller = createTurnProfileController(
    { updateOptions },
    { startedAt: new Date("2026-07-23T10:00:00.000Z") },
  );
  const session = new TestSession();
  attachTurnProfileLifecycle(
    session as unknown as AgentSession<CallState>,
    controller,
  );
  return { controller, updateOptions, session };
}

describe("turn profile controller", () => {
  it("does not send generated but unspoken questions as agent context", () => {
    const { controller, session, updateOptions } = setup();
    controller.observeAssistantText("Okay. What is your member ID?", true);
    expect(controller.activeSttProfile).toBe("memberId");
    for (const [options] of updateOptions.mock.calls) {
      expect(options).not.toHaveProperty("agentContext");
    }
    session.emit(AgentSessionEventTypes.ConversationItemAdded, {
      item: ChatMessage.create({
        role: "assistant",
        content: "Okay.",
        interrupted: true,
      }),
    });
    expect(updateOptions).toHaveBeenLastCalledWith({
      ...getAssemblyAISttProfileOptions("default"),
      agentContext: "Okay.",
    });
    expect(controller.activeSttProfile).toBe("default");
  });

  it("inherits interrupted follow-ups from the last committed question", () => {
    const { controller, updateOptions } = setup();
    controller.commitAssistantTurn("What is your email address?");
    controller.commitUserTurn();
    controller.observeAssistantText(
      "Can you spell that? What is your member ID?",
      true,
    );
    expect(controller.activeSttProfile).toBe("memberId");
    controller.commitAssistantTurn("Can you spell that?");
    expect(controller.activeSttProfile).toBe("email");
    expect(updateOptions).toHaveBeenLastCalledWith({
      ...getAssemblyAISttProfileOptions("email"),
      agentContext: "Can you spell that?",
    });
  });

  it("sends plugin options and context directly, including inherited dictation prompts", () => {
    const { controller, updateOptions } = setup();
    const prompt = "Can I get the member ID from your insurance card?";
    controller.observeAssistantText(prompt, true);
    controller.commitAssistantTurn(prompt);
    expect(updateOptions).toHaveBeenLastCalledWith({
      ...getAssemblyAISttProfileOptions("memberId"),
      agentContext: prompt,
    });
    controller.commitUserTurn();
    controller.commitAssistantTurn("Go ahead, spell that.");
    expect(controller.activeSttProfile).toBe("memberId");
    expect(updateOptions).toHaveBeenLastCalledWith({
      ...getAssemblyAISttProfileOptions("memberId"),
      agentContext: "Go ahead, spell that.",
    });
  });

  it("preserves the entity profile across multiple finalized transcript chunks", () => {
    const { controller, updateOptions, session } = setup();
    controller.observeAssistantText("Can I get the member ID?", true);
    updateOptions.mockClear();
    for (const transcript of ["A B", "one two", "three four"]) {
      session.emit(AgentSessionEventTypes.UserInputTranscribed, {
        isFinal: true,
        transcript,
      });
      expect(controller.activeSttProfile).toBe("memberId");
      expect(updateOptions).not.toHaveBeenCalled();
    }
    session.emit(AgentSessionEventTypes.ConversationItemAdded, {
      item: { type: "message", role: "user" },
    });
    expect(controller.activeSttProfile).toBe("default");
    expect(updateOptions).toHaveBeenCalledExactlyOnceWith(
      getAssemblyAISttProfileOptions("default"),
    );
    expect(controller.sttProfiles.at(-1)?.reason).toBe("user_turn_committed");
  });

  it("uses the committed spoken question without resetting its recognition profile", () => {
    const { controller, session, updateOptions } = setup();
    controller.observeAssistantText("What is your email?", true);
    updateOptions.mockClear();
    session.emit(AgentSessionEventTypes.ConversationItemAdded, {
      item: ChatMessage.create({
        role: "assistant",
        content: "What is your email?",
      }),
    });
    expect(controller.activeSttProfile).toBe("email");
    expect(updateOptions).toHaveBeenCalledExactlyOnceWith({
      ...getAssemblyAISttProfileOptions("email"),
      agentContext: "What is your email?",
    });
  });

  it("publishes the committed greeting and ignores empty assistant messages", () => {
    const { controller, session, updateOptions } = setup();
    session.emit(AgentSessionEventTypes.ConversationItemAdded, {
      item: ChatMessage.create({
        role: "assistant",
        content: "Welcome. How can I help?",
      }),
    });
    expect(updateOptions.mock.lastCall?.[0].agentContext).toBe(
      "Welcome. How can I help?",
    );
    updateOptions.mockClear();
    controller.commitAssistantTurn("   ");
    expect(updateOptions).not.toHaveBeenCalled();
  });

  it("caps completed assistant context at the latest 1,500 characters", () => {
    const { controller, updateOptions } = setup();
    controller.commitAssistantTurn(`start-${"x".repeat(1_500)}-end`);
    const context = updateOptions.mock.lastCall?.[0].agentContext as string;
    expect(context).toHaveLength(1_500);
    expect(context).not.toContain("start-");
    expect(context).toContain("-end");
  });

  it("arms dictation recognition as the prompt enters TTS without changing endpointing", async () => {
    const { controller, updateOptions } = setup();
    async function* chunks() {
      yield "Can I get the ";
      yield "member ID from your insurance card?";
    }
    let text = "";
    for await (const chunk of observeAssistantText(
      chunks(),
      controller.observeAssistantText,
    )) {
      text += chunk;
    }
    expect(text).toBe("Can I get the member ID from your insurance card?");
    expect(controller.activeSttProfile).toBe("memberId");
    expect(updateOptions.mock.lastCall?.[0]).toEqual({
      ...getAssemblyAISttProfileOptions("memberId"),
    });
  });
});
