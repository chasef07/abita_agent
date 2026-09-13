import {
  getOfficeProfile,
  getOfficeProfileByPhone,
  type AvailabilityOfficeKey,
} from "../customers/abita/profile.js";
import { activateOffice, activeOfficeKey } from "../state/call-lifecycle.js";
import { type CallState, type CallerAppointment } from "../state/call-state.js";
import { activeRoutingContext } from "./state.js";
import { clearAvailabilitySelection } from "./availability.js";

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
  clearAvailabilitySelection(state, { invalidateReads: true });
  activateOffice(state, office);
  return null;
}

export function getAmdOfficeForToolCall(state: CallState): string {
  return getOfficeProfile(activeOfficeKey(state)).amdOfficePhone;
}

export function medicalSchedulingUnavailable(state: CallState): string | null {
  const office = getOfficeProfile(activeOfficeKey(state));
  const policy = office.schedulingFor("medical");
  if (policy.supported) return null;
  if (state.workflow.visitType !== "medical") return null;
  return policy.message;
}

export function routineVisionSchedulingUnavailable(
  state: CallState,
): string | null {
  const office = getOfficeProfile(activeOfficeKey(state));
  const policy = office.schedulingFor("routine_vision");
  if (policy.supported) return null;
  if (state.workflow.visitType !== "routine_vision") return null;

  return policy.message;
}

export function routingForAvailability(state: CallState): string | null {
  if (state.workflow.visitType === "routine_vision") {
    return "optical_only";
  }
  return activeRoutingContext(state).routing;
}

export function visitTypeForAppointment(
  appointment: CallerAppointment,
): "medical" | "routine_vision" {
  return appointment.appointmentTypeId !== undefined &&
    KNOWN_MEDICAL_APPOINTMENT_TYPE_IDS.has(appointment.appointmentTypeId)
    ? "medical"
    : "routine_vision";
}

const KNOWN_MEDICAL_APPOINTMENT_TYPE_IDS = new Set([
  1004, 1005, 1006, 1007, 1008, 6167, 6168, 6169,
]);
