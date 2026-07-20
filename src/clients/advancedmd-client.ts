import { getOfficeProfileByPhone } from "../customers/abita/profile.js";
import type {
  CallerLookupFailed,
  PhoneLookupResult,
} from "../state/call-state.js";
import {
  ApiError,
  callApi,
  getBaseUrlForOfficePhone,
} from "./advancedmd-transport.js";
import {
  isNonEmptyString,
  normalizePatientResolveResponse,
  patientResolveMatchToCallerMatch,
  type PatientResolveResult,
  type PatientResolveVerified,
} from "./advancedmd-normalize.js";

export { callApi, getBaseUrlForOfficePhone };
export type { PatientResolveResult, PatientResolveVerified };

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
    const office = getOfficeProfileByPhone(trunkPhone);
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
        preauthRequired: data.preauthRequired ?? false,
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
        matches: data.matches.map((match) =>
          patientResolveMatchToCallerMatch(match, phone, lookupDurationMs),
        ),
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
