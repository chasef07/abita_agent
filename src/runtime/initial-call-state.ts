import type { OfficeKey } from "../customers/abita/profile.js";
import {
  createCanonicalCallState,
  type CallState,
} from "../state/call-state.js";
import type { RuntimeVoiceLanguageState } from "./voice-language.js";
import {
  buildPreCallCandidates,
  type PreCallBootstrap,
} from "./precall-bootstrap.js";

export interface InitialCallInput {
  callId: string;
  callerPhone: string;
  officeKey: OfficeKey;
  roomName: string;
  sipParticipantIdentity: string;
  trunkPhone: string;
  voiceLanguage: RuntimeVoiceLanguageState;
}

export function createInitialCallState(call: InitialCallInput): CallState {
  return createCanonicalCallState({
    preCallLookup: { status: "not_attempted" },
    officeKey: call.officeKey,
    sipRoomName: call.roomName,
    sipParticipantIdentity: call.sipParticipantIdentity,
    callId: call.callId,
    callerPhone: call.callerPhone,
    trunkPhone: call.trunkPhone,
    insuranceCarrier: null,
    checkedInsurancePlan: null,
    checkedInsuranceCoverageType: null,
    routing: null,
    allowedProviders: [],
    routingAmbiguous: false,
    preauthRequired: false,
    voiceLanguage: call.voiceLanguage,
  });
}

export function applyPreCallBootstrap(
  state: CallState,
  bootstrap: PreCallBootstrap,
): void {
  state.identity.privateCandidates = buildPreCallCandidates(
    bootstrap.phoneLookup,
  );
  state.runtime.preCallLookup.status =
    bootstrap.phoneLookup?.status ?? "not_attempted";
}
