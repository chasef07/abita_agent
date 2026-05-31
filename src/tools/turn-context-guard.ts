import { llm } from "@livekit/agents";
import type { InsuranceCoverageType } from "../insurance-rules.js";
import {
  activeInsuranceContext,
  activeRoutingContext,
  applyTurnContextToState,
  type AppointmentLane,
  type CallState,
} from "../state/call-state.js";

type SchedulingContextHints = {
  coverageType?: InsuranceCoverageType | null;
};

export function ensureSchedulingTurnContext(
  state: CallState,
  action: string,
  hints: SchedulingContextHints = {},
): void {
  if (hasRecordedSchedulingContext(state)) return;

  const appointmentLane = inferSchedulingAppointmentLane(state, hints);
  if (appointmentLane) {
    applyTurnContextToState(state, {
      intent: "schedule",
      appointmentLane,
      isEmergency: false,
      confidence: 0.99,
    });
    return;
  }

  throw new llm.ToolError(
    `Call record_turn_context with intent schedule and appointmentLane medical_md or routine_od before ${action}.`,
  );
}

function hasRecordedSchedulingContext(state: CallState): boolean {
  const turn = state.turnContext.last;
  return Boolean(
    turn &&
    turn.intent === "schedule" &&
    !turn.isEmergency &&
    (turn.appointmentLane === "medical_md" ||
      turn.appointmentLane === "routine_od"),
  );
}

function inferSchedulingAppointmentLane(
  state: CallState,
  hints: SchedulingContextHints,
): AppointmentLane | null {
  const coverageType =
    hints.coverageType ??
    state.scheduling.coverageType ??
    activeInsuranceContext(state).coverageType;
  if (coverageType === "routine_vision") return "routine_od";
  if (coverageType === "medical") return "medical_md";

  if (state.scheduling.visitType === "routine_vision") return "routine_od";
  if (state.scheduling.visitType === "medical") return "medical_md";

  const routing = activeRoutingContext(state).routing;
  if (routing === "optical_only") return "routine_od";
  if (
    routing === "bach_only" ||
    routing === "bach_licht" ||
    routing === "all_three"
  ) {
    return "medical_md";
  }

  return null;
}
