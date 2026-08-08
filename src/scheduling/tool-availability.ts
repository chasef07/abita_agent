import { activeAppointments } from "../state/appointments.js";
import { activePatientId, type CallState } from "../state/call-state.js";
import { availabilitySlotsForState } from "./state.js";

export function schedulingToolIdsForState(state: CallState): string[] {
  if (!activePatientId(state)) return [];

  const toolIds = ["get_availability"];
  if (activeAppointments(state).length > 0) {
    toolIds.push("cancel_appointment");
  }

  if (availabilitySlotsForState(state).length === 0) return toolIds;

  if (state.workflow.current?.intent === "change_appointment") {
    toolIds.push("reschedule_appointment");
  } else if (state.workflow.current?.intent === "schedule") {
    toolIds.push("book_appointment");
  }

  return toolIds;
}
