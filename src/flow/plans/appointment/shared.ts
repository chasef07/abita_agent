import type { AppointmentCancelPlan, CallerAppointment } from "../../types.js";

type TargetSelectionStatus = AppointmentCancelPlan["targetSelectionStatus"];

export function mergeEvidence(
  existing: string[] | undefined,
  next: string[] | undefined,
): string[] {
  return [...new Set([...(existing ?? []), ...(next ?? [])])].filter(Boolean);
}

export function resolveTargetAppointment(
  appointments: CallerAppointment[],
  evidence: string[],
  existingAppointmentId?: number,
): {
  status: TargetSelectionStatus;
  appointment?: CallerAppointment;
} {
  const existing = appointments.find(
    (appointment) => appointment.id === existingAppointmentId,
  );
  if (existing) return { status: "selected", appointment: existing };
  if (appointments.length === 0) return { status: "none" };
  if (appointments.length === 1) {
    return { status: "selected", appointment: appointments[0] };
  }

  const matching = appointments.filter((appointment) =>
    appointmentMatchesEvidence(appointment, evidence),
  );
  if (matching.length === 1) {
    return { status: "selected", appointment: matching[0] };
  }
  return { status: "ambiguous" };
}

export function speakableAppointmentSummary(
  appointment: CallerAppointment,
): string {
  return [
    appointment.date,
    appointment.time,
    appointment.provider,
    appointment.facility,
  ]
    .filter(Boolean)
    .join(" ");
}

function appointmentMatchesEvidence(
  appointment: CallerAppointment,
  evidence: string[],
): boolean {
  if (evidence.length === 0) return false;
  const haystack = evidence.join(" ").toLowerCase();
  const provider = normalizeProvider(appointment.provider);
  const type = appointment.type.toLowerCase();
  const date = appointment.date.toLowerCase();
  const time = appointment.time.toLowerCase().replace(/\s+/g, "");
  return (
    Boolean(provider && haystack.includes(provider)) ||
    Boolean(type && haystack.includes(type)) ||
    Boolean(date && haystack.includes(date)) ||
    Boolean(time && haystack.replace(/\s+/g, "").includes(time))
  );
}

function normalizeProvider(provider: string): string {
  return provider
    .toLowerCase()
    .replace(/^dr\.\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}
