import {
  getOfficeProfile,
  getOfficeProfileByPhone,
  type AvailabilityOfficeKey,
} from "../customers/abita/profile.js";
import { activeOfficeKey } from "../state/call-lifecycle.js";
import { type CallState } from "../state/call-state.js";
import { appointmentForChangeContext } from "./appointments.js";
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
  clearAvailabilitySelection(state, { invalidateReads: "office_changed" });
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

  const appointment = appointmentForChangeContext(state);
  if (appointment) return defaultsToRoutineVision(appointment);

  return activeRoutingContext(state).routing === "optical_only";
}

function defaultsToRoutineVision(
  appointment: NonNullable<ReturnType<typeof appointmentForChangeContext>>,
): boolean {
  return (
    appointment.appointmentTypeId === undefined ||
    !KNOWN_MEDICAL_APPOINTMENT_TYPE_IDS.has(appointment.appointmentTypeId)
  );
}

const KNOWN_MEDICAL_APPOINTMENT_TYPE_IDS = new Set([
  1004, 1005, 1006, 1007, 1008, 6167, 6168, 6169,
]);
