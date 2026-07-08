import { getOfficeConfig } from "../customers/profile.js";
import {
  activeAppointments,
  activeOfficeKey,
  activeRoutingContext,
  currentWorkflowVisitType,
  type CallerAppointment,
  type CallState,
} from "../state/call-state.js";

export function getAmdOfficeForToolCall(state: CallState): string {
  return (
    state.office.phoneOverrides[activeOfficeKey(state)] ||
    getOfficeConfig(activeOfficeKey(state)).amdOfficePhone
  );
}

export function medicalSchedulingUnavailable(state: CallState): string | null {
  const office = getOfficeConfig(activeOfficeKey(state));
  if (office.features.medicalScheduling) return null;
  if (currentWorkflowVisitType(state) !== "medical") {
    const turn = state.workflow.current;
    if (turn?.intent !== "change_appointment") return null;
    if (isRoutineVisionSchedulingOrChange(state)) return null;
  }
  return `${office.displayName} supports routine vision and optical scheduling only. Do not schedule medical eye care through this office.`;
}

export function routineVisionSchedulingUnavailable(
  state: CallState,
): string | null {
  const office = getOfficeConfig(activeOfficeKey(state));
  if (office.features.routineVisionScheduling) return null;
  if (!isRoutineVisionSchedulingOrChange(state)) return null;

  return `${office.displayName} handles medical eye care, including cataract evaluations, but does not schedule routine eye exams, glasses prescriptions, or contact lens prescriptions. Do not schedule routine vision through this office.`;
}

export function routingForAvailability(state: CallState): string | null {
  if (isRoutineVisionSchedulingOrChange(state)) {
    return "optical_only";
  }
  return activeRoutingContext(state).routing;
}

function isRoutineVisionSchedulingOrChange(state: CallState): boolean {
  const visitType = currentWorkflowVisitType(state);
  if (visitType === "routine_vision") return true;
  if (visitType === "medical") return false;

  const turn = state.workflow.current;
  if (turn && turn.intent !== "change_appointment") return false;

  return (
    activeRoutingContext(state).routing === "optical_only" ||
    isRoutineVisionAppointment(existingAppointmentForChangeContext(state))
  );
}

function existingAppointmentForChangeContext(
  state: CallState,
): CallerAppointment | null {
  const appointments = activeAppointments(state);
  return (
    appointments.find((appointment) => appointment.confirmed) ??
    (appointments.length === 1 ? appointments[0] : null)
  );
}

function isRoutineVisionAppointment(
  appointment: CallerAppointment | null,
): boolean {
  if (
    appointment?.appointmentTypeId !== undefined &&
    ROUTINE_VISION_APPOINTMENT_TYPE_IDS.has(appointment.appointmentTypeId)
  ) {
    return true;
  }

  const normalizedType = normalizeAppointmentType(appointment?.type);
  if (!normalizedType) return false;

  return /\b(routine vision|routine eye|vision exam|eye exam|glasses|contacts?|contact lens|optical|optometry|optometrist|(?:new|established) (?:adult|pediatric) vision)\b/.test(
    normalizedType,
  );
}

const ROUTINE_VISION_APPOINTMENT_TYPE_IDS = new Set([1010, 3364, 4244, 4245]);

function normalizeAppointmentType(value: string | undefined): string {
  return (
    value
      ?.trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ") ?? ""
  );
}
