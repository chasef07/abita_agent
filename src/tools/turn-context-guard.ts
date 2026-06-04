import { llm } from "@livekit/agents";
import {
  activeAppointments,
  activePatientId,
  activeRoutingContext,
  type CallState,
} from "../state/call-state.js";

export function ensureSchedulingTurnContext(
  state: CallState,
  action: string,
): void {
  if (hasRecordedSchedulingContext(state)) return;
  throw new llm.ToolError(
    `Call record_turn_context with intent schedule and appointmentLane medical_md or routine_od before ${action}.`,
  );
}

export function ensureAvailabilityContext(
  state: CallState,
  action: string,
): void {
  if (hasRecordedSchedulingContext(state)) return;
  if (hasExistingAppointmentChangeContext(state)) return;
  throw new llm.ToolError(
    `Call record_turn_context with intent schedule and appointmentLane medical_md or routine_od, or identify the existing appointment to move, before ${action}.`,
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

function hasExistingAppointmentChangeContext(state: CallState): boolean {
  const turn = state.workflow.current;
  if (turn?.isEmergency) return false;
  if (turn && turn.intent !== "change_appointment") return false;
  if (!activePatientId(state)) return false;

  const selectedAppointment = existingAppointmentForChangeContext(state);
  if (!selectedAppointment) return false;

  return Boolean(
    activeRoutingContext(state).routing ||
    selectedAppointment.provider?.trim() ||
    selectedAppointment.type?.trim(),
  );
}

function existingAppointmentForChangeContext(state: CallState) {
  const appointments = activeAppointments(state);
  return (
    appointments.find((appointment) => appointment.confirmed) ??
    (appointments.length === 1 ? appointments[0] : null)
  );
}
