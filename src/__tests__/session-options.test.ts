import {
  AgentSession,
  Agent,
  type AgentSessionOptions,
  inference,
  initializeLogger,
  voice,
} from "@livekit/agents";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  configureVoiceVad,
  voiceMaxToolSteps,
  voiceTurnHandlingOptions,
  voiceVadOptions,
} from "../session-options.js";
import { createTurnProfileController } from "../runtime/turn-profile-controller.js";

type TurnDetection = NonNullable<
  NonNullable<AgentSessionOptions["turnHandling"]>["turnDetection"]
>;

describe("voice session options", () => {
  beforeAll(() => {
    initializeLogger({ pretty: false, level: "silent" });
  });

  it("keeps speculative generation and speech synthesis disabled", () => {
    const session = new AgentSession({
      turnHandling: {
        turnDetection: fakeTurnDetector(),
        ...voiceTurnHandlingOptions,
      },
    });
    const preemptiveGeneration =
      session.sessionOptions.turnHandling.preemptiveGeneration;

    expect(preemptiveGeneration.enabled).toBe(false);
    expect(preemptiveGeneration.preemptiveTts).toBe(false);
  });

  it("starts with the original fixed conversation bounds", () => {
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

  it("preserves the tested LiveKit VAD sensitivity", async () => {
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

  it("switches the actual SDK between fixed entity and conversation bounds", async () => {
    const session = new AgentSession({
      llm: new voice.testing.FakeLLM([]),
      vad: null,
      turnHandling: {
        ...voiceTurnHandlingOptions,
        turnDetection: null,
        interruption: { mode: "vad" },
      },
    });
    try {
      await session.start({
        agent: new Agent({ instructions: "Local timing test." }),
      });
      const activity = await session.waitForIdle();
      const recognition = (
        activity as unknown as {
          audioRecognition: {
            endpointing: { minDelay: number; maxDelay: number };
          };
        }
      ).audioRecognition;
      const controller = createTurnProfileController(
        { updateOptions: vi.fn() },
        {
          startedAt: new Date(),
          updateEndpointing: (endpointing) =>
            session.updateOptions({
              turnHandling: { endpointing: { mode: "fixed", ...endpointing } },
            }),
        },
      );
      expect({
        minDelay: recognition.endpointing.minDelay,
        maxDelay: recognition.endpointing.maxDelay,
      }).toEqual({ minDelay: 300, maxDelay: 600 });
      controller.observeAssistantText("What is your email?", true);
      expect({
        minDelay: recognition.endpointing.minDelay,
        maxDelay: recognition.endpointing.maxDelay,
      }).toEqual({ minDelay: 500, maxDelay: 2500 });
      controller.commitAssistantTurn("What is your email?");
      controller.commitUserTurn();
      expect({
        minDelay: recognition.endpointing.minDelay,
        maxDelay: recognition.endpointing.maxDelay,
      }).toEqual({ minDelay: 300, maxDelay: 600 });
      controller.commitAssistantTurn("Can you spell that?");
      expect({
        minDelay: recognition.endpointing.minDelay,
        maxDelay: recognition.endpointing.maxDelay,
      }).toEqual({ minDelay: 500, maxDelay: 2500 });
      expect(session.sessionOptions.turnHandling.endpointing.mode).toBe(
        "fixed",
      );
      expect(
        session.sessionOptions.turnHandling.preemptiveGeneration.enabled,
      ).toBe(false);
    } finally {
      await session.close();
    }
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
