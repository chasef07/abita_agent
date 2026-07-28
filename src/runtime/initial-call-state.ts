import type { OfficeKey } from "../customers/abita/profile.js";
import { normalizeCallerAppointments } from "../state/appointments.js";
import {
  createCanonicalCallState,
  type CallState,
} from "../state/call-state.js";
import type { RuntimeVoiceLanguageState } from "../tts-config.js";
import {
  buildPreCallContextState,
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
  const verified = phoneLookup?.status === "verified" ? phoneLookup : null;
  const state = createCanonicalCallState({
    preCall: buildPreCallContextState(phoneLookup, call.callerPhone),
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
    patientId: verified?.patientId ?? null,
    patientName: verified?.name ?? null,
    dob: verified?.dob ?? null,
    insuranceCarrier: verified?.insuranceCarrier ?? null,
    insPlanId: verified?.insPlanId ?? null,
    respPartyId: verified?.respPartyId ?? null,
    checkedInsurancePlan: verified?.insuranceCarrier ?? null,
    checkedInsuranceCoverageType: null,
    routing: verified?.routing ?? null,
    allowedProviders: verified?.allowedProviders ?? [],
    routingAmbiguous: verified?.routingAmbiguous ?? false,
    preauthRequired: verified?.preauthRequired ?? false,
    appointmentsStatus: verified?.appointmentsStatus ?? null,
    appointments: normalizeCallerAppointments(
      verified?.appointments,
      verified?.patientId,
    ),
    voiceLanguage: call.voiceLanguage,
  });
  state.runtime.maxCallDurationMs = call.maxDurationMs;
  return state;
}

export function applyPreCallBootstrap(
  state: CallState,
  call: InitialCallInput,
  bootstrap: PreCallBootstrap,
): void {
  Object.assign(state, createInitialCallState(call, bootstrap));
}
