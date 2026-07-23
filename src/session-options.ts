import type { AgentSessionOptions } from "@livekit/agents";
import type { CallState } from "./state/call-state.js";

export const voiceMaxToolSteps = 3;

export const voiceEndpointingProfiles = {
  conversation: {
    minDelay: 300,
    maxDelay: 600,
  },
  deliberate: {
    minDelay: 500,
    maxDelay: 2_500,
  },
} as const;

export const voiceTurnHandlingOptions = {
  endpointing: {
    mode: "fixed",
    ...voiceEndpointingProfiles.conversation,
  },
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
