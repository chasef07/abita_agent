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
const HANDOFF_ID_HEADER = "X-Acuity-Handoff-Id";
const HANDOFF_TOKEN_HEADER = "X-Acuity-Handoff-Token";

type HandoffTarget = {
  mode: "DIRECT" | "PHONE";
  sipHeaders?: Record<string, string>;
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
  sipHeaders?: Record<string, string>,
): Record<string, string> {
  if (sipHeaders) return sipHeaders;

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

  if (!url && !secret) return phoneHandoffTarget(handoffOfficeKey);

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

  const { expiresAt, handoffId, sipHeaders, sipUri } = value;
  if (
    !isSafeValue(handoffId) ||
    !isSipUri(sipUri) ||
    typeof expiresAt !== "string" ||
    !Number.isFinite(Date.parse(expiresAt)) ||
    Date.parse(expiresAt) <= Date.now() ||
    !isSipHeaders(sipHeaders) ||
    sipHeaders[HANDOFF_ID_HEADER] !== handoffId ||
    !isSafeValue(sipHeaders[HANDOFF_TOKEN_HEADER])
  ) {
    throw new Error("Acuity handoff API returned an invalid response.");
  }

  return { mode: "DIRECT", target: sipUri, sipHeaders };
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

function isSipHeaders(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) return false;
  const names = Object.keys(value);
  return (
    names.length === 2 &&
    names.every((name) =>
      [HANDOFF_ID_HEADER, HANDOFF_TOKEN_HEADER].includes(name),
    ) &&
    names.every((name) => isSafeValue(value[name]))
  );
}

export async function transferCallerToOffice(
  state: CallState,
): Promise<{ handoffOfficeKey: OfficeKey; handoffTarget: string }> {
  const handoffOfficeKey = getHandoffOfficeKey(state);
  const { mode, sipHeaders, target } = await resolveHandoffTarget(
    state,
    handoffOfficeKey,
  );
  // A rejected direct-transfer RPC is ambiguous: the REFER may already have
  // reached the provider. Prevent a second direct REFER before awaiting it.
  if (mode === "DIRECT") state.runtime.transferred = true;
  try {
    await getSipClient(mode).transferSipParticipant(
      state.runtime.sipRoomName,
      state.runtime.sipParticipantIdentity,
      target,
      {
        headers: buildCallCenterHandoffHeaders(
          state,
          target,
          handoffOfficeKey,
          sipHeaders,
        ),
        playDialtone: true,
        ringingTimeout: 20,
      },
    );
  } catch {
    throw new Error("SIP transfer failed.");
  }
  return { handoffOfficeKey, handoffTarget: target };
}
