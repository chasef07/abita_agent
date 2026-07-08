import type { AgentSessionOptions } from "@livekit/agents";
import type { CallState } from "./state/call-state.js";

export const voiceMaxToolSteps = 3;

export const voiceTurnHandlingOptions = {
  preemptiveGeneration: {
    enabled: true,
    preemptiveTts: false,
    maxSpeechDuration: 4_000,
    maxRetries: 1,
  },
  interruption: {
    mode: "adaptive",
  },
} satisfies NonNullable<AgentSessionOptions<CallState>["turnHandling"]>;
