import type {
  AppointmentLoadStatus,
  StoredCallerAppointment,
} from "../state/call-state.js";
import type {
  LightweightPatientCandidate,
  PatientCandidateSet,
} from "../identity/candidate.js";

export type PatientResolveCandidate = LightweightPatientCandidate;

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

export type CompletePatientResolveVerified = PatientResolveVerified & {
  name: string;
  dob: string;
};

export function patientResolveReceiptIsComplete(
  receipt: PatientResolveVerified,
): receipt is CompletePatientResolveVerified {
  return Boolean(
    receipt.patientId.trim() && receipt.name?.trim() && receipt.dob?.trim(),
  );
}

interface PatientResolveMultipleMatches {
  status: "multiple_matches";
  matches: Array<PatientResolveVerified | PatientResolveCandidate>;
}

interface PatientResolveNotFound {
  status: "not_found";
}

interface PatientResolveError {
  status: "error";
  reason: "invalid_response" | "middleware_error" | "request_rejected";
}

export type PatientResolveResult =
  | PatientCandidateSet
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
      reason: "invalid_response",
    };
  }

  const status = stringValue(raw.status)?.toLowerCase() ?? "";
  if (status === "error" || status === "failed" || status === "failure") {
    return {
      status: "error",
      reason: "middleware_error",
    };
  }

  if (status === "candidates") {
    if (
      raw.source !== "first_name" ||
      typeof raw.complete !== "boolean" ||
      !Array.isArray(raw.matches)
    ) {
      return { status: "error", reason: "invalid_response" };
    }
    const matches = raw.matches.map(normalizePatientCandidate);
    if (matches.some((match) => match === null))
      return { status: "error", reason: "invalid_response" };
    return {
      status: "candidates",
      source: "first_name",
      complete: raw.complete,
      matches: matches as PatientResolveCandidate[],
    };
  }

  if (status === "multiple_matches") {
    const matches = normalizePatientMatches(raw.matches, options);
    if (
      !Array.isArray(raw.matches) ||
      matches.length === 0 ||
      matches.length !== raw.matches.length
    ) {
      return { status: "error", reason: "invalid_response" };
    }
    return {
      status: "multiple_matches",
      matches,
    };
  }

  if (
    status === "not_found" ||
    status === "no_match" ||
    status === "no_appointments"
  ) {
    return {
      status: "not_found",
    };
  }

  if (status === "verified" || (!status && isNonEmptyString(raw.patientId))) {
    if (!isNonEmptyString(raw.patientId)) {
      return {
        status: "error",
        reason: "invalid_response",
      };
    }
    const appointments = normalizeStoredCallerAppointments(raw.appointments);
    if (!appointments) {
      return {
        status: "error",
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
      !isOptionalString(appointment.provider) ||
      !isOptionalString(appointment.type) ||
      !isOptionalString(appointment.facility) ||
      !isOptionalString(appointment.cancellationToken) ||
      !isOptionalString(appointment.rescheduleToken) ||
      (appointment.confirmed !== undefined &&
        typeof appointment.confirmed !== "boolean") ||
      (appointment.appointmentTypeId !== undefined &&
        (typeof appointment.appointmentTypeId !== "number" ||
          !Number.isFinite(appointment.appointmentTypeId)))
    ) {
      return null;
    }

    const cancellationToken = stringValue(
      appointment.cancellationToken,
    )?.trim();
    const rescheduleToken = stringValue(appointment.rescheduleToken)?.trim();
    appointments.push({
      id: appointment.id,
      date: appointment.date,
      time: appointment.time,
      provider: appointment.provider ?? "",
      type: appointment.type ?? "",
      ...(appointment.appointmentTypeId === undefined
        ? {}
        : { appointmentTypeId: appointment.appointmentTypeId }),
      facility: appointment.facility ?? "",
      confirmed: appointment.confirmed ?? false,
      ...(cancellationToken ? { cancellationToken } : {}),
      ...(rescheduleToken ? { rescheduleToken } : {}),
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

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

export function stringValue(value: unknown): string | null {
  return isNonEmptyString(value) ? value : null;
}

export function normalizePatientMatches(
  matches: unknown,
  options: { fallbackPhone?: string | null } = {},
): Array<PatientResolveVerified | PatientResolveCandidate> {
  if (!Array.isArray(matches)) return [];
  return matches.flatMap<PatientResolveVerified | PatientResolveCandidate>(
    (match) => {
      const candidate = normalizePatientCandidate(match);
      if (candidate) return [candidate];

      if (!isRecord(match) || match.status !== "verified") return [];
      const normalized = normalizePatientResolveResponse(match, options);
      return normalized.status === "verified" ? [normalized] : [];
    },
  );
}

function normalizePatientCandidate(
  value: unknown,
): PatientResolveCandidate | null {
  if (!isRecord(value) || value.status !== "candidate") return null;
  const allowedFields = new Set([
    "status",
    "patientId",
    "firstName",
    "lastName",
    "dob",
  ]);
  if (
    Object.keys(value).some((field) => !allowedFields.has(field)) ||
    !isNonEmptyString(value.patientId) ||
    !isNonEmptyString(value.firstName) ||
    !isNonEmptyString(value.lastName) ||
    !isNonEmptyString(value.dob)
  ) {
    return null;
  }

  return {
    status: "candidate",
    patientId: value.patientId,
    firstName: value.firstName,
    lastName: value.lastName,
    dob: value.dob,
  };
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
