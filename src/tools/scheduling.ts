import {
  getOfficeConfig,
  SPRING_HILL_OFFICE_PHONE,
} from "../customer/profile.js";
import {
  activeAppointments,
  activeOfficeKey,
  activeRoutingContext,
  clearAvailabilitySelection,
  currentWorkflowVisitType,
  setActiveOfficeKey,
  type CallerAppointment,
  type CallState,
} from "../state/call-state.js";

export function getAmdOfficeForToolCall(state: CallState): string {
  return (
    state.office.phoneOverrides[activeOfficeKey(state)] ||
    getOfficeConfig(activeOfficeKey(state)).amdOfficePhone
  );
}

export function ensureRoutineVisionOffice(state: CallState): void {
  if (!isRoutineVisionSchedulingOrChange(state)) return;
  if (
    !getOfficeConfig(activeOfficeKey(state)).features
      .routeRoutineVisionToSpringHill
  ) {
    return;
  }
  clearAvailabilitySelection(state);
  state.office.phoneOverrides = {
    ...state.office.phoneOverrides,
    "spring-hill": SPRING_HILL_OFFICE_PHONE,
  };
  setActiveOfficeKey(state, "spring-hill");
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
