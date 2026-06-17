import type { voice } from "@livekit/agents";
import type { CallState } from "./state/call-state.js";

export const voiceMaxToolSteps = 3;

export const voiceTurnHandlingOptions = {
  preemptiveGeneration: {
    enabled: false,
  },
  interruption: {
    mode: "adaptive",
  },
} satisfies NonNullable<voice.AgentSessionOptions<CallState>["turnHandling"]>;
