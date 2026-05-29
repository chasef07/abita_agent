import { DEV_OFFICE_PHONE, type OfficeKey } from "../../customer/profile.js";
import {
  createInitialFlowState,
  recordAvailabilityCachedSlots,
  recordAvailabilitySearch,
  type CallerAppointment,
  type SchedulingRouting,
} from "../../flow/index.js";
import type { InsuranceCoverageType } from "../../insurance-rules.js";
import {
  activeAppointmentsStatus,
  activeInsuranceContext,
  activePatient,
  activePatientDob,
  activePatientId,
  activePatientName,
  activePatientRef,
  activeRoutingContext,
  availabilityBookingToken,
  availabilitySlotsForState,
  clearAvailabilityPrivateData,
  createCanonicalCallState,
  lastAvailabilitySlotsForState,
  patientBackendRefs,
  setAppointmentCancelTokens,
  setPatientBackendRefs,
  storeAvailabilitySlotPrivateData,
  type CallState,
  type InitialCallStateInput,
  type StoredAvailabilitySlot,
} from "../../tooling/call-state.js";

type LegacyAvailabilitySlot = StoredAvailabilitySlot & {
  bookingToken?: string | null;
};

type LegacyTestCallState = CallState & {
  flowHarnessEnabled?: boolean;
  flowGuardObservations: CallState["runtime"]["flowGuardObservations"];
  preCallLookup: CallState["runtime"]["preCallLookup"];
  latestUserTranscript?: string | null;
  turnUnderstandingAppliedForTranscript?: string | null;
  lastTurnUnderstanding?: CallState["runtime"]["lastTurnUnderstanding"];
  latestToolExposure?: CallState["runtime"]["latestToolExposure"];
  dynamicToolsEnabled?: boolean;
  officeKey: OfficeKey;
  amdOfficePhone: string;
  sipRoomName: string;
  sipParticipantIdentity: string;
  callId: string;
  callerPhone: string;
  trunkPhone: string;
  patientId: string | null;
  patientName: string | null;
  dob: string | null;
  insuranceCarrier: string | null;
  insPlanId: string | null;
  respPartyId: string | null;
  checkedInsurancePlan: string | null;
  checkedInsuranceCoverageType: InsuranceCoverageType | null;
  routing: SchedulingRouting | null;
  lastAvailabilityRouting: SchedulingRouting | string | null;
  lastAvailabilitySlots: LegacyAvailabilitySlot[];
  bookableAvailabilitySlots: LegacyAvailabilitySlot[];
  availabilitySlotSequence: number;
  allowedProviders: string[];
  routingAmbiguous: boolean;
  preauthRequired: boolean;
  appointmentsStatus: ReturnType<typeof activeAppointmentsStatus>;
  appointments: CallerAppointment[];
  appointmentCancelTokens: Record<string, string>;
  transferred: boolean;
  transferAttempted?: boolean;
  transferInFlight?: boolean;
};

export function createTestCallState(
  overrides: Partial<InitialCallStateInput> = {},
): CallState {
  const input: InitialCallStateInput = {
    flow: createInitialFlowState({
      officeKey: "dev",
      patientId: "patient-1",
      patientName: "Jane Doe",
      dob: "01/01/1980",
      callerPhone: "+17275551212",
      routing: "all_three",
      coverageType: "medical",
      appointmentsStatus: null,
    }),
    flowHarnessEnabled: true,
    flowGuardObservations: [],
    preCallLookup: {
      status: "verified",
      durationMs: 12,
    },
    latestUserTranscript: null,
    turnUnderstandingAppliedForTranscript: null,
    dynamicToolsEnabled: true,
    officeKey: "dev",
    amdOfficePhone: DEV_OFFICE_PHONE,
    sipRoomName: "room",
    sipParticipantIdentity: "caller",
    callId: "call-123",
    callerPhone: "+17275551212",
    trunkPhone: DEV_OFFICE_PHONE,
    patientId: "patient-1",
    patientName: "Jane Doe",
    dob: "01/01/1980",
    insuranceCarrier: "Aetna",
    insPlanId: "plan-1",
    respPartyId: "resp-1",
    checkedInsurancePlan: "Aetna",
    checkedInsuranceCoverageType: "medical",
    routing: "all_three",
    lastAvailabilityRouting: null,
    lastAvailabilitySlots: [],
    allowedProviders: [],
    routingAmbiguous: false,
    preauthRequired: false,
    appointmentsStatus: null,
    appointments: [],
    transferred: false,
    transferInFlight: false,
    ...overrides,
  };
  return installLegacyTestCallStateAliases(createCanonicalCallState(input));
}

