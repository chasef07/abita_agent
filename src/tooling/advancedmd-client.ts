import { getOfficeConfigByPhone, type OfficeKey } from "../customer/profile.js";
import type {
  CallerLookupFailed,
  PhoneLookupResult,
  StoredCallerAppointment,
} from "./call-state.js";

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

/** Pre-call phone lookup — called from main.ts before session starts. */
export async function lookupByPhone(
  phone: string,
  trunkPhone: string,
): Promise<PhoneLookupResult> {
  const startedAt = Date.now();
  try {
    const office = getOfficeConfigByPhone(trunkPhone);
    const data = (await callApi(
      "/api/patient-lookup",
      { phone },
      office.amdOfficePhone,
    )) as {
      status?: string;
      patientId?: string;
      name?: string;
      dob?: string;
      phone?: string;
      insuranceCarrier?: string;
      insPlanId?: string | null;
      respPartyId?: string | null;
      routing?: string;
      allowedProviders?: string[];
      routingAmbiguous?: boolean;
      appointments?: StoredCallerAppointment[] | null;
      message?: string;
      matches?: Array<{ firstName: string }>;
    } & Record<string, unknown>;
    const lookupDurationMs = Date.now() - startedAt;
    if (data.status === "verified") {
      if (
        !isNonEmptyString(data.patientId) ||
        !isNonEmptyString(data.name) ||
        !isNonEmptyString(data.dob) ||
        !isNonEmptyString(data.phone) ||
        !isNonEmptyString(data.routing)
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
        phone: data.phone,
        insuranceCarrier: isNonEmptyString(data.insuranceCarrier)
          ? data.insuranceCarrier
          : null,
        insPlanId: data.insPlanId ?? null,
        respPartyId: data.respPartyId ?? null,
        routing: data.routing,
        allowedProviders: data.allowedProviders ?? [],
        routingAmbiguous: data.routingAmbiguous ?? false,
        appointments: data.appointments ?? null,
        lookupDurationMs,
      };
    }
    if (data.status === "multiple_matches") {
      return {
        status: "multiple_matches",
        message: data.message as string,
        matches: data.matches ?? [],
        lookupDurationMs,
      };
    }
    if (data.status === "not_found" || data.status === "no_match") {
      return {
        status: "no_match",
        phone,
        message:
          typeof data.message === "string" ? data.message : "No patient match",
        lookupDurationMs,
      };
    }
    if (
      data.status === "error" ||
      data.status === "failed" ||
      data.status === "failure"
    ) {
      return {
        status: "lookup_failed",
        phone,
        reason: "middleware_error",
        retryable: true,
        lookupDurationMs,
      };
    }
    return {
      status: "lookup_failed",
      phone,
      reason: "invalid_response",
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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export type { OfficeKey };
