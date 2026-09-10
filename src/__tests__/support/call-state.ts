import {
  createCanonicalCallState,
  type ActivePatient,
  type InitialCallStateInput,
} from "../../state/call-state.js";

const DEFAULT_CALL_STATE_INPUT: InitialCallStateInput = {
  preCallLookup: { status: "not_attempted" },
  officeKey: "spring-hill",
  sipRoomName: "test-room",
  sipParticipantIdentity: "sip-caller",
  callId: "call-test",
  callerPhone: "+17275551212",
  trunkPhone: "+17275919997",
  insuranceCarrier: null,
  checkedInsurancePlan: null,
  checkedInsuranceCoverageType: null,
  routing: null,
  allowedProviders: [],
  routingAmbiguous: false,
  preauthRequired: false,
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
    insuranceCarrier: "self pay",
    checkedInsurancePlan: "self pay",
    checkedInsuranceCoverageType: "medical",
    routing: "all_three",
    ...overrides,
    activePatient: overrides.activePatient ?? confirmedActivePatient(),
  });
  return state;
}

export function confirmedActivePatient(
  overrides: Partial<ActivePatient> = {},
): ActivePatient {
  return {
    kind: "existing",
    patientId: "patient-1",
    name: "Jane Doe",
    dob: "01/01/1980",
    phone: "+17275551212",
    appointments: [],
    appointmentsStatus: null,
    backend: {},
    ...overrides,
  };
}
