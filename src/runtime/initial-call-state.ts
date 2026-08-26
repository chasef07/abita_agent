import type { OfficeKey } from "../customers/abita/profile.js";
import {
  createCanonicalCallState,
  type CallState,
} from "../state/call-state.js";
import type { RuntimeVoiceLanguageState } from "./voice-language.js";
import {
  buildPreCallCandidates,
  preCallLookupTelemetry,
  type PreCallBootstrap,
} from "./precall-bootstrap.js";

export interface InitialCallInput {
  amdOfficePhone: string;
  callId: string;
  callerPhone: string;
  maxDurationMs: number;
  officeKey: OfficeKey;
  roomName: string;
  sipParticipantIdentity: string;
  trunkPhone: string;
  voiceLanguage: RuntimeVoiceLanguageState;
}

export function createInitialCallState(
  call: InitialCallInput,
  bootstrap?: PreCallBootstrap,
): CallState {
  const phoneLookup = bootstrap?.phoneLookup ?? null;
  const state = createCanonicalCallState({
    preCallCandidates: buildPreCallCandidates(phoneLookup),
    preCallLookup: bootstrap
      ? preCallLookupTelemetry(phoneLookup)
      : {
          status: "not_attempted",
          durationMs: null,
        },
    officeKey: call.officeKey,
    amdOfficePhone: call.amdOfficePhone,
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
  return state;
}

export function applyPreCallBootstrap(
  state: CallState,
  call: InitialCallInput,
  bootstrap: PreCallBootstrap,
): void {
  Object.assign(state, createInitialCallState(call, bootstrap));
}
