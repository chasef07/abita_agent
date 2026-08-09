import { createHash } from "node:crypto";
import { SipClient } from "livekit-server-sdk";
import {
  getHandoffOfficeKeyByPhone,
  getOfficeProfile,
  getOfficeProfileByPhone,
  type HandoffOfficeKey,
  type OfficeKey,
} from "../customers/abita/profile.js";
import { activePatientName, type CallState } from "../state/call-state.js";
import {
  activeOfficeKey,
  acceptTransfer,
  beginTransfer,
  markTransferAmbiguous,
} from "../state/call-lifecycle.js";
import { getProductTenantConfig } from "../runtime/portal-auth.js";

const HANDOFF_TIMEOUT_MS = 2_000;
const HANDOFF_TOKEN_MARKER = "~ah1~";
const HANDOFF_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_PRODUCT_HANDOFF_LIFETIME_MS = 5 * 60_000;

export class HandoffError extends Error {}
export class HandoffConflictError extends Error {}

type HandoffTarget = {
  headers?: Record<string, string>;
  mode: "DIRECT" | "PHONE";
  target: string;
};

type ProductHandoffConfig = {
  practiceId: string;
  secret: string;
  url: string;
};

type ProductHandoffPayload = {
  contact: {
    displayName?: string;
    nameSource?: string;
    phone: string;
    phoneSource: string;
  };
  idempotencyKey: string;
  officeKey: HandoffOfficeKey;
  practiceId: string;
  sourceCallId: string;
};

let _sipClient: SipClient | undefined;
let _singleReferSipClient: SipClient | undefined;
const _productHandoffPayloads = new WeakMap<CallState, ProductHandoffPayload>();

function getSipClient(mode: HandoffTarget["mode"]): SipClient {
  if (mode === "DIRECT") {
    _singleReferSipClient ??= new SipClient(
      process.env.LIVEKIT_URL!,
      process.env.LIVEKIT_API_KEY!,
      process.env.LIVEKIT_API_SECRET!,
      { failover: false },
    );
    return _singleReferSipClient;
  }

  _sipClient ??= new SipClient(
    process.env.LIVEKIT_URL!,
    process.env.LIVEKIT_API_KEY!,
    process.env.LIVEKIT_API_SECRET!,
  );
  return _sipClient;
}

function buildCallCenterHandoffHeaders(
  state: CallState,
  handoffTarget: string,
  handoffOfficeKey: OfficeKey = activeOfficeKey(state),
): Record<string, string> {
  return {
    "X-Acuity-Caller-Phone": state.runtime.callerPhone,
    "X-Acuity-Handoff": "call-center",
    "X-Acuity-Handoff-Target": handoffTarget,
    "X-Acuity-LiveKit-Call-Id": state.runtime.callId,
    "X-Acuity-Office-Key": handoffOfficeKey,
    "X-Acuity-Trunk-Phone": state.runtime.trunkPhone,
  };
}

function getHandoffOfficeKey(state: CallState): OfficeKey {
  if (!state.runtime.trunkPhone) return activeOfficeKey(state);
  try {
    return getOfficeProfileByPhone(state.runtime.trunkPhone).key;
  } catch {
    console.warn(
      "[tools] Could not resolve handoff office from original trunk; using the active office.",
    );
    return activeOfficeKey(state);
  }
}

function getHandoffRouteOfficeKey(
  state: CallState,
  fallback: OfficeKey,
): HandoffOfficeKey {
  if (!state.runtime.trunkPhone) return fallback;
  try {
    return getHandoffOfficeKeyByPhone(state.runtime.trunkPhone);
  } catch {
    return fallback;
  }
}

async function resolveHandoffTarget(
  state: CallState,
  profileOfficeKey: OfficeKey,
  handoffOfficeKey: HandoffOfficeKey,
): Promise<HandoffTarget> {
  const productConfig = productHandoffConfig(profileOfficeKey);
  if (productConfig) {
    return requestProductHandoff(state, handoffOfficeKey, productConfig);
  }

  const policy = getOfficeProfile(profileOfficeKey).handoff();
  if (policy.mode === "phone") {
    return { mode: "PHONE", target: policy.target };
  }

  const url = process.env.ACUITY_HANDOFF_URL?.trim();
  const secret = process.env.ACUITY_HANDOFF_SECRET?.trim();
  if (!url || !secret) {
    throw new Error("Acuity handoff API configuration is incomplete.");
  }
  return requestDirectHandoff(state, url, secret);
}

