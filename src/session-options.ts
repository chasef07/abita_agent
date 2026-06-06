import type { voice } from "@livekit/agents";
import type { CallState } from "./state/call-state.js";

export const voiceTurnHandlingOptions = {
  interruption: {
    mode: "adaptive",
  },
  endpointing: {
    mode: "dynamic",
  },
} satisfies NonNullable<voice.AgentSessionOptions<CallState>["turnHandling"]>;
