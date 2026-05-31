import { voice } from "@livekit/agents";
import type { CallState } from "../state/call-state.js";

// Per-call state lives on session.userData so concurrent calls do not collide.
export function getState(ctx: voice.RunContext): CallState {
  return ctx.session.userData as CallState;
}

export function disableInterruptionsForWrite(
  ctx: Pick<voice.RunContext, "speechHandle">,
): boolean {
  try {
    ctx.speechHandle.allowInterruptions = false;
    return true;
  } catch (err) {
    console.warn("[tools] Could not disable write interruptions:", err);
    return false;
  }
}
