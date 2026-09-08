import { AgentSessionEventTypes, type AgentSession } from "@livekit/agents";
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
  it("sends plugin options and context directly, including inherited dictation prompts", () => {
    const { controller, updateOptions } = setup();
    const prompt = "Can I get the member ID from your insurance card?";
    controller.observeAssistantText(prompt, true);
    expect(updateOptions).toHaveBeenLastCalledWith({
      ...getAssemblyAISttProfileOptions("memberId"),
      agentContext: prompt,
    });
    controller.commitUserTurn();
    controller.observeAssistantText("Go ahead, spell that.", true);
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

  it("does not reset an armed profile when an assistant item is added", () => {
    const { controller, session, updateOptions } = setup();
    controller.observeAssistantText("What is your email?", true);
    updateOptions.mockClear();
    session.emit(AgentSessionEventTypes.ConversationItemAdded, {
      item: { type: "message", role: "assistant" },
    });
    expect(controller.activeSttProfile).toBe("email");
    expect(updateOptions).not.toHaveBeenCalled();
  });

  it("caps completed assistant context at the latest 1,500 characters", () => {
    const { controller, updateOptions } = setup();
    controller.observeAssistantText(`start-${"x".repeat(1_500)}-end`, true);
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
      agentContext: text,
    });
  });
});
