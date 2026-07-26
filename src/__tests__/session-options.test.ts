import {
  AgentSession,
  type AgentSessionOptions,
  inference,
  initializeLogger,
} from "@livekit/agents";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  configureVoiceVad,
  voiceMaxToolSteps,
  voiceTurnHandlingOptions,
  voiceVadOptions,
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

  it("uses responsive fixed endpointing for normal conversation", () => {
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
    expect(voiceTurnHandlingOptions.endpointing).toEqual({
      maxDelay: 600,
      minDelay: 300,
      mode: "fixed",
    });
    expect(session.sessionOptions.turnHandling.endpointing).toMatchObject({
      maxDelay: 600,
      minDelay: 300,
      mode: "fixed",
    });
    expect(session.sessionOptions.turnHandling.interruption.mode).toBe(
      "adaptive",
    );
  });

  it("aligns the LiveKit VAD threshold with AssemblyAI", async () => {
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
      expect(session.vad).toBeInstanceOf(inference.VAD);
      const updateOptions = vi.spyOn(
        session.vad as inference.VAD,
        "updateOptions",
      );
      const vad = configureVoiceVad(session.vad);
      expect(updateOptions).toHaveBeenCalledWith(voiceVadOptions);
      expect(session.vad).toBe(vad);
      expect(vad.provider).toBe("livekit-local-inference");
      expect(vad.model).toBe("silero");
      expect(vad.minSilenceDuration).toBe(250);
      expect(voiceVadOptions).toEqual({
        activationThreshold: 0.3,
        deactivationThreshold: 0.15,
      });
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
