import { llm } from "@livekit/agents";
import type { CallState } from "../state/call-state.js";

export function ensureSchedulingTurnContext(
  state: CallState,
  action: string,
): void {
  if (hasRecordedSchedulingContext(state)) return;
  throw new llm.ToolError(
    `Call record_turn_context with intent schedule and appointmentLane medical_md or routine_od before ${action}.`,
  );
}

function hasRecordedSchedulingContext(state: CallState): boolean {
  const turn = state.workflow.current;
  return Boolean(
    turn &&
    turn.intent === "schedule" &&
    !turn.isEmergency &&
    (turn.appointmentLane === "medical_md" ||
      turn.appointmentLane === "routine_od"),
  );
}
