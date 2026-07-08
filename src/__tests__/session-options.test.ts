import {
  AgentSession,
  type AgentSessionOptions,
  inference,
  initializeLogger,
} from "@livekit/agents";
import { beforeAll, describe, expect, it } from "vitest";
import {
  voiceMaxToolSteps,
  voiceTurnHandlingOptions,
} from "../session-options.js";

type TurnDetection = NonNullable<
  NonNullable<AgentSessionOptions["turnHandling"]>["turnDetection"]
>;

describe("voice session options", () => {
  beforeAll(() => {
    initializeLogger({ pretty: false, level: "silent" });
  });

  it("uses bounded LLM-only preemptive generation", () => {
    const session = new AgentSession({
      turnHandling: {
        turnDetection: fakeTurnDetector(),
        ...voiceTurnHandlingOptions,
      },
    });
    const preemptiveGeneration =
      session.sessionOptions.turnHandling.preemptiveGeneration;

    expect(preemptiveGeneration.enabled).toBe(true);
    expect(preemptiveGeneration.preemptiveTts).toBe(false);
    expect(preemptiveGeneration.maxSpeechDuration).toBe(4_000);
    expect(preemptiveGeneration.maxRetries).toBe(1);
  });

  it("uses the provided turn detector without overriding endpointing", () => {
    const turnDetection = fakeTurnDetector();
    const session = new AgentSession({
      turnHandling: {
        turnDetection,
        ...voiceTurnHandlingOptions,
      },
    });

    expect(session.sessionOptions.turnHandling.turnDetection).toBe(
      turnDetection,
    );
    expect(session.sessionOptions.turnHandling.endpointing.mode).toBe("fixed");
    expect(session.sessionOptions.turnHandling.endpointing.minDelay).toBe(500);
    expect(session.sessionOptions.turnHandling.endpointing.maxDelay).toBe(3000);
    expect(session.sessionOptions.turnHandling.interruption.mode).toBe(
      "adaptive",
    );
  });

  it("uses the bundled default VAD and streaming endpointing defaults", async () => {
    const turnDetection = new inference.TurnDetector({ version: "v1-mini" });
    const session = new AgentSession({
      turnHandling: {
        turnDetection,
        ...voiceTurnHandlingOptions,
      },
    });

    try {
      expect(session.sessionOptions.turnHandling.turnDetection).toBe(
        turnDetection,
      );
      expect(session.sessionOptions.turnHandling.endpointing.mode).toBe(
        "fixed",
      );
      expect(session.sessionOptions.turnHandling.endpointing.minDelay).toBe(
        300,
      );
      expect(session.sessionOptions.turnHandling.endpointing.maxDelay).toBe(
        2500,
      );
      expect(session.vad?.provider).toBe("livekit-local-inference");
      expect(session._usingDefaultVad).toBe(true);
    } finally {
      await session.close().catch(() => undefined);
    }
  });

  it("allows two tool calls before the post-tool reply", () => {
    const session = new AgentSession({
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
