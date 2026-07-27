import { AgentSessionEventTypes, type AgentSession } from "@livekit/agents";
import { describe, expect, it, vi } from "vitest";
import { observeAssistantText } from "../agent.js";
import {
  attachTurnProfileLifecycle,
  createTurnProfileController,
} from "../runtime/turn-profile-controller.js";
import type { CallState } from "../state/call-state.js";

type TurnProfileStt = Parameters<typeof createTurnProfileController>[0];

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
  it("applies profile and latest assistant context through Inference model options", () => {
    const updateOptions = vi.fn();
    const stt = {
      updateOptions,
    } as TurnProfileStt;
    const controller = createTurnProfileController(stt, {
      startedAt: new Date("2026-07-23T10:00:00.000Z"),
      updateEndpointing: vi.fn(),
    });

    controller.observeAssistantText(
      "Can I get the member ID from your insurance card?",
      true,
    );
    expect(updateOptions).toHaveBeenLastCalledWith({
      modelOptions: {
        agent_context: "Can I get the member ID from your insurance card?",
        keyterms_prompt: [],
        max_turn_silence: 3000,
        min_turn_silence: 450,
        vad_threshold: 0.3,
      },
    });

    controller.observeAssistantText("Go ahead, spell that.", true);
    expect(controller.activeSttProfile).toBe("memberId");
    expect(updateOptions).toHaveBeenLastCalledWith({
      modelOptions: {
        agent_context: "Go ahead, spell that.",
        keyterms_prompt: [],
        max_turn_silence: 3000,
        min_turn_silence: 450,
        vad_threshold: 0.3,
      },
    });
  });

  it("caps completed assistant context at the latest 1,500 characters", () => {
    const updateOptions = vi.fn();
    const stt = {
      updateOptions,
    } as TurnProfileStt;
    const controller = createTurnProfileController(stt, {
      startedAt: new Date("2026-07-23T10:00:00.000Z"),
      updateEndpointing: vi.fn(),
    });
    const assistantText = `start-${"x".repeat(1_500)}-end`;

    controller.observeAssistantText(assistantText, true);

    const lastUpdate = updateOptions.mock.lastCall?.[0] as {
      modelOptions: { agent_context: string };
    };
    expect(lastUpdate.modelOptions.agent_context).toHaveLength(1_500);
    expect(lastUpdate.modelOptions.agent_context).not.toContain("start-");
    expect(lastUpdate.modelOptions.agent_context).toContain("-end");
  });

  it("arms deliberate endpointing while the assistant prompt enters TTS", async () => {
    const updateEndpointing = vi.fn();
    const stt = {
      updateOptions: vi.fn(),
    } as TurnProfileStt;
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
    const updateOptions = vi.fn();
    const stt = {
      updateOptions,
    } as TurnProfileStt;
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
    expect(controller.activeSttProfile).toBe("default");
    expect(updateOptions).toHaveBeenLastCalledWith({
      modelOptions: {
        keyterms_prompt: [
          "Abita Eye Group",
          "Eye Radiance",
          "Spring Hill",
          "Crystal River",
          "Dr. Bach",
          "Dr. Noel",
          "Dr. Licht",
          "Austin Bach",
          "iCare",
          "Ambetter",
        ],
        max_turn_silence: 2000,
        min_turn_silence: 275,
        vad_threshold: 0.3,
      },
    });

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
