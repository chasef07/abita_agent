import { ToolError } from "@livekit/agents";
import {
  activeAppointments,
  activeAppointmentsStatus,
  activePatientId,
  activeRoutingContext,
  applySchedulingLaneToState,
  applyTurnContextToState,
  type CallState,
  type SchedulingAppointmentLane,
} from "../state/call-state.js";

export function prepareAvailabilityLookupContext(
  state: CallState,
  appointmentLane: SchedulingAppointmentLane | undefined,
): void {
  if (appointmentLane) {
    applySchedulingLaneToState(state, appointmentLane);
    return;
  }

  if (
    hasExistingAppointmentChangeContext(state, { ignoreCurrentIntent: true })
  ) {
    applyTurnContextToState(state, {
      intent: "change_appointment",
      appointmentLane: "not_applicable",
    });
  }
}

export function ensureAvailabilityContext(
  state: CallState,
  action: string,
): void {
  if (availabilityContextReady(state)) return;
  throw new ToolError(
    `Pass appointmentLane medical_md or routine_od, or identify the existing appointment to move, before ${action}.`,
  );
}

export function availabilityContextRecovery(state: CallState): string | null {
  if (availabilityContextReady(state)) return null;

  const appointments = activeAppointments(state);
  if (appointments.length > 0) {
    return "Before checking availability, ask which loaded appointment the caller wants to move. If this is a new appointment instead, call get_availability again with appointmentLane medical_md or routine_od.";
  }

  if (
    activeAppointmentsStatus(state) === null ||
    activeAppointmentsStatus(state) === "error"
  ) {
    return "Before checking availability for a reschedule, load appointments by resolving the patient. If this is a new appointment instead, call get_availability again with appointmentLane medical_md or routine_od.";
  }

  return "Before checking availability for a new appointment, call get_availability again with appointmentLane medical_md or routine_od.";
}

function availabilityContextReady(state: CallState): boolean {
  return (
    hasRecordedSchedulingContext(state) ||
    hasExistingAppointmentChangeContext(state)
  );
}

function hasRecordedSchedulingContext(state: CallState): boolean {
  const turn = state.workflow.current;
  return Boolean(
    turn &&
    turn.intent === "schedule" &&
    (turn.appointmentLane === "medical_md" ||
      turn.appointmentLane === "routine_od"),
  );
}

function hasExistingAppointmentChangeContext(
  state: CallState,
  options: { ignoreCurrentIntent?: boolean } = {},
): boolean {
  const turn = state.workflow.current;
  if (
    !options.ignoreCurrentIntent &&
    turn &&
    turn.intent !== "change_appointment"
  )
    return false;
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
