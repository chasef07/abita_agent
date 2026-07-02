import type { RunContext } from "@livekit/agents";
import type { CallState } from "../state/call-state.js";

// Per-call state lives on session.userData so concurrent calls do not collide.
export function getState(ctx: RunContext): CallState {
  return ctx.session.userData as CallState;
}
