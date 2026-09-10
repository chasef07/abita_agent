import { getOfficeProfile } from "../customers/abita/profile.js";
import { activeOfficeKey } from "../state/call-lifecycle.js";
import {
  activePatientName,
  type AppointmentActionStatus,
  type AppointmentAnalytics,
  type CallState,
  type CallerAppointment,
  type StoredAvailabilitySlot,
} from "../state/call-state.js";
import { latestAvailabilityRouting } from "./state.js";
import type { BookingResult } from "./middleware.js";

export function bookedSlotAppointmentAnalytics(
  state: CallState,
  selectedSlot: StoredAvailabilitySlot,
  result: BookingResult,
): AppointmentAnalytics {
  const booking =
    result.status === "booked" || result.status === "partial" ? result : null;
  return stripEmptyFields({
    patientName: activePatientName(state) ?? undefined,
    appointmentDate: selectedSlot.date,
    appointmentTime: selectedSlot.time,
    startDatetime: selectedSlot.datetime,
    providerName: booking?.providerName ?? selectedSlot.provider,
    locationName:
      booking?.locationName ??
      getOfficeProfile(activeOfficeKey(state)).displayName,
    appointmentTypeName: booking?.appointmentTypeName ?? undefined,
    careLane: careLaneForBookedSlot(state, selectedSlot),
  });
}

export function cancelledAppointmentAnalytics(
  state: CallState,
  appointment: CallerAppointment,
  patientName: string | null = activePatientName(state),
): AppointmentAnalytics {
  return stripEmptyFields({
    patientName: patientName ?? undefined,
    appointmentDate: appointment.date,
    appointmentTime: appointment.time,
    providerName: appointment.provider,
    locationName: appointment.facility,
    appointmentTypeName: appointment.type,
    careLane: careLaneForAppointment(appointment),
  });
}

export function appointmentActionStatusForBookingResult(
  result: BookingResult,
): AppointmentActionStatus {
  return result.status === "partial" ? "partial" : "success";
}

function careLaneForBookedSlot(
  state: CallState,
  selectedSlot: StoredAvailabilitySlot,
): string | undefined {
  const visitType = state.workflow.visitType;
  if (visitType === "medical") return "medical_md";
  if (visitType === "routine_vision") return "routine_od";

  const routing = selectedSlot.routing ?? latestAvailabilityRouting(state);
  if (routing === "optical_only") return "routine_od";
  if (routing) return "medical_md";
  return undefined;
}

function careLaneForAppointment(
  appointment: CallerAppointment,
): string | undefined {
  const normalized = `${appointment.type} ${appointment.facility}`
    .trim()
    .toLowerCase();
  if (!normalized) return undefined;
  if (/\broutine\b|\bvision\b|\boptical\b|\bglasses\b/.test(normalized)) {
    return "routine_od";
  }
  if (/\bmedical\b|\bfollow\s*-?\s*up\b|\bpost\s*-?\s*op\b/.test(normalized)) {
    return "medical_md";
  }
  return undefined;
}

function stripEmptyFields(input: AppointmentAnalytics): AppointmentAnalytics {
  return Object.fromEntries(
    Object.entries(input).filter(
      ([, value]) => typeof value === "string" && value.trim(),
    ),
  );
}
