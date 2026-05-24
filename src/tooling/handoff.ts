import { SipClient } from "livekit-server-sdk";
import {
  getOfficeConfigByPhone,
  getOfficeHandoffTarget,
  type OfficeKey,
} from "../customer/profile.js";
import type { CallState } from "./call-state.js";

let _sipClient: SipClient | undefined;

function getSipClient(): SipClient {
  _sipClient ??= new SipClient(
    process.env.LIVEKIT_URL!,
    process.env.LIVEKIT_API_KEY!,
    process.env.LIVEKIT_API_SECRET!,
  );
  return _sipClient;
}

export function buildCallCenterHandoffHeaders(
  state: Pick<CallState, "callId" | "callerPhone" | "officeKey" | "trunkPhone">,
  handoffTarget: string,
  handoffOfficeKey: OfficeKey = state.officeKey,
): Record<string, string> {
  return {
    "X-Acuity-Caller-Phone": state.callerPhone,
    "X-Acuity-Handoff": "call-center",
    "X-Acuity-Handoff-Target": handoffTarget,
    "X-Acuity-LiveKit-Call-Id": state.callId,
    "X-Acuity-Office-Key": handoffOfficeKey,
    "X-Acuity-Trunk-Phone": state.trunkPhone,
  };
}

function getHandoffOfficeKey(
  state: Pick<CallState, "officeKey" | "trunkPhone">,
): OfficeKey {
  if (!state.trunkPhone) return state.officeKey;
  try {
    return getOfficeConfigByPhone(state.trunkPhone).key;
  } catch (err) {
    console.warn(
      `[tools] Could not resolve handoff office from original trunk ${state.trunkPhone}; falling back to active office ${state.officeKey}`,
      err,
    );
    return state.officeKey;
  }
}

export async function transferCallerToOffice(
  state: CallState,
): Promise<{ handoffOfficeKey: OfficeKey; handoffTarget: string }> {
  const handoffOfficeKey = getHandoffOfficeKey(state);
  const handoffTarget = getOfficeHandoffTarget(handoffOfficeKey);
  await getSipClient().transferSipParticipant(
    state.sipRoomName,
    state.sipParticipantIdentity,
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