function productHandoffConfig(
  officeKey: OfficeKey,
): ProductHandoffConfig | null {
  const tenant = getProductTenantConfig(officeKey);
  const route = {
    practiceId: tenant.practiceId ?? "",
    url: process.env.ACUITY_PRODUCT_HANDOFF_URL?.trim() ?? "",
  };
  if (Object.values(route).every((value) => value === "")) return null;

  const config = {
    ...route,
    secret: tenant.secret ?? "",
  };
  if (!config.url || !config.secret || !isUuid(config.practiceId)) {
    throw new Error("Acuity Product handoff configuration is incomplete.");
  }
  return config;
}

async function requestDirectHandoff(
  state: CallState,
  url: string,
  secret: string,
): Promise<HandoffTarget> {
  const payload = {
    sourceCallId: state.runtime.callId,
    routePhoneNumber: state.runtime.trunkPhone,
    callerPhone: state.runtime.callerPhone,
  };
  const idempotencyKey = createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
  const body = await postHandoff({
    errorPrefix: "Acuity",
    headers: { "Idempotency-Key": idempotencyKey },
    payload,
    secret,
    url,
  });
  return parseDirectHandoff(body);
}

async function requestProductHandoff(
  state: CallState,
  officeKey: HandoffOfficeKey,
  config: ProductHandoffConfig,
): Promise<HandoffTarget> {
  const payload = productHandoffPayload(state, officeKey, config);
  const body = await postHandoff({
    errorPrefix: "Acuity Product",
    payload,
    secret: config.secret,
    url: config.url,
  });
  return parseProductHandoff(body);
}

function productHandoffPayload(
  state: CallState,
  officeKey: HandoffOfficeKey,
  config: ProductHandoffConfig,
): ProductHandoffPayload {
  const existing = _productHandoffPayloads.get(state);
  if (existing) return existing;

  const sourceCallId = state.runtime.callId.trim();
  if (!isSafeValue(sourceCallId) || sourceCallId === "unknown") {
    throw new Error("Acuity Product handoff requires a stable source call ID.");
  }
  const displayName = activePatientName(state);
  const identity = {
    practiceId: config.practiceId,
    officeKey,
    sourceCallId,
  };
  const payload = {
    ...identity,
    contact: {
      phone: state.runtime.callerPhone,
      phoneSource: "livekit.sip.callerPhoneNumber",
      ...(displayName
        ? {
            displayName,
            nameSource: "abita.patient-context",
          }
        : {}),
    },
    idempotencyKey: createHash("sha256")
      .update(JSON.stringify(identity))
      .digest("hex"),
  };
  _productHandoffPayloads.set(state, payload);
  return payload;
}

async function postHandoff(input: {
  errorPrefix: "Acuity" | "Acuity Product";
  headers?: Record<string, string>;
  payload: unknown;
  secret: string;
  url: string;
}): Promise<unknown> {
  requireSecureHandoffUrl(input.url);
  let response: Response;
  try {
    response = await fetch(input.url, {
      body: JSON.stringify(input.payload),
      headers: {
        Authorization: `Bearer ${input.secret}`,
        "Content-Type": "application/json",
        ...input.headers,
      },
      method: "POST",
      signal: AbortSignal.timeout(HANDOFF_TIMEOUT_MS),
    });
  } catch {
    throw new HandoffError(`${input.errorPrefix} handoff API request failed.`);
  }

  if (!response.ok) {
    if (response.status === 409) {
      throw new HandoffConflictError(
        `${input.errorPrefix} handoff conflicts with an existing transfer.`,
      );
    }
    const message = `${input.errorPrefix} handoff API returned ${response.status}.`;
    if (
      response.status === 408 ||
      response.status === 429 ||
      response.status >= 500
    ) {
      throw new HandoffError(message);
    }
    throw new Error(message);
  }

  try {
    return await response.json();
  } catch {
    throw new Error(
      `${input.errorPrefix} handoff API returned an invalid response.`,
    );
  }
}

