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

  it("enables speculative LLM generation while deferring speech synthesis", () => {
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
  });

  it("keeps dynamic endpointing bounds stable across the conversation", () => {
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
      maxDelay: 2500,
      minDelay: 300,
      mode: "dynamic",
      alpha: 0.9,
    });
    expect(session.sessionOptions.turnHandling.endpointing).toMatchObject({
      maxDelay: 2500,
      minDelay: 300,
      mode: "dynamic",
      alpha: 0.9,
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

  it("preserves the SDK's learned pause across intake and user-turn profile changes", async () => {
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
      // Inspect the actual SDK strategy: recreating it would discard learned pauses.
      const recognition = (
        activity as unknown as {
          audioRecognition: {
            endpointing: {
              minDelay: number;
              onStartOfSpeech: (at: number) => void;
              onEndOfSpeech: (at: number) => void;
            };
          };
        }
      ).audioRecognition;
      const strategy = recognition.endpointing;
      for (let index = 0; index < 6; index++) {
        strategy.onStartOfSpeech(1000 + index * 1000);
        strategy.onEndOfSpeech(1200 + index * 1000);
      }
      const learned = strategy.minDelay;
      expect(learned).toBeGreaterThan(300);
      const controller = createTurnProfileController(
        { updateOptions: vi.fn() },
        { startedAt: new Date() },
      );
      controller.observeAssistantText("What is your email?", true);
      controller.commitUserTurn();
      controller.observeAssistantText("Can you spell that?", true);
      expect(recognition.endpointing).toBe(strategy);
      expect(recognition.endpointing.minDelay).toBe(learned);
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
