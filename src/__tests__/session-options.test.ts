import { initializeLogger, voice } from "@livekit/agents";
import { beforeAll, describe, expect, it } from "vitest";
import {
  voiceMaxToolSteps,
  voiceTurnHandlingOptions,
} from "../session-options.js";

type TurnDetection = NonNullable<
  NonNullable<voice.AgentSessionOptions["turnHandling"]>["turnDetection"]
>;

describe("voice session options", () => {
  beforeAll(() => {
    initializeLogger({ pretty: false, level: "silent" });
  });

  it("disables preemptive generation", () => {
    const session = new voice.AgentSession({
      turnHandling: {
        turnDetection: fakeTurnDetector(),
        ...voiceTurnHandlingOptions,
      },
    });

    expect(
      session.sessionOptions.turnHandling.preemptiveGeneration.enabled,
    ).toBe(false);
    expect(
      session.sessionOptions.turnHandling.preemptiveGeneration.preemptiveTts,
    ).toBe(false);
  });

  it("uses the LiveKit turn detector with dynamic endpointing", () => {
    const turnDetection = fakeTurnDetector();
    const session = new voice.AgentSession({
      turnHandling: {
        turnDetection,
        ...voiceTurnHandlingOptions,
      },
    });

    expect(session.sessionOptions.turnHandling.turnDetection).toBe(
      turnDetection,
    );
    expect(session.sessionOptions.turnHandling.endpointing.mode).toBe(
      "dynamic",
    );
    expect(session.sessionOptions.turnHandling.interruption.mode).toBe(
      "adaptive",
    );
  });

  it("allows two tool calls before the post-tool reply", () => {
    const session = new voice.AgentSession({
      maxToolSteps: voiceMaxToolSteps,
      turnHandling: {
        turnDetection: fakeTurnDetector(),
        ...voiceTurnHandlingOptions,
      },
    });

    expect(session.sessionOptions.maxToolSteps).toBe(3);
  });
});

function fakeTurnDetector(): TurnDetection {
  return {
    model: "test-turn-detector",
    provider: "livekit",
    predictEndOfTurn: async () => 1,
    supportsLanguage: async () => true,
    unlikelyThreshold: async () => 0.5,
  };
}