function requireSecureHandoffUrl(value: string): void {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password) return;
  } catch {
    // Report one stable configuration error below.
  }
  throw new Error("Acuity handoff API URL must use HTTPS.");
}

function parseDirectHandoff(value: unknown): HandoffTarget {
  if (!isRecord(value) || value.type !== "DIRECT") {
    throw new Error("Acuity handoff API returned an invalid response.");
  }

  const { expiresAt, handoffId, sipUri } = value;
  if (
    !isSafeValue(handoffId) ||
    !isDirectSipUri(sipUri) ||
    typeof expiresAt !== "string" ||
    !Number.isFinite(Date.parse(expiresAt)) ||
    Date.parse(expiresAt) <= Date.now()
  ) {
    throw new Error("Acuity handoff API returned an invalid response.");
  }

  return { mode: "DIRECT", target: sipUri };
}

function parseProductHandoff(value: unknown): HandoffTarget {
  if (!isRecord(value)) {
    throw new Error("Acuity Product handoff API returned an invalid response.");
  }

  const { expiresAt, id, sipDestination } = value;
  const expiration =
    typeof expiresAt === "string" ? Date.parse(expiresAt) : NaN;
  const now = Date.now();
  if (
    !isUuid(id) ||
    !isProductSipUri(sipDestination) ||
    !Number.isFinite(expiration) ||
    expiration <= now ||
    expiration > now + MAX_PRODUCT_HANDOFF_LIFETIME_MS
  ) {
    throw new Error("Acuity Product handoff API returned an invalid response.");
  }

  return { mode: "DIRECT", target: sipDestination };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeValue(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    !/[\r\n]/.test(value)
  );
}

function isUuid(value: unknown): value is string {
  return (
    isSafeValue(value) &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

function isSipUri(value: unknown): value is string {
  if (!isSafeValue(value) || !/^sip:[^\s@]+@[^\s@]+$/i.test(value)) {
    return false;
  }
  return !value.slice(4, value.indexOf("@")).includes(":");
}

function isDirectSipUri(value: unknown): value is string {
  if (!isSipUri(value)) return false;
  const user = value.slice(4, value.indexOf("@"));
  const marker = user.lastIndexOf(HANDOFF_TOKEN_MARKER);
  return (
    marker > 0 &&
    marker === user.indexOf(HANDOFF_TOKEN_MARKER) &&
    HANDOFF_TOKEN_PATTERN.test(user.slice(marker + HANDOFF_TOKEN_MARKER.length))
  );
}

function isProductSipUri(value: unknown): value is string {
  if (!isSipUri(value)) return false;
  return value.slice(4, value.indexOf("@")) === "acuity-handoff";
}

export async function transferCallerToOffice(
  state: CallState,
): Promise<{ handoffOfficeKey: OfficeKey; handoffTarget: string }> {
  const profileOfficeKey = getHandoffOfficeKey(state);
  const handoffOfficeKey = getHandoffRouteOfficeKey(state, profileOfficeKey);
  const { headers, mode, target } = await resolveHandoffTarget(
    state,
    profileOfficeKey,
    handoffOfficeKey,
  );
  beginTransfer(state);
  try {
    await getSipClient(mode).transferSipParticipant(
      state.runtime.sipRoomName,
      state.runtime.sipParticipantIdentity,
      target,
      {
        ...(headers
          ? { headers }
          : mode === "PHONE"
            ? {
                headers: buildCallCenterHandoffHeaders(
                  state,
                  target,
                  profileOfficeKey,
                ),
              }
            : {}),
        playDialtone: true,
        ringingTimeout: 20,
      },
    );
  } catch {
    markTransferAmbiguous(state);
    throw new HandoffError("SIP transfer outcome is unknown.");
  }
  acceptTransfer(state);
  return { handoffOfficeKey: profileOfficeKey, handoffTarget: target };
}