export function installLegacyTestCallStateAliases(state: CallState): CallState {
  const target = state as LegacyTestCallState;
  const runtimeString = (
    key: keyof Pick<
      LegacyTestCallState,
      | "sipRoomName"
      | "sipParticipantIdentity"
      | "callId"
      | "callerPhone"
      | "trunkPhone"
    >,
  ) => ({
    get: () => state.runtime[key],
    set: (value: string) => {
      state.runtime[key] = value;
    },
  });

  Object.defineProperties(target, {
    flowHarnessEnabled: {
      get: () => state.runtime.flowHarnessEnabled,
      set: (value: boolean | undefined) => {
        state.runtime.flowHarnessEnabled = value;
      },
    },
    flowGuardObservations: {
      get: () => state.runtime.flowGuardObservations,
      set: (value: CallState["runtime"]["flowGuardObservations"]) => {
        state.runtime.flowGuardObservations = value;
      },
    },
    preCallLookup: {
      get: () => state.runtime.preCallLookup,
      set: (value: CallState["runtime"]["preCallLookup"]) => {
        state.runtime.preCallLookup = value;
      },
    },
    latestUserTranscript: {
      get: () => state.runtime.latestUserTranscript,
      set: (value: string | null | undefined) => {
        state.runtime.latestUserTranscript = value;
      },
    },
    turnUnderstandingAppliedForTranscript: {
      get: () => state.runtime.turnUnderstandingAppliedForTranscript,
      set: (value: string | null | undefined) => {
        state.runtime.turnUnderstandingAppliedForTranscript = value;
      },
    },
    lastTurnUnderstanding: {
      get: () => state.runtime.lastTurnUnderstanding,
      set: (value: CallState["runtime"]["lastTurnUnderstanding"]) => {
        state.runtime.lastTurnUnderstanding = value;
      },
    },
    latestToolExposure: {
      get: () => state.runtime.latestToolExposure,
      set: (value: CallState["runtime"]["latestToolExposure"]) => {
        state.runtime.latestToolExposure = value;
      },
    },
    dynamicToolsEnabled: {
      get: () => state.runtime.dynamicToolsEnabled,
      set: (value: boolean | undefined) => {
        state.runtime.dynamicToolsEnabled = value;
      },
    },
    officeKey: {
      get: () => state.flow.officeKey,
      set: (value: OfficeKey) => {
        state.flow.officeKey = value;
      },
    },
    amdOfficePhone: {
      get: () =>
        state.runtime.officePhoneOverrides?.[state.flow.officeKey] ??
        state.runtime.trunkPhone,
      set: (value: string) => {
        state.runtime.officePhoneOverrides = {
          ...(state.runtime.officePhoneOverrides ?? {}),
          [state.flow.officeKey]: value,
        };
      },
    },
    sipRoomName: runtimeString("sipRoomName"),
    sipParticipantIdentity: runtimeString("sipParticipantIdentity"),
    callId: runtimeString("callId"),
    callerPhone: runtimeString("callerPhone"),
    trunkPhone: runtimeString("trunkPhone"),
    transferred: {
      get: () => state.runtime.transferred,
      set: (value: boolean) => {
        state.runtime.transferred = value;
      },
    },
    transferAttempted: {
      get: () => state.runtime.transferAttempted,
      set: (value: boolean | undefined) => {
        state.runtime.transferAttempted = value;
      },
    },
    transferInFlight: {
      get: () => state.runtime.transferInFlight,
      set: (value: boolean | undefined) => {
        state.runtime.transferInFlight = value;
      },
    },
    patientId: {
      get: () => activePatientId(state),
      set: (value: string | null) => {
        const patient = ensureActivePatient(state);
        if (value) patient.patientId = value;
        else delete patient.patientId;
      },
    },
    patientName: {
      get: () => activePatientName(state),
      set: (value: string | null) => {
        setActivePatientName(state, value);
      },
    },
    dob: {
      get: () => activePatientDob(state),
      set: (value: string | null) => {
        const patient = ensureActivePatient(state);
        if (value) {
          patient.dob = slot(value);
        } else {
          delete patient.dob;
        }
      },
    },
    insuranceCarrier: {
      get: () => activeInsuranceContext(state).currentCarrier,
      set: (value: string | null) => {
        setActiveInsurance(state, { currentCarrier: value });
      },
    },
    checkedInsurancePlan: {
      get: () => activeInsuranceContext(state).canonicalPlan,
      set: (value: string | null) => {
        setActiveInsurance(state, { canonicalPlan: value });
      },
    },
    checkedInsuranceCoverageType: {
      get: () => activeInsuranceContext(state).coverageType,
      set: (value: InsuranceCoverageType | null) => {
        state.flow.coverageType = value;
        setActiveInsurance(state, { coverageType: value });
      },
    },
    insPlanId: {
      get: () => patientBackendRefs(state).insPlanId ?? null,
      set: (value: string | null) => {
        setPatientBackendRefs(state, activePatientRef(state), {
          insPlanId: value,
        });
      },
    },
    respPartyId: {
      get: () => patientBackendRefs(state).respPartyId ?? null,
      set: (value: string | null) => {
        setPatientBackendRefs(state, activePatientRef(state), {
          respPartyId: value,
        });
      },
    },
    routing: {
      get: () => activeRoutingContext(state).routing,
      set: (value: SchedulingRouting | null) => {
        state.flow.routing = value;
      },
    },
    allowedProviders: {
      get: () => activeRoutingContext(state).allowedProviders,
      set: (value: string[]) => {
        state.flow.allowedProviders = value;
      },
    },
    routingAmbiguous: {
      get: () => activeRoutingContext(state).routingAmbiguous,
      set: (value: boolean) => {
        state.flow.routingAmbiguous = value;
      },
    },
    preauthRequired: {
      get: () => activeRoutingContext(state).preauthRequired,
      set: (value: boolean) => {
        state.flow.preauthRequired = value;
      },
    },
    lastAvailabilityRouting: {
      get: () => {
        const search = [...state.flow.availabilitySearches]
          .reverse()
          .find((candidate) => candidate.status !== "invalidated");
        const latestSlots = lastAvailabilitySlotsForState(state);
        const selectedSlotWasCleared = search?.failureReasons.some((reason) =>
          [
            "caller_rejected",
            "slot_unavailable",
            "invalid_appointment_type",
          ].includes(reason),
        );
        if (latestSlots.length === 0 && selectedSlotWasCleared) {
          return null;
        }
        return search?.routing ?? null;
      },
      set: (value: SchedulingRouting | string | null) => {
        const search = [...state.flow.availabilitySearches]
          .reverse()
          .find((candidate) => candidate.status !== "invalidated");
        if (search) search.routing = value as SchedulingRouting | null;
        state.flow.routing = value as SchedulingRouting | null;
      },
    },
    lastAvailabilitySlots: {
      get: () => availabilitySlotsWithTokens(state),
      set: (value: LegacyAvailabilitySlot[]) => {
        replaceAvailabilitySlots(state, value);
      },
    },
    bookableAvailabilitySlots: {
      get: () => allAvailabilitySlotsWithTokens(state),
      set: (value: LegacyAvailabilitySlot[]) => {
        replaceAvailabilitySlots(state, value);
      },
    },
    availabilitySlotSequence: {
      get: () => state.private.availability.slotSequence,
      set: (value: number) => {
        state.private.availability.slotSequence = value;
      },
    },
    appointments: {
      get: () => ensureActivePatient(state).appointments,
      set: (value: CallerAppointment[]) => {
        ensureActivePatient(state).appointments = value;
      },
    },
    appointmentsStatus: {
      get: () => activeAppointmentsStatus(state),
      set: (value: ReturnType<typeof activeAppointmentsStatus>) => {
        ensureActivePatient(state).appointmentsStatus = value ?? undefined;
      },
    },
    appointmentCancelTokens: {
      get: () => appointmentCancelTokensForState(state),
      set: (value: Record<string, string>) => {
        state.private.appointments = {};
        setAppointmentCancelTokens(state, activePatientRef(state), value);
      },
    },
  });
  return state;
}

