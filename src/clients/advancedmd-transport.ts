import { getOfficeConfigByPhone } from "../customers/profile.js";

const DEFAULT_BASE_URL =
  "https://advancedmd-token-management-production.up.railway.app";
const BASE_URL = process.env.AMD_API_URL ?? DEFAULT_BASE_URL;
const AUTH_TOKEN = process.env.AMD_API_TOKEN ?? "";

export class ApiError extends Error {
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
  options: { includeOffice?: boolean; signal?: AbortSignal } = {},
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
    signal: requestSignal(options.signal),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new ApiError(`API error ${res.status}: ${text}`, res.status);
  }
  return res.json();
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(10_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
