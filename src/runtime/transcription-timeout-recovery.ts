import { AgentSessionEventTypes, type AgentSession } from "@livekit/agents";
import type { CallState } from "../state/call-state.js";

export const voiceTranscriptionTimeoutMs = 3_500;

const minimumSpeechDurationMs = 400;
const recoveryInstructions =
  "In the caller's current language, briefly say you didn't catch that and ask them to repeat it.";

export function attachTranscriptionTimeoutRecovery(
  session: AgentSession<CallState>,
): void {
  session.on(AgentSessionEventTypes.UserTranscriptionTimeout, (event) => {
    if (event.speechDuration < minimumSpeechDurationMs) return;
    session.generateReply({ instructions: recoveryInstructions });
  });
}
