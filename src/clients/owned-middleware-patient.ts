import type {
  AppointmentLoadStatus,
  CallerMatchHint,
  StoredCallerAppointment,
} from "../state/call-state.js";

export interface PatientResolveVerified {
  status: "verified";
  patientId: string;
  name: string | null;
  dob: string | null;
  phone: string | null;
  insuranceCarrier: string | null;
  insPlanId: string | null;
  respPartyId: string | null;
  routing: string | null;
  allowedProviders: string[];
  routingAmbiguous: boolean;
  preauthRequired: boolean;
  appointmentsStatus: AppointmentLoadStatus | null;
  appointmentsMessage: string | null;
  appointments: StoredCallerAppointment[];
  message: string | null;
}

interface PatientResolveMultipleMatches {
  status: "multiple_matches";
  message: string;
  matches: Array<PatientResolveVerified | CallerMatchHint>;
}

interface PatientResolveNotFound {
  status: "not_found";
  message: string;
}

interface PatientResolveError {
  status: "error";
  message: string;
  reason: "middleware_error" | "invalid_response";
}

export type PatientResolveResult =
  | PatientResolveVerified
  | PatientResolveMultipleMatches
  | PatientResolveNotFound
  | PatientResolveError;

export function normalizePatientResolveResponse(
  raw: unknown,
  options: { fallbackPhone?: string | null } = {},
): PatientResolveResult {
  if (!isRecord(raw)) {
    return {
      status: "error",
      message: "Patient lookup returned an invalid response.",
      reason: "invalid_response",
    };
  }

  const status = stringValue(raw.status)?.toLowerCase() ?? "";
  if (status === "error" || status === "failed" || status === "failure") {
    return {
      status: "error",
      message: "Patient lookup failed.",
      reason: "middleware_error",
    };
  }

  if (status === "multiple_matches") {
    return {
      status: "multiple_matches",
      message: stringValue(raw.message) ?? "Multiple patient matches found.",
      matches: normalizePatientMatches(raw.matches, options),
    };
  }

  if (
    status === "not_found" ||
    status === "no_match" ||
    status === "no_appointments"
  ) {
    return {
      status: "not_found",
      message: stringValue(raw.message) ?? "No patient match found.",
    };
  }

  if (status === "verified" || (!status && isNonEmptyString(raw.patientId))) {
    if (!isNonEmptyString(raw.patientId)) {
      return {
        status: "error",
        message:
          "Patient lookup returned a verified response without a patient ID.",
        reason: "invalid_response",
      };
    }
    const appointments = normalizeStoredCallerAppointments(raw.appointments);
    if (!appointments) {
      return {
        status: "error",
        message: "Patient lookup returned an invalid response.",
        reason: "invalid_response",
      };
    }
    return {
      status: "verified",
      patientId: raw.patientId,
      name: stringValue(raw.name),
      dob: stringValue(raw.dob),
      phone: stringValue(raw.phone) ?? options.fallbackPhone ?? null,
      insuranceCarrier: stringValue(raw.insuranceCarrier),
      insPlanId: stringValue(raw.insPlanId),
      respPartyId: stringValue(raw.respPartyId),
      routing: stringValue(raw.routing),
      allowedProviders: Array.isArray(raw.allowedProviders)
        ? raw.allowedProviders.filter(
            (provider): provider is string => typeof provider === "string",
          )
        : [],
      routingAmbiguous: raw.routingAmbiguous === true,
      preauthRequired: raw.preauthRequired === true,
      appointmentsStatus:
        normalizeAppointmentsStatus(raw.appointmentsStatus) ??
        statusFromAppointments(appointments),
      appointmentsMessage: stringValue(raw.appointmentsMessage),
      appointments,
      message: stringValue(raw.message),
    };
  }

  return {
    status: "error",
    message: "Patient lookup returned an invalid response.",
    reason: "invalid_response",
  };
}

function normalizeStoredCallerAppointments(
  value: unknown,
): StoredCallerAppointment[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;

  const appointments: StoredCallerAppointment[] = [];
  for (const appointment of value) {
    if (
      !isRecord(appointment) ||
      typeof appointment.id !== "number" ||
      !Number.isFinite(appointment.id) ||
      !isNonEmptyString(appointment.date) ||
      !isNonEmptyString(appointment.time) ||
      !isNonEmptyString(appointment.provider) ||
      !isNonEmptyString(appointment.type) ||
      !isNonEmptyString(appointment.facility) ||
      typeof appointment.confirmed !== "boolean" ||
      (appointment.appointmentTypeId !== undefined &&
        (typeof appointment.appointmentTypeId !== "number" ||
          !Number.isFinite(appointment.appointmentTypeId)))
    ) {
      return null;
    }

    appointments.push({
      id: appointment.id,
      date: appointment.date,
      time: appointment.time,
      provider: appointment.provider,
      type: appointment.type,
      ...(appointment.appointmentTypeId === undefined
        ? {}
        : { appointmentTypeId: appointment.appointmentTypeId }),
      facility: appointment.facility,
      confirmed: appointment.confirmed,
    });
  }
  return appointments;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function stringValue(value: unknown): string | null {
  return isNonEmptyString(value) ? value : null;
}

export function normalizePatientMatches(
  matches: unknown,
  options: { fallbackPhone?: string | null } = {},
): Array<PatientResolveVerified | CallerMatchHint> {
  if (!Array.isArray(matches)) return [];
  return matches.flatMap<PatientResolveVerified | CallerMatchHint>((match) => {
    const normalized = normalizePatientResolveResponse(match, options);
    if (normalized.status === "verified") return [normalized];
    if (isRecord(match) && isNonEmptyString(match.firstName)) {
      const hint: CallerMatchHint = { firstName: match.firstName };
      return [hint];
    }
    return [];
  });
}

export function normalizeAppointmentsStatus(
  value: unknown,
): AppointmentLoadStatus | null {
  return value === "found" || value === "none" || value === "error"
    ? value
    : null;
}

export function statusFromAppointments(
  appointments: unknown,
): AppointmentLoadStatus | null {
  if (!Array.isArray(appointments)) return null;
  return appointments.length > 0 ? "found" : "none";
}