function availabilitySlotsWithTokens(
  state: CallState,
): LegacyAvailabilitySlot[] {
  return lastAvailabilitySlotsForState(state).map((slot) => {
    const bookingToken = availabilityBookingToken(state, slot.slotId);
    return {
      ...slot,
      ...(bookingToken ? { bookingToken } : {}),
    };
  });
}

function allAvailabilitySlotsWithTokens(
  state: CallState,
): LegacyAvailabilitySlot[] {
  return availabilitySlotsForState(state).map((slot) => {
    const bookingToken = availabilityBookingToken(state, slot.slotId);
    return {
      ...slot,
      ...(bookingToken ? { bookingToken } : {}),
    };
  });
}

function replaceAvailabilitySlots(
  state: CallState,
  slots: LegacyAvailabilitySlot[],
): void {
  clearAvailabilityPrivateData(state);
  state.flow.availabilitySearches = [];
  if (slots.length === 0) return;

  const routing = slots[0].routing ?? state.flow.routing ?? null;
  recordAvailabilitySearch(state.flow, {
    patientRef: activePatientRef(state),
    officeKey: state.flow.officeKey,
    visitType: state.flow.visitType,
    coverageType: state.flow.coverageType,
    routing,
    date: slots[0].date,
    requestedWindow: slots[0].date,
  });
  for (const slot of slots) {
    storeAvailabilitySlotPrivateData(
      state,
      slot.slotId,
      slot,
      slot.bookingToken ?? undefined,
    );
  }
  recordAvailabilityCachedSlots(state.flow, slots);
}

