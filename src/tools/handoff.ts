import { createHash } from "node:crypto";
import { SipClient } from "livekit-server-sdk";
import {
  getOfficeConfigByPhone,
  getOfficeHandoffTarget,
  type OfficeKey,
} from "../customers/profile.js";
import type { CallState } from "../state/call-state.js";
import { activeOfficeKey } from "../state/call-state.js";

const HANDOFF_TIMEOUT_MS = 2_000;
const HANDOFF_TOKEN_MARKER = "~ah1~";
const HANDOFF_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

type HandoffTarget = {
  mode: "DIRECT" | "PHONE";
  target: string;
};

class DirectHandoffConflictError extends Error {}

let _sipClient: SipClient | undefined;
let _singleReferSipClient: SipClient | undefined;

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
    return getOfficeConfigByPhone(state.runtime.trunkPhone).key;
  } catch {
    console.warn(
      "[tools] Could not resolve handoff office from original trunk; using the active office.",
    );
    return activeOfficeKey(state);
  }
}

function phoneHandoffTarget(handoffOfficeKey: OfficeKey): HandoffTarget {
  return { mode: "PHONE", target: getOfficeHandoffTarget(handoffOfficeKey) };
}

async function resolveHandoffTarget(
  state: CallState,
  handoffOfficeKey: OfficeKey,
): Promise<HandoffTarget> {
  const url = process.env.ACUITY_HANDOFF_URL?.trim();
  const secret = process.env.ACUITY_HANDOFF_SECRET?.trim();

  try {
    if (!url || !secret) {
      throw new Error("Acuity handoff API configuration is incomplete.");
    }
    return await requestDirectHandoff(state, url, secret);
  } catch (error) {
    if (
      error instanceof DirectHandoffConflictError ||
      !phoneFallbackEnabled()
    ) {
      throw error;
    }
    console.warn(
      "[tools] Acuity handoff resolution failed; using the configured phone fallback.",
    );
    return phoneHandoffTarget(handoffOfficeKey);
  }
}

function phoneFallbackEnabled(): boolean {
  return (
    process.env.ACUITY_HANDOFF_PHONE_FALLBACK_ENABLED?.trim().toLowerCase() ===
    "true"
  );
}

async function requestDirectHandoff(
  state: CallState,
  url: string,
  secret: string,
): Promise<HandoffTarget> {
  requireSecureHandoffUrl(url);

  const payload = {
    sourceCallId: state.runtime.callId,
    routePhoneNumber: state.runtime.trunkPhone,
    callerPhone: state.runtime.callerPhone,
  };
  const idempotencyKey = createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");

  let response: Response;
  try {
    response = await fetch(url, {
      body: JSON.stringify(payload),
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      method: "POST",
      signal: AbortSignal.timeout(HANDOFF_TIMEOUT_MS),
    });
  } catch {
    throw new Error("Acuity handoff API request failed.");
  }

  if (!response.ok) {
    if (response.status === 409) {
      throw new DirectHandoffConflictError(
        "Acuity handoff conflicts with an existing transfer.",
      );
    }
    throw new Error(`Acuity handoff API returned ${response.status}.`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("Acuity handoff API returned an invalid response.");
  }

  return parseDirectHandoff(body);
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

export async function transferCallerToOffice(
  state: CallState,
): Promise<{ handoffOfficeKey: OfficeKey; handoffTarget: string }> {
  const handoffOfficeKey = getHandoffOfficeKey(state);
  const { mode, target } = await resolveHandoffTarget(state, handoffOfficeKey);
  state.runtime.transferState = "pending";
  try {
    await getSipClient(mode).transferSipParticipant(
      state.runtime.sipRoomName,
      state.runtime.sipParticipantIdentity,
      target,
      {
        ...(mode === "PHONE"
          ? {
              headers: buildCallCenterHandoffHeaders(
                state,
                target,
                handoffOfficeKey,
              ),
            }
          : {}),
        playDialtone: true,
        ringingTimeout: 20,
      },
    );
  } catch {
    state.runtime.transferState = "ambiguous";
    throw new Error("SIP transfer outcome is unknown.");
  }
  state.runtime.transferState = "accepted";
  return { handoffOfficeKey, handoffTarget: target };
}
