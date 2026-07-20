import {
  getOfficeProfile,
  getOfficeProfileByPhone,
  type AvailabilityOfficeKey,
} from "../customers/abita/profile.js";
import { activeAppointments } from "../state/appointments.js";
import { activeOfficeKey } from "../state/call-lifecycle.js";
import { type CallerAppointment, type CallState } from "../state/call-state.js";
import {
  activeRoutingContext,
  clearAvailabilitySelection,
  currentWorkflowVisitType,
} from "./state.js";

export function selectAvailabilityOffice(
  state: CallState,
  requestedOffice: AvailabilityOfficeKey | undefined,
): string | null {
  const trunkOffice = getOfficeProfileByPhone(state.runtime.trunkPhone);
  const selection = trunkOffice.availabilityOfficeFor(requestedOffice);
  if (selection.status === "blocked") return selection.message;
  if (selection.status === "current") return null;
  if (activeOfficeKey(state) === selection.office.key) return null;

  const { office } = selection;
  clearAvailabilitySelection(state);
  state.office.activeKey = office.key;
  state.office.phoneOverrides[office.key] ??= office.amdOfficePhone;
  return null;
}

export function getAmdOfficeForToolCall(state: CallState): string {
  return (
    state.office.phoneOverrides[activeOfficeKey(state)] ||
    getOfficeProfile(activeOfficeKey(state)).amdOfficePhone
  );
}

export function medicalSchedulingUnavailable(state: CallState): string | null {
  const office = getOfficeProfile(activeOfficeKey(state));
  const policy = office.schedulingFor("medical");
  if (policy.supported) return null;
  if (currentWorkflowVisitType(state) !== "medical") {
    const turn = state.workflow.current;
    if (turn?.intent !== "change_appointment") return null;
    if (isRoutineVisionSchedulingOrChange(state)) return null;
  }
  return policy.message;
}

export function routineVisionSchedulingUnavailable(
  state: CallState,
): string | null {
  const office = getOfficeProfile(activeOfficeKey(state));
  const policy = office.schedulingFor("routine_vision");
  if (policy.supported) return null;
  if (!isRoutineVisionSchedulingOrChange(state)) return null;

  return policy.message;
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
