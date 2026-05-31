import type { voice } from "@livekit/agents";
import type { CallState } from "./state/call-state.js";

export const voiceTurnHandlingOptions = {
  turnDetection: "stt",
  preemptiveGeneration: {
    enabled: false,
  },
  interruption: {
    mode: "adaptive",
    minDuration: 1000,
    minWords: 3,
    discardAudioIfUninterruptible: true,
    falseInterruptionTimeout: 2500,
    resumeFalseInterruption: true,
  },
  endpointing: {
    minDelay: 0,
  },
} satisfies NonNullable<voice.AgentSessionOptions<CallState>["turnHandling"]>;
