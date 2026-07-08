import { SipClient } from "livekit-server-sdk";
import {
  getOfficeConfigByPhone,
  getOfficeHandoffTarget,
  type OfficeKey,
} from "../customers/profile.js";
import type { CallState } from "../state/call-state.js";
import { activeOfficeKey } from "../state/call-state.js";

let _sipClient: SipClient | undefined;

function getSipClient(): SipClient {
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
  } catch (err) {
    console.warn(
      `[tools] Could not resolve handoff office from original trunk ${state.runtime.trunkPhone}; falling back to active office ${activeOfficeKey(state)}`,
      err,
    );
    return activeOfficeKey(state);
  }
}

export async function transferCallerToOffice(
  state: CallState,
): Promise<{ handoffOfficeKey: OfficeKey; handoffTarget: string }> {
  const handoffOfficeKey = getHandoffOfficeKey(state);
  const handoffTarget = getOfficeHandoffTarget(handoffOfficeKey);
  await getSipClient().transferSipParticipant(
    state.runtime.sipRoomName,
    state.runtime.sipParticipantIdentity,
    handoffTarget,
    {
      headers: buildCallCenterHandoffHeaders(
        state,
        handoffTarget,
        handoffOfficeKey,
      ),
      playDialtone: true,
      ringingTimeout: 20,
    },
  );
  return { handoffOfficeKey, handoffTarget };
}
