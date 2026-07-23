import { AgentSessionEventTypes, type AgentSession } from "@livekit/agents";
import type * as assemblyai from "@livekit/agents-plugin-assemblyai";
import { describe, expect, it, vi } from "vitest";
import { observeAssistantText } from "../agent.js";
import {
  attachTurnProfileLifecycle,
  createTurnProfileController,
} from "../runtime/turn-profile-controller.js";
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

describe("turn profile controller", () => {
  it("arms deliberate endpointing while the assistant prompt enters TTS", async () => {
    const updateEndpointing = vi.fn();
    const stt = {
      updateOptions: vi.fn(),
    } as unknown as assemblyai.STT;
    const controller = createTurnProfileController(stt, {
      startedAt: new Date("2026-07-23T10:00:00.000Z"),
      updateEndpointing,
    });
    const assistantText = observeAssistantText(
      chunks("Can I get the ", "member ID from your insurance card?"),
      controller.observeAssistantText,
    );

    expect(await collect(assistantText)).toBe(
      "Can I get the member ID from your insurance card?",
    );
    expect(updateEndpointing).toHaveBeenLastCalledWith({
      maxDelay: 2_500,
      minDelay: 500,
    });
  });

  it("keeps deliberate endpointing until LiveKit commits the user turn", () => {
    const updateEndpointing = vi.fn();
    const stt = {
      updateOptions: vi.fn(),
    } as unknown as assemblyai.STT;
    const controller = createTurnProfileController(stt, {
      startedAt: new Date("2026-07-23T10:00:00.000Z"),
      updateEndpointing,
    });
    const session = new TestSession();
    attachTurnProfileLifecycle(
      session as unknown as AgentSession<CallState>,
      controller,
    );

    controller.observeAssistantText(
      "Can I get the member ID from your insurance card?",
      true,
    );
    session.emit(AgentSessionEventTypes.UserInputTranscribed, {
      createdAt: Date.parse("2026-07-23T10:00:10.000Z"),
      isFinal: true,
      transcript: "My member ID is A B C one two three.",
    });

    expect(updateEndpointing).toHaveBeenCalledTimes(1);

    session.emit(AgentSessionEventTypes.ConversationItemAdded, {
      createdAt: Date.parse("2026-07-23T10:00:11.000Z"),
      item: {
        id: "user-turn-1",
        interrupted: false,
        metrics: {},
        role: "user",
        textContent: "My member ID is A B C one two three.",
        type: "message",
      },
    });

    expect(updateEndpointing).toHaveBeenLastCalledWith({
      maxDelay: 600,
      minDelay: 300,
    });
  });
});

async function* chunks(...values: string[]): AsyncIterable<string> {
  yield* values;
}

async function collect(values: AsyncIterable<string>): Promise<string> {
  let text = "";
  for await (const value of values) text += value;
  return text;
}
