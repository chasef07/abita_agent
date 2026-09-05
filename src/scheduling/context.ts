import {
  activeAppointments,
  activeAppointmentsStatus,
} from "../state/appointments.js";
import {
  activePatientId,
  type CallState,
  type SchedulingAppointmentLane,
} from "../state/call-state.js";
import {
  activeRoutingContext,
  applySchedulingLaneToState,
  applyTurnContextToState,
} from "./state.js";
import {
  appointmentForChangeContext,
  rescheduleAppointmentForState,
} from "./appointments.js";
import { SchedulingInputRequired } from "./input-required.js";

export function prepareAvailabilityLookupContext(
  state: CallState,
  appointmentLane: SchedulingAppointmentLane | undefined,
  oldAppointmentRef: string | undefined,
): void {
  if (oldAppointmentRef) {
    const selection = rescheduleAppointmentForState(state, oldAppointmentRef);
    if (selection.status !== "selected") {
      throw new SchedulingInputRequired(selection.message);
    }
    applyTurnContextToState(state, {
      intent: "change_appointment",
      appointmentLane: "not_applicable",
      oldAppointmentRef: selection.appointment.appointmentRef,
    });
    return;
  }

  if (appointmentLane) {
    applySchedulingLaneToState(state, appointmentLane);
    return;
  }

  const appointment = appointmentForChangeContext(state);
  if (appointment) {
    applyTurnContextToState(state, {
      intent: "change_appointment",
      appointmentLane: "not_applicable",
      ...(appointment.appointmentRef
        ? { oldAppointmentRef: appointment.appointmentRef }
        : {}),
    });
    return;
  }
}

export function ensureAvailabilityContext(
  state: CallState,
  action: string,
): void {
  if (availabilityContextReady(state)) return;
  throw new SchedulingInputRequired(
    `I need to know whether this is medical or routine vision, or which existing appointment you want to move, before ${action}.`,
  );
}

export function availabilityContextRecovery(state: CallState): string | null {
  if (availabilityContextReady(state)) return null;

  const appointments = activeAppointments(state);
  if (appointments.length > 0) {
    return "Which upcoming appointment would you like to move?";
  }

  if (
    activeAppointmentsStatus(state) === null ||
    activeAppointmentsStatus(state) === "error"
  ) {
    return "I need to load the upcoming appointments before I can reschedule. Is this instead a new appointment?";
  }

  return "Is this visit for medical care or routine vision?";
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

function hasExistingAppointmentChangeContext(state: CallState): boolean {
  const turn = state.workflow.current;
  if (turn && turn.intent !== "change_appointment") return false;
  if (!activePatientId(state)) return false;

  const selectedAppointment = appointmentForChangeContext(state);
  if (!selectedAppointment) return false;

  return Boolean(
    activeRoutingContext(state).routing ||
    selectedAppointment.provider?.trim() ||
    selectedAppointment.type?.trim(),
  );
}