function appointmentCancelTokensForState(
  state: CallState,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(state.private.appointments)
      .filter(([, appointment]) => appointment.cancelToken)
      .map(([appointmentId, appointment]) => [
        appointmentId,
        appointment.cancelToken as string,
      ]),
  );
}

function ensureActivePatient(state: CallState) {
  const patient = activePatient(state);
  if (patient) return patient;

  const ref = activePatientRef(state);
  state.flow.patients[ref] = {
    ref,
    status: state.flow.patientStatus,
    verificationAttempts: 0,
    appointments: [],
    activeAppointmentTaskIds: [],
  };
  return state.flow.patients[ref];
}

function setActivePatientName(state: CallState, value: string | null): void {
  const patient = ensureActivePatient(state);
  if (!value) {
    delete patient.firstName;
    delete patient.lastName;
    return;
  }

  const [firstName, lastName] = splitPatientName(value);
  patient.firstName = slot(firstName);
  if (lastName) {
    patient.lastName = slot(lastName);
  } else {
    delete patient.lastName;
  }
}

function splitPatientName(name: string): [string, string | null] {
  const trimmed = name.trim();
  if (trimmed.includes(",")) {
    const [last, first] = trimmed.split(",", 2);
    return [(first ?? "").trim(), last.trim() || null];
  }
  const [first, ...rest] = trimmed.split(/\s+/);
  return [first ?? "", rest.join(" ") || null];
}

function setActiveInsurance(
  state: CallState,
  patch: {
    plan?: string | null;
    canonicalPlan?: string | null;
    currentCarrier?: string | null;
    coverageType?: InsuranceCoverageType | null;
  },
): void {
  const patient = ensureActivePatient(state);
  patient.insurance = {
    ...(patient.insurance ?? {}),
    ...(patch.plan !== undefined
      ? { plan: patch.plan ? slot(patch.plan) : undefined }
      : {}),
    ...(patch.canonicalPlan !== undefined
      ? { canonicalPlan: patch.canonicalPlan ?? undefined }
      : {}),
    ...(patch.currentCarrier !== undefined
      ? { currentCarrier: patch.currentCarrier ?? undefined }
      : {}),
    ...(patch.coverageType !== undefined
      ? { coverageType: patch.coverageType ?? undefined }
      : {}),
  };
}

function slot(value: string) {
  return {
    value,
    source: "tool_result" as const,
    confidence: "high" as const,
    confirmed: true,
  };
}
