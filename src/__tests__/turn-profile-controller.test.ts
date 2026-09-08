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
import { getAssemblyAIInferenceSttProfileOptions } from "../stt-config.js";
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
  const updateEndpointing = vi.fn();
  const controller = createTurnProfileController(
    { updateOptions },
    { startedAt: new Date("2026-07-23T10:00:00.000Z"), updateEndpointing },
  );
  const session = new TestSession();
  attachTurnProfileLifecycle(
    session as unknown as AgentSession<CallState>,
    controller,
  );
  return { controller, updateOptions, updateEndpointing, session };
}

describe("turn profile controller", () => {
  it("does not send generated but unspoken questions as agent context", () => {
    const { controller, session, updateOptions } = setup();
    controller.observeAssistantText("Okay. What is your member ID?", true);
    expect(controller.activeSttProfile).toBe("memberId");
    for (const [options] of updateOptions.mock.calls) {
      expect(options.modelOptions).not.toHaveProperty("agent_context");
    }
    session.emit(AgentSessionEventTypes.ConversationItemAdded, {
      item: ChatMessage.create({
        role: "assistant",
        content: "Okay.",
        interrupted: true,
      }),
    });
    expect(updateOptions).toHaveBeenLastCalledWith({
      modelOptions: {
        ...getAssemblyAIInferenceSttProfileOptions("default"),
        agent_context: "Okay.",
      },
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
      modelOptions: {
        ...getAssemblyAIInferenceSttProfileOptions("email"),
        agent_context: "Can you spell that?",
      },
    });
  });

  it("sends inference model options and context, including inherited dictation prompts", () => {
    const { controller, updateOptions } = setup();
    const prompt = "Can I get the member ID from your insurance card?";
    controller.observeAssistantText(prompt, true);
    controller.commitAssistantTurn(prompt);
    expect(updateOptions).toHaveBeenLastCalledWith({
      modelOptions: {
        ...getAssemblyAIInferenceSttProfileOptions("memberId"),
        agent_context: prompt,
      },
    });
    controller.commitUserTurn();
    controller.commitAssistantTurn("Go ahead, spell that.");
    expect(controller.activeSttProfile).toBe("memberId");
    expect(updateOptions).toHaveBeenLastCalledWith({
      modelOptions: {
        ...getAssemblyAIInferenceSttProfileOptions("memberId"),
        agent_context: "Go ahead, spell that.",
      },
    });
  });

  it("preserves the entity profile across multiple finalized transcript chunks", () => {
    const { controller, updateOptions, updateEndpointing, session } = setup();
    controller.observeAssistantText("Can I get the member ID?", true);
    updateOptions.mockClear();
    updateEndpointing.mockClear();
    for (const transcript of ["A B", "one two", "three four"]) {
      session.emit(AgentSessionEventTypes.UserInputTranscribed, {
        isFinal: true,
        transcript,
      });
      expect(controller.activeSttProfile).toBe("memberId");
      expect(updateOptions).not.toHaveBeenCalled();
      expect(updateEndpointing).not.toHaveBeenCalled();
    }
    session.emit(AgentSessionEventTypes.ConversationItemAdded, {
      item: { type: "message", role: "user" },
    });
    expect(controller.activeSttProfile).toBe("default");
    expect(updateOptions).toHaveBeenCalledExactlyOnceWith({
      modelOptions: getAssemblyAIInferenceSttProfileOptions("default"),
    });
    expect(controller.sttProfiles.at(-1)?.reason).toBe("user_turn_committed");
    expect(updateEndpointing).toHaveBeenCalledExactlyOnceWith({
      minDelay: 300,
      maxDelay: 600,
    });
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
      modelOptions: {
        ...getAssemblyAIInferenceSttProfileOptions("email"),
        agent_context: "What is your email?",
      },
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
    expect(updateOptions.mock.lastCall?.[0].modelOptions.agent_context).toBe(
      "Welcome. How can I help?",
    );
    updateOptions.mockClear();
    controller.commitAssistantTurn("   ");
    expect(updateOptions).not.toHaveBeenCalled();
  });

  it("caps completed assistant context at the latest 1,500 characters", () => {
    const { controller, updateOptions } = setup();
    controller.commitAssistantTurn(`start-${"x".repeat(1_500)}-end`);
    const context = updateOptions.mock.lastCall?.[0].modelOptions
      .agent_context as string;
    expect(context).toHaveLength(1_500);
    expect(context).not.toContain("start-");
    expect(context).toContain("-end");
  });

  it("arms dictation recognition and fixed entity endpointing as the prompt enters TTS", async () => {
    const { controller, updateOptions, updateEndpointing } = setup();
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
    expect(updateEndpointing).toHaveBeenCalledExactlyOnceWith({
      minDelay: 500,
      maxDelay: 2500,
    });
    expect(controller.activeSttProfile).toBe("memberId");
    expect(updateOptions.mock.lastCall?.[0]).toEqual({
      modelOptions: {
        ...getAssemblyAIInferenceSttProfileOptions("memberId"),
      },
    });
  });
});
