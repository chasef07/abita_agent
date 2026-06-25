import { getOfficeConfig } from "../customer/profile.js";
import {
  activeOfficeKey,
  activePatientName,
  currentWorkflowVisitType,
  latestAvailabilityRouting,
  type AppointmentActionStatus,
  type AppointmentAnalytics,
  type CallState,
  type CallerAppointment,
  type StoredAvailabilitySlot,
} from "../state/call-state.js";

export function bookedSlotAppointmentAnalytics(
  state: CallState,
  selectedSlot: StoredAvailabilitySlot,
  result: unknown,
): AppointmentAnalytics {
  const receipt = isRecord(result) ? result : {};
  return stripEmptyFields({
    appointmentId: stringField(receipt, "appointmentId"),
    patientName: activePatientName(state) ?? undefined,
    appointmentDate: selectedSlot.date,
    appointmentTime: selectedSlot.time,
    startDatetime:
      stringField(receipt, "startDatetime") ?? selectedSlot.datetime,
    providerName: stringField(receipt, "providerName") ?? selectedSlot.provider,
    locationName:
      stringField(receipt, "locationName") ??
      getOfficeConfig(activeOfficeKey(state)).displayName,
    appointmentTypeName: stringField(receipt, "appointmentTypeName"),
    careLane: careLaneForBookedSlot(state, selectedSlot),
  });
}

export function cancelledAppointmentAnalytics(
  state: CallState,
  appointment: CallerAppointment,
): AppointmentAnalytics {
  return stripEmptyFields({
    appointmentId: String(appointment.id),
    patientName: activePatientName(state) ?? undefined,
    appointmentDate: appointment.date,
    appointmentTime: appointment.time,
    providerName: appointment.provider,
    locationName: appointment.facility,
    appointmentTypeName: appointment.type,
    careLane: careLaneForAppointment(appointment),
  });
}

export function appointmentActionStatusForBookingResult(
  result: unknown,
): AppointmentActionStatus {
  if (!isRecord(result)) return "success";
  return stringField(result, "status")?.toLowerCase() === "partial"
    ? "partial"
    : "success";
}

function careLaneForBookedSlot(
  state: CallState,
  selectedSlot: StoredAvailabilitySlot,
): string | undefined {
  const visitType = currentWorkflowVisitType(state);
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

function stringField(
  record: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = record[field];
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
