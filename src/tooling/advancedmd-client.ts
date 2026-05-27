import { getOfficeConfigByPhone, type OfficeKey } from "../customer/profile.js";
import type {
  CallerLookupFailed,
  PhoneLookupResult,
  StoredCallerAppointment,
} from "./call-state.js";
import type { AppointmentLoadStatus } from "../flow/index.js";

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

export interface PatientResolveMultipleMatches {
  status: "multiple_matches";
  message: string;
  matches: Array<{ firstName: string }>;
}

export interface PatientResolveNotFound {
  status: "not_found";
  message: string;
}

export interface PatientResolveError {
  status: "error";
  message: string;
  reason?: CallerLookupFailed["reason"];
}

export type PatientResolveResult =
  | PatientResolveVerified
  | PatientResolveMultipleMatches
  | PatientResolveNotFound
  | PatientResolveError;

const DEFAULT_BASE_URL =
  "https://advancedmd-token-management-production.up.railway.app";
const BASE_URL = process.env.AMD_API_URL ?? DEFAULT_BASE_URL;
const AUTH_TOKEN = process.env.AMD_API_TOKEN ?? "";

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

export function getBaseUrlForOfficePhone(officePhone: string): string {
  return normalizeBaseUrl(
    getOfficeConfigByPhone(officePhone).middlewareBaseUrl ?? BASE_URL,
  );
}

export async function callApi(
  path: string,
  body: Record<string, unknown>,
  office: string,
  options: { includeOffice?: boolean } = {},
): Promise<unknown> {
  const payload =
    options.includeOffice === false ? { ...body } : { ...body, office };
  const res = await fetch(`${getBaseUrlForOfficePhone(office)}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: AUTH_TOKEN,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new ApiError(`API error ${res.status}: ${text}`, res.status);
  }
  return res.json();
}

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
  if (status === "verified" || isNonEmptyString(raw.patientId)) {
    if (!isNonEmptyString(raw.patientId)) {
      return {
        status: "error",
        message:
          "Patient lookup returned a verified response without a patient ID.",
        reason: "invalid_response",
      };
    }
    const appointments = Array.isArray(raw.appointments)
      ? (raw.appointments as StoredCallerAppointment[])
      : [];
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
        statusFromAppointments(raw.appointments),
      appointmentsMessage: stringValue(raw.appointmentsMessage),
      appointments,
      message: stringValue(raw.message),
    };
  }

  if (status === "multiple_matches") {
    return {
      status: "multiple_matches",
      message: stringValue(raw.message) ?? "Multiple patient matches found.",
      matches: normalizePatientMatches(raw.matches),
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

  if (status === "error" || status === "failed" || status === "failure") {
    return {
      status: "error",
      message: stringValue(raw.message) ?? "Patient lookup failed.",
      reason: "middleware_error",
    };
  }

  return {
    status: "error",
    message: "Patient lookup returned an invalid response.",
    reason: "invalid_response",
  };
}

export async function resolvePatientByOffice(
  officePhone: string,
  body: Record<string, unknown>,
  options: { fallbackPhone?: string | null } = {},
): Promise<PatientResolveResult> {
  try {
    const raw = await callApi("/api/patient/resolve", body, officePhone);
    return normalizePatientResolveResponse(raw, options);
  } catch (error) {
    return {
      status: "error",
      message: "Patient lookup failed.",
      reason: phoneLookupFailureReason(error),
    };
  }
}

/** Pre-call phone lookup — called from main.ts before session starts. */
export async function lookupByPhone(
  phone: string,
  trunkPhone: string,
): Promise<PhoneLookupResult> {
  const startedAt = Date.now();
  try {
    const office = getOfficeConfigByPhone(trunkPhone);
    const data = await resolvePatientByOffice(
      office.amdOfficePhone,
      { phone },
      { fallbackPhone: phone },
    );
    const lookupDurationMs = Date.now() - startedAt;
    if (data.status === "verified") {
      if (
        !isNonEmptyString(data.patientId) ||
        !isNonEmptyString(data.name) ||
        !isNonEmptyString(data.dob)
      ) {
        return {
          status: "lookup_failed",
          phone,
          reason: "invalid_response",
          retryable: true,
          lookupDurationMs,
        };
      }
      return {
        status: "verified",
        patientId: data.patientId,
        name: data.name,
        dob: data.dob,
        phone: data.phone ?? phone,
        insuranceCarrier: data.insuranceCarrier,
        insPlanId: data.insPlanId ?? null,
        respPartyId: data.respPartyId ?? null,
        routing: data.routing,
        allowedProviders: data.allowedProviders ?? [],
        routingAmbiguous: data.routingAmbiguous ?? false,
        appointmentsStatus: data.appointmentsStatus,
        appointmentsMessage: data.appointmentsMessage ?? null,
        appointments: data.appointments,
        lookupDurationMs,
      };
    }
    if (data.status === "multiple_matches") {
      return {
        status: "multiple_matches",
        message: data.message,
        matches: data.matches ?? [],
        lookupDurationMs,
      };
    }
    if (data.status === "not_found") {
      return {
        status: "no_match",
        phone,
        message: data.message,
        lookupDurationMs,
      };
    }
    return {
      status: "lookup_failed",
      phone,
      reason: data.reason ?? "middleware_error",
      retryable: true,
      lookupDurationMs,
    };
  } catch (error) {
    const reason = phoneLookupFailureReason(error);
    console.warn(
      `[precall] Phone lookup failed status=${reason} phone=${phone} trunk=${trunkPhone}`,
      error,
    );
    return {
      status: "lookup_failed",
      phone,
      reason,
      retryable: reason !== "unsupported_trunk",
      lookupDurationMs: Date.now() - startedAt,
    };
  }
}

function phoneLookupFailureReason(
  error: unknown,
): CallerLookupFailed["reason"] {
  if (error instanceof ApiError) return "middleware_error";
  if (error instanceof Error && error.message.includes("Unsupported trunk")) {
    return "unsupported_trunk";
  }
  if (error instanceof SyntaxError) return "invalid_response";
  if (error instanceof TypeError) return "network_error";
  return "network_error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function stringValue(value: unknown): string | null {
  return isNonEmptyString(value) ? value : null;
}

function normalizePatientMatches(
  matches: unknown,
): Array<{ firstName: string }> {
  if (!Array.isArray(matches)) return [];
  return matches.flatMap((match) =>
    isRecord(match) && isNonEmptyString(match.firstName)
      ? [{ firstName: match.firstName }]
      : [],
  );
}

function normalizeAppointmentsStatus(
  value: unknown,
): AppointmentLoadStatus | null {
  return value === "found" || value === "none" || value === "error"
    ? value
    : null;
}

function statusFromAppointments(
  appointments: unknown,
): AppointmentLoadStatus | null {
  if (!Array.isArray(appointments)) return null;
  return appointments.length > 0 ? "found" : "none";
}

export type { OfficeKey };
