import {
  createCanonicalCallState,
  type InitialCallStateInput,
} from "../../state/call-state.js";

const DEFAULT_CALL_STATE_INPUT: InitialCallStateInput = {
  preCallLookup: { status: "not_attempted", durationMs: null },
  officeKey: "spring-hill",
  amdOfficePhone: "+17275919997",
  sipRoomName: "test-room",
  sipParticipantIdentity: "sip-caller",
  callId: "call-test",
  callerPhone: "+17275551212",
  trunkPhone: "+17275919997",
  patientId: null,
  patientName: null,
  dob: null,
  insuranceCarrier: null,
  insPlanId: null,
  respPartyId: null,
  checkedInsurancePlan: null,
  checkedInsuranceCoverageType: null,
  routing: null,
  allowedProviders: [],
  routingAmbiguous: false,
  preauthRequired: false,
  appointmentsStatus: null,
  appointments: [],
  voiceLanguage: null,
};

export function createTestCallState(
  overrides: Partial<InitialCallStateInput> = {},
) {
  return createCanonicalCallState({
    ...DEFAULT_CALL_STATE_INPUT,
    ...overrides,
  });
}

export function createConfirmedPatientState(
  overrides: Partial<InitialCallStateInput> = {},
) {
  const state = createTestCallState({
    patientId: "patient-1",
    patientName: "Jane Doe",
    dob: "01/01/1980",
    insuranceCarrier: "self pay",
    checkedInsurancePlan: "self pay",
    checkedInsuranceCoverageType: "medical",
    routing: "all_three",
    ...overrides,
  });
  state.identity.patient.identityConfirmed = true;
  return state;
}
