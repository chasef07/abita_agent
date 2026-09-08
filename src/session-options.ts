import { inference, type AgentSessionOptions } from "@livekit/agents";
import type { CallState } from "./state/call-state.js";

export const voiceMaxToolSteps = 3;

export const voiceVadOptions = {
  // Preserve the voice sensitivity used in our paired audio replays.
  activationThreshold: 0.3,
  deactivationThreshold: 0.15,
} as const;

export function configureVoiceVad(vad: unknown): inference.VAD {
  if (!(vad instanceof inference.VAD)) {
    throw new Error("Expected LiveKit local-inference Silero VAD");
  }
  vad.updateOptions(voiceVadOptions);
  return vad;
}

export const voiceEndpointingProfiles = {
  conversation: { minDelay: 300, maxDelay: 600 },
  deliberate: { minDelay: 500, maxDelay: 2500 },
} as const;

export const voiceTurnHandlingOptions = {
  endpointing: {
    mode: "fixed",
    ...voiceEndpointingProfiles.conversation,
  },
  preemptiveGeneration: {
    enabled: false,
    preemptiveTts: false,
  },
  interruption: {
    mode: "adaptive",
  },
} satisfies NonNullable<AgentSessionOptions<CallState>["turnHandling"]>;
