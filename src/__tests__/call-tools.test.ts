import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  InMemoryOwnedMiddleware,
  setOwnedMiddleware,
  type CreatePatientResult,
  type InMemoryOwnedMiddlewareResponses,
  type PatientResolveResult,
  type UpdateInsuranceResult,
} from "../clients/owned-middleware.js";
import {
  CALLER_CANDIDATE_REF,
  type PreCallContextState,
} from "../state/call-state.js";
import { storeAvailabilityBookingToken } from "../scheduling/state.js";
import { ownedMiddlewareFailures } from "../state/observability.js";
import {
  add_patient,
  cancel_appointment,
  check_insurance,
  resolve_patient,
  update_insurance,
} from "../tools/index.js";
import { createTestCallState } from "./support/call-state.js";

type TestCallState = ReturnType<typeof createTestCallState>;
type PreCallCandidate = PreCallContextState["candidates"][number];
let testMiddleware: InMemoryOwnedMiddleware;

function createState(): TestCallState {
  const state = createTestCallState({
    patientId: "patient-1",
    patientName: "Jane Doe",
    dob: "01/01/1980",
    insuranceCarrier: "self pay",
    checkedInsurancePlan: "self pay",
    checkedInsuranceCoverageType: "medical",
    routing: "all_three",
    lastAvailabilityRouting: "all_three",
  });
  state.identity.patient.identityConfirmed = true;
  state.availability.slots = [
    {
      slotId: "A",
      spoken: "2026-06-01 9:00 AM with Doctor Smith",
      provider: "Doctor Smith",
      date: "2026-06-01",
      time: "9:00 AM",
      datetime: "2026-06-01T09:00:00",
      routing: "all_three",
    },
  ];
  return state;
}

function createToolContext(state: TestCallState) {
  const spokenHandle = {
    waitForPlayout: vi.fn(async () => undefined),
    interrupt: vi.fn(),
    done: vi.fn(() => false),
    interrupted: false,
  };
  const filler = vi.fn(
    async (
      _source: unknown,
      optionsOrFn: unknown,
      maybeFn?: () => Promise<unknown> | unknown,
    ) => {
      const fn = typeof optionsOrFn === "function" ? optionsOrFn : maybeFn;
      if (!fn) throw new Error("Missing filler callback");
      return fn();
    },
  );
  const speechHandle = { allowInterruptions: true };
  return {
    session: {
      userData: state,
      say: vi.fn(() => spokenHandle),
      generateReply: vi.fn(() => spokenHandle),
    },
    speechHandle,
    disallowInterruptions: vi.fn(() => {
      speechHandle.allowInterruptions = false;
    }),
    waitForPlayout: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
    filler,
    spokenHandle,
  };
}

function markSchedulingTriaged(
  state: TestCallState,
  appointmentLane: "medical_md" | "routine_od" = "medical_md",
) {
  state.workflow.current = {
    intent: "schedule",
    appointmentLane,
  };
}

function markNewPatientPathConfirmed(state: TestCallState) {
  state.identity.patient = {
    ...state.identity.patient,
    status: "new",
    identityConfirmed: false,
    patientId: null,
    name: null,
    dob: null,
    appointments: [],
    appointmentsStatus: null,
  };
}

function clearSchedulingContext(state: TestCallState) {
  state.workflow.current = undefined;
  state.workflow.routing.routing = null;
  state.availability.latestRouting = null;
  state.insurance.onFile = null;
  state.insurance.lastEligibilityCheck = null;
}

function markAcceptedInsurance(
  state: TestCallState,
  input: {
    plan: string;
    canonicalPlan: string;
    coverageType: "medical" | "routine_vision";
    currentCarrier?: string;
  } = {
    plan: "self pay",
    canonicalPlan: "self pay",
    coverageType: "medical",
  },
) {
  state.insurance.lastEligibilityCheck = {
    ...input,
    currentCarrier: input.currentCarrier ?? input.canonicalPlan,
    accepted: true,
  };
}

function setPatientUnknown(state: TestCallState) {
  state.identity.patient = {
    ...state.identity.patient,
    status: "unknown",
    identityConfirmed: false,
    patientId: null,
    name: null,
    dob: null,
    phone: null,
    appointments: [],
    appointmentsStatus: null,
  };
}

function preCallCandidate(
  overrides: Partial<PreCallCandidate> = {},
): PreCallCandidate {
  return {
    ref: CALLER_CANDIDATE_REF,
    firstName: "ESA",
    lastName: "ARSHED",
    dob: "10/03/2020",
    patientId: "patient-esa",
    relationshipToCaller: "self",
    appointments: [],
    appointmentsStatus: "none",
    insuranceCarrier: "Florida Blue Shield",
    routing: "bach_only",
    allowedProviders: ["Dr. Bach"],
    routingAmbiguous: false,
    preauthRequired: false,
    ...overrides,
  };
}

function setSingleArshedPreCallCandidate(state: TestCallState) {
  setPatientUnknown(state);
  state.identity.preCall = {
    status: "single_match_pending_confirmation",
    source: "phone_lookup",
    callerPhone: "+17275551212",
    candidates: [preCallCandidate()],
    selectedCandidateRef: CALLER_CANDIDATE_REF,
    identityPromotion: "none",
  };
}

function setMultiplePreCallCandidates(
  state: TestCallState,
  candidates: PreCallCandidate[],
  options: {
    status?: PreCallContextState["status"];
    callerPhone?: string;
    selectedCandidateRef?: string;
    identityPromotion?: string;
  } = {},
) {
  state.identity.preCall = {
    status: options.status ?? "multiple_matches_pending_selection",
    source: "phone_lookup",
    callerPhone: options.callerPhone ?? "+19546097250",
    candidates,
    ...(options.selectedCandidateRef
      ? { selectedCandidateRef: options.selectedCandidateRef }
      : {}),
    identityPromotion: options.identityPromotion ?? "none",
  };
}

function useMiddleware(
  responses: InMemoryOwnedMiddlewareResponses,
): InMemoryOwnedMiddleware {
  const middleware = new InMemoryOwnedMiddleware(responses);
  testMiddleware = middleware;
  setOwnedMiddleware(middleware);
  return middleware;
}

function stubPatient(
  ...responses: PatientResolveResult[]
): InMemoryOwnedMiddleware {
  return useMiddleware({ resolvePatient: responses });
}

function verifiedPatientResult(
  overrides: Partial<
    Extract<PatientResolveResult, { status: "verified" }>
  > = {},
): Extract<PatientResolveResult, { status: "verified" }> {
  return {
    status: "verified",
    patientId: "patient-1",
    name: "Jane Doe",
    dob: "01/01/1980",
    phone: "+17275551212",
    insuranceCarrier: "self pay",
    insPlanId: null,
    respPartyId: null,
    routing: "all_three",
    allowedProviders: [],
    routingAmbiguous: false,
    preauthRequired: false,
    appointmentsStatus: "none",
    appointmentsMessage: null,
    appointments: [],
    message: null,
    ...overrides,
  };
}

function stubCreatePatient(
  ...responses: CreatePatientResult[]
): InMemoryOwnedMiddleware {
  return useMiddleware({ createPatient: responses });
}

function stubInsuranceUpdate(
  ...responses: UpdateInsuranceResult[]
): InMemoryOwnedMiddleware {
  return useMiddleware({ updateInsurance: responses });
}

function updatedInsuranceResult(
  overrides: Partial<
    Extract<UpdateInsuranceResult, { status: "updated" }>
  > = {},
): UpdateInsuranceResult {
  return {
    status: "updated",
    newInsurance: "Aetna",
    routing: "all_three",
    allowedProviders: [],
    routingAmbiguous: false,
    preauthRequired: false,
    ...overrides,
  };
}

function createdPatientResult(
  overrides: Partial<Extract<CreatePatientResult, { status: "created" }>> = {},
): CreatePatientResult {
  return {
    status: "created",
    patientId: "patient-new",
    name: "Jane Doe",
    dob: "01/01/1980",
    phone: "+17275551212",
    insuranceCarrier: "self pay",
    insPlanId: null,
    respPartyId: null,
    routing: "all_three",
    allowedProviders: [],
    routingAmbiguous: false,
    preauthRequired: false,
    ...overrides,
  };
}

function deferredResult<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((value) => {
    resolve = value;
  });
  return { promise, resolve };
}

describe("stateful call tools", () => {
  beforeEach(() => {
    useMiddleware({});
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-30T16:00:00.000Z"));
  });

  afterEach(() => {
    setOwnedMiddleware(undefined);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("rejects concurrent duplicate identity writes", () => {
    expect(resolve_patient.onDuplicate).toBe("reject");
    expect(add_patient.onDuplicate).toBe("reject");
  });

  it("keeps private patient references out of the resolve_patient schema", () => {
    expect(Object.keys(resolve_patient.parameters.shape)).toEqual([
      "firstName",
      "lastName",
      "dob",
      "registrationStatus",
    ]);
  });

  it("returns a speech-ready result after creating a patient", async () => {
    const state = createState();
    state.identity.patient.patientId = null;
    state.identity.patient.name = null;
    state.identity.patient.identityConfirmed = false;
    markNewPatientPathConfirmed(state);
    markSchedulingTriaged(state);
    markAcceptedInsurance(state);
    const ctx = createToolContext(state);
    const middleware = stubCreatePatient(createdPatientResult());

    const result = await add_patient.execute(
      {
        firstName: "Jane",
        lastName: "Doe",
        dob: "01/01/1980",
        street: "123 Main St",
        aptSuite: "",
        city: "Spring Hill",
        state: "FL",
        zip: "34606",
        sex: "female",
        subscriberName: "Jane Doe",
        insuranceMemberId: "self pay",
        inboundPhoneConfirmed: true,
        readBack: true,
      },
      { ctx: ctx as never, toolCallId: "tool-1" } as never,
    );

    expect(ctx.speechHandle.allowInterruptions).toBe(false);
    expect(result).toBe(
      "Created a patient chart for Jane Doe. Continue with scheduling.",
    );
    expect(state.identity.patient.patientId).toBe("patient-new");
    expect(state.identity.patient.status).toBe("created");
    expect(state.identity.patient.dob).toBe("01/01/1980");
    expect(state.identity.patient.phone).toBe("+17275551212");
    expect(state.insurance.onFile).toEqual({
      plan: "self pay",
      canonicalPlan: "self pay",
      coverageType: "medical",
      currentCarrier: "self pay",
    });
    expect(state.insurance.lastEligibilityCheck).toBeNull();
    expect(state.workflow.current).toEqual({
      intent: "schedule",
      appointmentLane: "medical_md",
    });
    expect(middleware.requests.createPatient[0]?.patient).toMatchObject({
      firstName: "Jane",
      lastName: "Doe",
      phone: "+17275551212",
      insurance: "self pay",
      subscriberNum: "self pay",
    });
  });

  it.each(["resolve_first", "creation_first"] as const)(
    "does not let chart creation replace a newer resolved patient when %s completes",
    async (completionOrder) => {
      const creation = deferredResult<CreatePatientResult>();
      const lookup = deferredResult<PatientResolveResult>();
      const state = createState();
      markNewPatientPathConfirmed(state);
      markSchedulingTriaged(state);
      markAcceptedInsurance(state);
      const middleware = useMiddleware({
        createPatient: [creation.promise],
        resolvePatient: [lookup.promise],
      });

      const pendingCreation = add_patient.execute(
        {
          firstName: "Jane",
          lastName: "Doe",
          dob: "01/01/1980",
          street: "123 Main St",
          aptSuite: "",
          city: "Spring Hill",
          state: "FL",
          zip: "34606",
          sex: "female",
          subscriberName: "Jane Doe",
          insuranceMemberId: "self pay",
          inboundPhoneConfirmed: true,
          readBack: true,
        },
        {
          ctx: createToolContext(state) as never,
          toolCallId: "tool-1",
        } as never,
      );
      const pendingResolution = resolve_patient.execute(
        { firstName: "John", lastName: "Doe", dob: "02/02/1982" },
        {
          ctx: createToolContext(state) as never,
          toolCallId: "tool-2",
        } as never,
      );
      const creationResult = {
        ...createdPatientResult(),
        status: "partial" as const,
        insuranceCarrier: null,
      };
      const lookupResult = verifiedPatientResult({
        patientId: "patient-john",
        name: "John Doe",
        dob: "02/02/1982",
        phone: "+17275550102",
      });

      if (completionOrder === "resolve_first") {
        lookup.resolve(lookupResult);
        await pendingResolution;
        creation.resolve(creationResult);
      } else {
        creation.resolve(creationResult);
        await pendingCreation;
        lookup.resolve(lookupResult);
      }

      await expect(pendingResolution).resolves.toContain(
        "Verified existing patient John Doe",
      );
      await expect(pendingCreation).resolves.toContain(
        "Created a patient chart for Jane Doe, but insurance was not attached. Do not create another chart. Connect the caller to office staff to finish registration.",
      );
      expect(state.identity.patient).toMatchObject({
        status: "verified",
        identityConfirmed: true,
        patientId: "patient-john",
        name: "John Doe",
        dob: "02/02/1982",
        phone: "+17275550102",
      });
      expect(middleware.operations.map(({ name }) => name)).toEqual([
        "createPatient",
        "resolvePatient",
      ]);
    },
  );

  it("keeps a committed chart when a later identity lookup fails", async () => {
    const deferred = deferredResult<CreatePatientResult>();
    const state = createState();
    markNewPatientPathConfirmed(state);
    markSchedulingTriaged(state);
    markAcceptedInsurance(state);
    const middleware = useMiddleware({
      createPatient: [deferred.promise],
      resolvePatient: [{ status: "error", reason: "network_error" }],
    });
    const params = {
      firstName: "Jane",
      lastName: "Doe",
      dob: "01/01/1980",
      street: "123 Main St",
      aptSuite: "",
      city: "Spring Hill",
      state: "FL",
      zip: "34606",
      sex: "female" as const,
      subscriberName: "Jane Doe",
      insuranceMemberId: "self pay",
      inboundPhoneConfirmed: true,
      readBack: true,
    };

    const pendingCreation = add_patient.execute(params, {
      ctx: createToolContext(state) as never,
      toolCallId: "tool-1",
    } as never);
    const resolution = await resolve_patient.execute(
      { firstName: "John", lastName: "Doe", dob: "02/02/1982" },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-2",
      } as never,
    );
    deferred.resolve(createdPatientResult());

    expect(resolution).toBe("Patient lookup failed. Try again.");
    await expect(pendingCreation).resolves.toBe(
      "Created a patient chart for Jane Doe. Continue with scheduling.",
    );
    expect(state.identity.patient).toMatchObject({
      status: "created",
      identityConfirmed: true,
      patientId: "patient-new",
      name: "Jane Doe",
    });
    expect(state.identity.pendingRegistration).toBeUndefined();
    await expect(
      add_patient.execute(params, {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-3",
      } as never),
    ).resolves.toContain("Patient chart is already created for Jane Doe");
    expect(middleware.operations.map(({ name }) => name)).toEqual([
      "createPatient",
      "resolvePatient",
    ]);
  });

  it("keeps repeated new-chart confirmation idempotent during chart creation", async () => {
    const creation = deferredResult<CreatePatientResult>();
    const state = createState();
    markNewPatientPathConfirmed(state);
    markSchedulingTriaged(state);
    markAcceptedInsurance(state);
    const middleware = useMiddleware({ createPatient: [creation.promise] });
    const params = {
      firstName: "Jane",
      lastName: "Doe",
      dob: "01/01/1980",
      street: "123 Main St",
      aptSuite: "",
      city: "Spring Hill",
      state: "FL",
      zip: "34606",
      sex: "female" as const,
      subscriberName: "Jane Doe",
      insuranceMemberId: "self pay",
      inboundPhoneConfirmed: true,
      readBack: true,
    };

    const pendingCreation = add_patient.execute(params, {
      ctx: createToolContext(state) as never,
      toolCallId: "tool-1",
    } as never);
    const repeatedConfirmation = await resolve_patient.execute(
      { firstName: "Jane", registrationStatus: "not_registered" },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-2",
      } as never,
    );
    creation.resolve(createdPatientResult());

    expect(repeatedConfirmation).toBe(
      "New-chart path confirmed. Continue registration and call add_patient only after read-back confirmation.",
    );
    await expect(pendingCreation).resolves.toBe(
      "Created a patient chart for Jane Doe. Continue with scheduling.",
    );
    expect(state.identity.patient).toMatchObject({
      status: "created",
      identityConfirmed: true,
      patientId: "patient-new",
      name: "Jane Doe",
    });
    expect(state.identity.pendingRegistration).toBeUndefined();
    await expect(
      add_patient.execute(params, {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-3",
      } as never),
    ).resolves.toContain("Patient chart is already created for Jane Doe");
    expect(middleware.operations.map(({ name }) => name)).toEqual([
      "createPatient",
    ]);
  });

  it("invalidates pending chart creation when a different new patient is named", async () => {
    const creation = deferredResult<CreatePatientResult>();
    const state = createState();
    markNewPatientPathConfirmed(state);
    markSchedulingTriaged(state);
    markAcceptedInsurance(state);
    storeAvailabilityBookingToken(state, "A", "private-token");
    const middleware = useMiddleware({ createPatient: [creation.promise] });

    const pendingCreation = add_patient.execute(
      {
        firstName: "Jane",
        lastName: "Doe",
        dob: "01/01/1980",
        street: "123 Main St",
        aptSuite: "",
        city: "Spring Hill",
        state: "FL",
        zip: "34606",
        sex: "female",
        subscriberName: "Jane Doe",
        insuranceMemberId: "self pay",
        inboundPhoneConfirmed: true,
        readBack: true,
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    );
    const newPatient = await resolve_patient.execute(
      { firstName: "John", registrationStatus: "not_registered" },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-2",
      } as never,
    );
    creation.resolve(createdPatientResult());

    expect(newPatient).toBe(
      "New-chart path confirmed. Continue registration and call add_patient only after read-back confirmation.",
    );
    await expect(pendingCreation).resolves.toBe(
      "Created a patient chart for Jane Doe, but the active patient changed before the result returned. Do not create another chart. Continue with the current patient's state.",
    );
    expect(state.identity.patient).toMatchObject({
      status: "new",
      identityConfirmed: false,
      patientId: null,
      name: null,
    });
    expect(state.identity.pendingRegistration).toEqual({ firstName: "John" });
    expect(state.workflow.current).toBeUndefined();
    expect(state.availability.bookingTokensBySlotId).toEqual({});
    expect(state.insurance.lastEligibilityCheck).toBeNull();
    expect(middleware.operations.map(({ name }) => name)).toEqual([
      "createPatient",
    ]);
  });

  it("keeps a partially created chart active without claiming insurance was attached", async () => {
    const state = createState();
    state.identity.patient.patientId = null;
    state.identity.patient.name = null;
    state.identity.patient.identityConfirmed = false;
    markNewPatientPathConfirmed(state);
    markSchedulingTriaged(state);
    markAcceptedInsurance(state);
    const middleware = stubCreatePatient({
      status: "partial",
      patientId: "patient-new",
      name: "Jane Doe",
      dob: "01/01/1980",
      phone: "+17275551212",
      insuranceCarrier: null,
      insPlanId: null,
      respPartyId: null,
      routing: null,
      allowedProviders: [],
      routingAmbiguous: false,
      preauthRequired: false,
    });
    const params = {
      firstName: "Jane",
      lastName: "Doe",
      dob: "01/01/1980",
      street: "123 Main St",
      aptSuite: "",
      city: "Spring Hill",
      state: "FL",
      zip: "34606",
      sex: "female" as const,
      subscriberName: "Jane Doe",
      insuranceMemberId: "self pay",
      inboundPhoneConfirmed: true,
      readBack: true,
    };

    const firstResult = await add_patient.execute(params, {
      ctx: createToolContext(state) as never,
      toolCallId: "tool-1",
    } as never);
    const secondResult = await add_patient.execute(params, {
      ctx: createToolContext(state) as never,
      toolCallId: "tool-2",
    } as never);

    expect(firstResult).toBe(
      "Created a patient chart for Jane Doe, but insurance was not attached. Do not create another chart. Connect the caller to office staff to finish registration.",
    );
    expect(secondResult).toBe(
      "Patient chart is already created for Jane Doe, but insurance is not attached. Do not create another chart. Connect the caller to office staff to finish registration.",
    );
    expect(state.identity.patient).toMatchObject({
      status: "created",
      patientId: "patient-new",
      dob: "01/01/1980",
      phone: "+17275551212",
    });
    expect(state.insurance.onFile).toBeNull();
    expect(middleware.requests.createPatient).toHaveLength(1);
  });

  it("requires not-registered confirmation before creating a patient chart", async () => {
    const state = createState();
    state.identity.patient.patientId = null;
    state.identity.patient.name = null;
    state.identity.patient.identityConfirmed = false;
    markSchedulingTriaged(state);
    markAcceptedInsurance(state);
    const ctx = createToolContext(state);

    const result = await add_patient.execute(
      {
        firstName: "Jane",
        lastName: "Doe",
        dob: "01/01/1980",
        street: "123 Main St",
        aptSuite: "",
        city: "Spring Hill",
        state: "FL",
        zip: "34606",
        sex: "female",
        subscriberName: "Jane Doe",
        insuranceMemberId: "self pay",
        inboundPhoneConfirmed: true,
        readBack: true,
      },
      {
        ctx: ctx as never,
        toolCallId: "tool-1",
      } as never,
    );

    expect(result).toBe(
      "Before creating a new chart, ask whether the patient is already registered with us and call resolve_patient with registrationStatus not_registered after the caller confirms they are not registered.",
    );
    expect(ctx.speechHandle.allowInterruptions).toBe(false);
    expect(ctx.disallowInterruptions).toHaveBeenCalledOnce();
    expect(testMiddleware.operations).toHaveLength(0);
  });

  it("marks a created chart as new-patient state when middleware omits status", async () => {
    const state = createState();
    state.identity.patient.patientId = null;
    state.identity.patient.name = null;
    state.identity.patient.identityConfirmed = false;
    markNewPatientPathConfirmed(state);
    markSchedulingTriaged(state);
    markAcceptedInsurance(state);
    stubCreatePatient(createdPatientResult({ insuranceCarrier: null }));

    await add_patient.execute(
      {
        firstName: "Jane",
        lastName: "Doe",
        dob: "01/01/1980",
        street: "123 Main St",
        aptSuite: "",
        city: "Spring Hill",
        state: "FL",
        zip: "34606",
        sex: "female",
        subscriberName: "Jane Doe",
        insuranceMemberId: "self pay",
        inboundPhoneConfirmed: true,
        readBack: true,
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    );

    expect(state.identity.patient.status).toBe("created");
    expect(state.insurance.onFile).toEqual({
      plan: "self pay",
      canonicalPlan: "self pay",
      coverageType: "medical",
      currentCarrier: "self pay",
    });
    expect(state.insurance.lastEligibilityCheck).toBeNull();
  });

  it("blocks new chart creation when a pending pre-call candidate matches last name and DOB", async () => {
    const state = createState();
    setSingleArshedPreCallCandidate(state);
    state.identity.patient.status = "new";
    markSchedulingTriaged(state);
    state.insurance.lastEligibilityCheck = {
      plan: "Florida Blue Shield",
      canonicalPlan: "Florida Blue Shield",
      coverageType: "routine_vision",
      currentCarrier: "Florida Blue Shield",
      accepted: true,
    };

    const result = await add_patient.execute(
      {
        firstName: "Lisa",
        lastName: "Arshed",
        dob: "10/03/2020",
        street: "123 Main St",
        aptSuite: "",
        city: "Spring Hill",
        state: "FL",
        zip: "34606",
        sex: "male",
        subscriberName: "Adam Arshed",
        insuranceMemberId: "FWZ975W06612",
        inboundPhoneConfirmed: true,
        readBack: true,
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    );

    expect(result).toBe(
      "A patient record may already exist for that last name and date of birth from the caller phone lookup. Confirm the existing patient record before creating a new chart.",
    );
    expect(testMiddleware.operations).toHaveLength(0);
  });

  it("requires an accepted insurance check before creating a patient", async () => {
    const state = createState();
    state.identity.patient.patientId = null;
    state.identity.patient.name = null;
    state.identity.patient.identityConfirmed = false;
    markNewPatientPathConfirmed(state);
    clearSchedulingContext(state);

    const result = await add_patient.execute(
      {
        firstName: "Jane",
        lastName: "Doe",
        dob: "01/01/1980",
        street: "123 Main St",
        city: "Spring Hill",
        state: "FL",
        zip: "34606",
        sex: "female",
        subscriberName: "Jane Doe",
        insuranceMemberId: "self pay",
        phone: "7275551212",
        readBack: true,
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    );

    expect(result).toBe(
      "Run check_insurance for accepted medical or routine-vision coverage before creating a patient chart.",
    );
    expect(testMiddleware.operations).toHaveLength(0);
  });

  it("blocks routine vision chart creation for Crystal River", async () => {
    const state = createState();
    state.office.activeKey = "crystal-river";
    state.office.phoneOverrides = {
      "crystal-river": "+13523202007",
    };
    state.identity.patient.patientId = null;
    state.identity.patient.name = null;
    state.identity.patient.identityConfirmed = false;
    markNewPatientPathConfirmed(state);
    clearSchedulingContext(state);
    markAcceptedInsurance(state, {
      plan: "self pay",
      canonicalPlan: "self pay",
      coverageType: "routine_vision",
    });

    const result = await add_patient.execute(
      {
        firstName: "Jane",
        lastName: "Doe",
        dob: "01/01/1980",
        street: "123 Main St",
        aptSuite: "",
        city: "Crystal River",
        state: "FL",
        zip: "34429",
        sex: "female",
        subscriberName: "Jane Doe",
        insuranceMemberId: "self pay",
        phone: "7275551212",
        readBack: true,
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    );

    expect(result).toBe(
      "Eye Radiance handles medical eye care, including cataract evaluations, but does not schedule routine eye exams, glasses prescriptions, or contact lens prescriptions. Do not schedule routine vision through this office.",
    );
    expect(state.office.activeKey).toBe("crystal-river");
    expect(state.office.phoneOverrides).not.toHaveProperty("spring-hill");
    expect(testMiddleware.operations).toHaveLength(0);
  });

  it("derives routine vision from accepted coverage and requires SSN last four", async () => {
    const baseParams = {
      firstName: "Jane",
      lastName: "Doe",
      dob: "01/01/1980",
      street: "123 Main St",
      aptSuite: "",
      city: "Spring Hill",
      state: "FL",
      zip: "34606",
      sex: "female" as const,
      subscriberName: "Jane Doe",
      insuranceMemberId: "self pay",
      phone: "7275551212",
      readBack: true,
    };

    const routineState = createState();
    routineState.identity.patient.patientId = null;
    routineState.identity.patient.name = null;
    routineState.identity.patient.identityConfirmed = false;
    markNewPatientPathConfirmed(routineState);
    clearSchedulingContext(routineState);
    markAcceptedInsurance(routineState, {
      plan: "self pay",
      canonicalPlan: "self pay",
      coverageType: "routine_vision",
    });

    await expect(
      add_patient.execute(baseParams, {
        ctx: createToolContext(routineState) as never,
        toolCallId: "tool-1",
      } as never),
    ).rejects.toThrow(
      "Collect the patient's SSN last four before creating a routine-vision chart.",
    );

    expect(routineState.workflow.current).toEqual({
      intent: "schedule",
      appointmentLane: "routine_od",
    });
    expect(testMiddleware.operations).toHaveLength(0);
  });

  it("requires read-back confirmation before creating a patient", async () => {
    const state = createState();
    state.identity.patient.patientId = null;
    state.identity.patient.name = null;
    state.identity.patient.identityConfirmed = false;
    markNewPatientPathConfirmed(state);
    markSchedulingTriaged(state);
    markAcceptedInsurance(state);
    const ctx = createToolContext(state);

    const result = await add_patient.execute(
      {
        firstName: "Jane",
        lastName: "Doe",
        dob: "01/01/1980",
        street: "123 Main St",
        aptSuite: "",
        city: "Spring Hill",
        state: "FL",
        zip: "34606",
        sex: "female",
        subscriberName: "Jane Doe",
        insuranceMemberId: "self pay",
        phone: "7275551212",
      },
      { ctx: ctx as never, toolCallId: "tool-1" } as never,
    );

    expect(result).toBe(
      "Read back the new patient details first: patient name, date of birth, sex, address, callback phone, email if provided, insurance plan, policyholder name, member ID, and patient SSN last 4 for routine vision. Call add_patient again only after the caller confirms the details are correct.",
    );
    expect(testMiddleware.operations).toHaveLength(0);
    expect(ctx.speechHandle.allowInterruptions).toBe(false);
  });

  it("asks before using the inbound caller phone for a new patient chart", async () => {
    const state = createState();
    state.identity.patient.patientId = null;
    state.identity.patient.name = null;
    state.identity.patient.identityConfirmed = false;
    markNewPatientPathConfirmed(state);
    markSchedulingTriaged(state);
    markAcceptedInsurance(state);

    const result = await add_patient.execute(
      {
        firstName: "Jane",
        lastName: "Doe",
        dob: "01/01/1980",
        street: "123 Main St",
        aptSuite: "",
        city: "Spring Hill",
        state: "FL",
        zip: "34606",
        sex: "female",
        subscriberName: "Jane Doe",
        insuranceMemberId: "self pay",
        readBack: true,
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    );

    expect(result).toBe(
      "Ask the caller: Is the number you are calling from a good callback number to put on file? If yes, call add_patient again with inboundPhoneConfirmed set to true. If not, collect the callback phone number and pass it as phone.",
    );
    expect(testMiddleware.operations).toHaveLength(0);
  });

  it("uses the inbound caller phone after explicit confirmation", async () => {
    const state = createState();
    state.identity.patient.patientId = null;
    state.identity.patient.name = null;
    state.identity.patient.identityConfirmed = false;
    markNewPatientPathConfirmed(state);
    markSchedulingTriaged(state);
    markAcceptedInsurance(state);
    const middleware = stubCreatePatient(createdPatientResult());

    await add_patient.execute(
      {
        firstName: "Jane",
        lastName: "Doe",
        dob: "01/01/1980",
        street: "123 Main St",
        aptSuite: "",
        city: "Spring Hill",
        state: "FL",
        zip: "34606",
        sex: "female",
        subscriberName: "Jane Doe",
        insuranceMemberId: "self pay",
        phone: "   ",
        inboundPhoneConfirmed: true,
        readBack: true,
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    );

    expect(middleware.requests.createPatient[0]?.patient).toMatchObject({
      phone: "+17275551212",
    });
  });

  it("returns a speech-ready result after confirming identity by lookup", async () => {
    const state = createState();
    state.identity.patient.patientId = null;
    state.identity.patient.name = null;
    state.identity.patient.identityConfirmed = false;
    const middleware = stubPatient(
      verifiedPatientResult({
        appointmentsStatus: "found",
        appointments: [
          {
            id: 123,
            date: "June 1",
            time: "9:00 AM",
            provider: "Dr. Bach",
            type: "Office Visit",
            facility: "Spring Hill",
            confirmed: false,
            cancellationToken: "private-cancellation-token",
          },
        ],
      }),
    );

    const result = await resolve_patient.execute(
      {
        firstName: "Jane",
        lastName: "Doe",
        dob: "01/01/1980",
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    expect(result).toMatch(
      /^Verified existing patient Jane Doe\. Insurance on file: self pay\. Loaded 1 appointment: June 1 at 9:00 AM with Dr\. Bach \(appointmentRef appointment-[a-z0-9]+\)\.$/,
    );
    expect(result).not.toContain("123");
    expect(result).not.toContain("private-cancellation-token");
    expect(state.identity.patient.patientId).toBe("patient-1");
    expect(state.identity.patient.appointments).toEqual([
      expect.objectContaining({
        appointmentRef: expect.stringMatching(/^appointment-[a-z0-9]+$/),
        cancellationToken: "private-cancellation-token",
      }),
    ]);
    expect(middleware.requests.resolvePatient[0]).toMatchObject({
      identity: {
        firstName: "Jane",
        lastName: "Doe",
        dob: "01/01/1980",
      },
    });
    expect(middleware.requests.resolvePatient[0]?.identity).not.toHaveProperty(
      "phone",
    );
  });

  it("presents a distinct safe reference with every loaded appointment choice", async () => {
    const state = createState();
    state.identity.patient.patientId = null;
    state.identity.patient.name = null;
    state.identity.patient.identityConfirmed = false;
    const middleware = stubPatient(
      verifiedPatientResult({
        appointmentsStatus: "found",
        appointments: [
          {
            id: 123,
            date: "June 1",
            time: "9:00 AM",
            provider: "Dr. Bach",
            type: "Office Visit",
            facility: "Spring Hill",
            confirmed: false,
            cancellationToken: "private-token-one",
          },
          {
            id: 456,
            date: "June 2",
            time: "2:00 PM",
            provider: "Dr. Licht",
            type: "Follow-up",
            facility: "Spring Hill",
            confirmed: false,
            cancellationToken: "private-token-two",
          },
        ],
      }),
    );

    const result = await resolve_patient.execute(
      {
        firstName: "Jane",
        lastName: "Doe",
        dob: "01/01/1980",
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    const presentedRefs =
      result.match(/appointmentRef (appointment-[a-z0-9]+)/g) ?? [];
    expect(presentedRefs).toHaveLength(2);
    expect(new Set(presentedRefs).size).toBe(2);
    expect(result).not.toContain("123");
    expect(result).not.toContain("456");
    expect(result).not.toContain("private-token");
    expect(state.identity.patient.appointments).toEqual([
      expect.objectContaining({
        appointmentRef: expect.stringMatching(/^appointment-[a-z0-9]+$/),
        cancellationToken: "private-token-one",
      }),
      expect.objectContaining({
        appointmentRef: expect.stringMatching(/^appointment-[a-z0-9]+$/),
        cancellationToken: "private-token-two",
      }),
    ]);
    expect(middleware.requests.resolvePatient).toHaveLength(1);
  });

  it("presents all loaded appointment references instead of hiding extra choices", async () => {
    const state = createState();
    state.identity.patient.patientId = null;
    state.identity.patient.name = null;
    state.identity.patient.identityConfirmed = false;
    stubPatient(
      verifiedPatientResult({
        appointmentsStatus: "found",
        appointments: [1, 2, 3, 4].map((day) => ({
          id: day,
          date: `June ${day}`,
          time: "9:00 AM",
          provider: "Dr. Bach",
          type: "Office Visit",
          facility: "Spring Hill",
          confirmed: false,
        })),
      }),
    );

    const result = await resolve_patient.execute(
      {
        firstName: "Jane",
        lastName: "Doe",
        dob: "01/01/1980",
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    expect(
      result.match(/appointmentRef appointment-[a-z0-9]+/g) ?? [],
    ).toHaveLength(4);
    expect(result).not.toContain("and 1 more");
  });

  it("clears stale booking context before resolving a different full-identity patient", async () => {
    const state = createState();
    state.runtime.trunkPhone = "+13523202007";
    state.office.activeKey = "spring-hill";
    state.office.phoneOverrides = {
      "crystal-river": "+13523202007",
      "spring-hill": "+17275919997",
    };
    markSchedulingTriaged(state, "routine_od");
    state.availability.latestRouting = "optical_only";
    storeAvailabilityBookingToken(state, "A", "stale-token");
    state.identity.latestBookedAppointmentId = 123;
    state.insurance.lastEligibilityCheck = {
      plan: "Aetna",
      canonicalPlan: "Aetna",
      coverageType: "routine_vision",
      currentCarrier: "Aetna",
      accepted: true,
    };
    const middleware = stubPatient(
      verifiedPatientResult({
        patientId: "patient-2",
        name: "John Doe",
        dob: "02/02/1982",
        insuranceCarrier: "Aetna",
        routing: "bach_only",
        allowedProviders: ["Dr. Bach"],
      }),
    );

    const result = await resolve_patient.execute(
      {
        firstName: "John",
        lastName: "Doe",
        dob: "02/02/1982",
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    expect(result).toBe(
      "Verified existing patient John Doe. Insurance on file: Aetna. No upcoming appointments are loaded.",
    );
    expect(middleware.requests.resolvePatient[0]).toMatchObject({
      identity: {
        firstName: "John",
        lastName: "Doe",
        dob: "02/02/1982",
      },
      office: "+13523202007",
    });
    expect(state.identity.patient.patientId).toBe("patient-2");
    expect(state.workflow.current).toBeUndefined();
    expect(state.office.activeKey).toBe("crystal-river");
    expect(state.availability.slots).toEqual([]);
    expect(state.availability.bookingTokensBySlotId).toEqual({});
    expect(state.identity.latestBookedAppointmentId).toBeUndefined();
    expect(state.insurance.lastEligibilityCheck).toBeNull();
  });

  it("clearly reports verified existing patients without insurance on file", async () => {
    const state = createState();
    state.identity.patient.patientId = null;
    state.identity.patient.name = null;
    state.identity.patient.identityConfirmed = false;
    stubPatient(
      verifiedPatientResult({
        name: "TEST,CHASE",
        dob: "04/07/2000",
        phone: "(954) 609-7250",
        insuranceCarrier: null,
        respPartyId: "resp-1",
        routing: null,
      }),
    );

    const result = await resolve_patient.execute(
      {
        firstName: "Chase",
        lastName: "Test",
        dob: "04/07/2000",
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    expect(result).toBe(
      "Verified existing patient TEST,CHASE. No insurance is currently on file. No upcoming appointments are loaded.",
    );
    expect(state.identity.patient.patientId).toBe("patient-1");
    expect(state.identity.patient.identityConfirmed).toBe(true);
    expect(state.insurance.onFile).toBeNull();
    expect(state.insurance.lastEligibilityCheck).toBeNull();
  });

  it("confirms a pre-call single match from full identity without middleware lookup", async () => {
    const state = createTestCallState({
      preCall: {
        status: "single_match_pending_confirmation",
        source: "phone_lookup",
        callerPhone: "+17275551212",
        candidates: [
          {
            ref: CALLER_CANDIDATE_REF,
            firstName: "Jane",
            lastName: "Doe",
            dob: "01/01/1980",
            patientId: "patient-1",
            relationshipToCaller: "self",
            appointments: [
              {
                id: 123,
                date: "June 1",
                time: "9:00 AM",
                provider: "Dr. Bach",
                type: "Office Visit",
                facility: "Spring Hill",
                confirmed: false,
              },
            ],
            appointmentsStatus: "found",
            insuranceCarrier: "Aetna",
            insPlanId: "plan-1",
            respPartyId: "resp-1",
            routing: "all_three",
            allowedProviders: ["Dr. Bach"],
            routingAmbiguous: false,
            preauthRequired: false,
          },
        ],
        selectedCandidateRef: CALLER_CANDIDATE_REF,
        appointmentLoadStatus: "found",
        identityPromotion: "none",
      },
      preCallLookup: {
        status: "verified",
        durationMs: 42,
        candidateCount: 1,
        appointmentsStatus: "found",
      },
    });

    const result = await resolve_patient.execute(
      {
        firstName: "Jaaane",
        lastName: "Doe",
        dob: "01/01/1980",
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    expect(testMiddleware.operations).toHaveLength(0);
    expect(result).toMatch(
      /^Verified existing patient Jane Doe\. Insurance on file: Aetna\. Loaded 1 appointment: June 1 at 9:00 AM with Dr\. Bach \(appointmentRef appointment-[a-z0-9]+\)\.$/,
    );
    expect(state.identity.preCall?.status).toBe("single_match_confirmed");
    expect(state.identity.patient.identityConfirmed).toBe(true);
    expect(state.identity.patient.patientId).toBe("patient-1");
    expect(state.insurance.onFile?.currentCarrier).toBe("Aetna");
    expect(state.workflow.routing.routing).toBe("all_three");
  });

  it("asks for first-name spelling after lookup fails for a pre-call single match with matching last name and DOB", async () => {
    const state = createState();
    setSingleArshedPreCallCandidate(state);
    const middleware = stubPatient({
      status: "not_found",
      message: "No patient found matching that first name.",
    });

    const result = await resolve_patient.execute(
      {
        firstName: "Lisa",
        lastName: "Arshed",
        dob: "10/03/2020",
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    expect(result).toBe(
      "I found a record with that last name and date of birth, but the first name does not match what I heard. Could you spell the patient's first name?",
    );
    expect(middleware.requests.resolvePatient[0]).toMatchObject({
      identity: {
        firstName: "Lisa",
        lastName: "Arshed",
        dob: "10/03/2020",
      },
    });
    expect(state.identity.preCall.status).toBe(
      "single_match_pending_confirmation",
    );
    expect(state.identity.patient.identityConfirmed).toBe(false);
  });

  it("preserves lookup failures instead of using the pre-call spelling fallback", async () => {
    const state = createState();
    setSingleArshedPreCallCandidate(state);
    stubPatient({
      status: "error",
      reason: "middleware_error",
    });

    const result = await resolve_patient.execute(
      {
        firstName: "Lisa",
        lastName: "Arshed",
        dob: "10/03/2020",
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    expect(result).toBe("Patient lookup failed. Try again.");
    expect(state.identity.preCall.status).toBe(
      "single_match_pending_confirmation",
    );
    expect(state.identity.patient.identityConfirmed).toBe(false);
    expect(ownedMiddlewareFailures(state)).toMatchObject([
      { operation: "resolvePatient", reason: "middleware_error" },
    ]);
  });

  it("verifies a backend patient before spelling fallback when a pre-call single match shares last name and DOB", async () => {
    const state = createState();
    setSingleArshedPreCallCandidate(state);
    const middleware = stubPatient({
      status: "verified",
      patientId: "patient-ella",
      name: "ELLA ARSHED",
      dob: "10/03/2020",
      phone: "+17275551212",
      insuranceCarrier: "Aetna",
      insPlanId: null,
      respPartyId: null,
      routing: "all_three",
      allowedProviders: [],
      routingAmbiguous: false,
      preauthRequired: false,
      appointmentsStatus: "none",
      appointmentsMessage: null,
      appointments: [],
      message: null,
    });

    const result = await resolve_patient.execute(
      {
        firstName: "Ella",
        lastName: "Arshed",
        dob: "10/03/2020",
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    expect(result).toBe(
      "Verified existing patient ELLA ARSHED. Insurance on file: Aetna. No upcoming appointments are loaded.",
    );
    expect(middleware.requests.resolvePatient[0]).toMatchObject({
      identity: {
        firstName: "Ella",
        lastName: "Arshed",
        dob: "10/03/2020",
      },
    });
    expect(state.identity.patient.identityConfirmed).toBe(true);
    expect(state.identity.patient.patientId).toBe("patient-ella");
  });

  it("confirms a unique multiple-match pre-call candidate from full identity", async () => {
    const state = createState();
    setPatientUnknown(state);
    setMultiplePreCallCandidates(state, [
      preCallCandidate({
        ref: "precall:1",
        firstName: "CHASE",
        lastName: "TEST",
        dob: "04/07/2000",
        patientId: "patient-chase",
        relationshipToCaller: "unknown",
        insuranceCarrier: null,
        insPlanId: null,
        respPartyId: "resp-chase",
        routing: null,
        allowedProviders: [],
      }),
      preCallCandidate({
        ref: "precall:2",
        firstName: "KYLE",
        lastName: "TEST",
        dob: "08/18/2000",
        patientId: "patient-kyle",
        relationshipToCaller: "unknown",
        insuranceCarrier: "Oscar",
        insPlanId: "plan-kyle",
        respPartyId: "resp-kyle",
        routing: "bach_licht",
        allowedProviders: ["Dr. Licht"],
      }),
    ]);

    const result = await resolve_patient.execute(
      {
        firstName: "Chase",
        lastName: "Test",
        dob: "04/07/2000",
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    expect(testMiddleware.operations).toHaveLength(0);
    expect(result).toBe(
      "Verified existing patient CHASE TEST. No insurance is currently on file. No upcoming appointments are loaded.",
    );
    expect(state.identity.preCall.status).toBe("multiple_match_confirmed");
    expect(state.identity.preCall.selectedCandidateRef).toBe("precall:1");
    expect(state.identity.patient.identityConfirmed).toBe(true);
    expect(state.identity.patient.patientId).toBe("patient-chase");
  });

  it("switches an active pre-call patient when another preloaded patient is resolved", async () => {
    const state = createState();
    state.identity.patient = {
      ...state.identity.patient,
      status: "verified",
      identityConfirmed: true,
      patientId: "patient-brandon",
      name: "BRANDON ANDERSON",
      dob: "04/05/2012",
      phone: "+19045550199",
      appointments: [],
      appointmentsStatus: "none",
    };
    setMultiplePreCallCandidates(
      state,
      [
        preCallCandidate({
          ref: "precall:1",
          firstName: "BRANDON",
          lastName: "ANDERSON",
          dob: "04/05/2012",
          patientId: "patient-brandon",
          insuranceCarrier: undefined,
          routing: undefined,
          allowedProviders: undefined,
        }),
        preCallCandidate({
          ref: "precall:2",
          firstName: "MONIQUE",
          lastName: "HAMILTON",
          dob: "12/21/2016",
          patientId: "patient-monique",
          insuranceCarrier: undefined,
          routing: undefined,
          allowedProviders: undefined,
        }),
      ],
      {
        status: "multiple_match_confirmed",
        callerPhone: "+17863488102",
        selectedCandidateRef: "precall:1",
        identityPromotion: "confirmed_by_transcript",
      },
    );

    const result = await resolve_patient.execute(
      {
        firstName: "Monique",
        lastName: "Hamilton",
        dob: "12/21/2016",
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    expect(testMiddleware.operations).toHaveLength(0);
    expect(result).toBe(
      "Switched active patient to MONIQUE HAMILTON. Check availability again before booking.",
    );
    expect(state.identity.preCall.selectedCandidateRef).toBe("precall:2");
    expect(state.identity.preCall.identityPromotion).toBe(
      "switched_by_identity_tool",
    );
    expect(state.identity.patient.identityConfirmed).toBe(true);
    expect(state.identity.patient.patientId).toBe("patient-monique");
    expect(state.identity.patient.name).toBe("MONIQUE HAMILTON");
    expect(state.identity.patient.phone).toBe("+17863488102");
  });

  it("does not clear booking state when resolving the already active pre-call patient", async () => {
    const state = createState();
    state.identity.patient = {
      ...state.identity.patient,
      status: "verified",
      identityConfirmed: true,
      patientId: "patient-brandon",
      name: "BRANDON ANDERSON",
      dob: "04/05/2012",
      phone: null,
      appointments: [],
      appointmentsStatus: "none",
    };
    setMultiplePreCallCandidates(
      state,
      [
        preCallCandidate({
          ref: "precall:1",
          firstName: "BRANDON",
          lastName: "ANDERSON",
          dob: "04/05/2012",
          patientId: "patient-brandon",
          insuranceCarrier: undefined,
          routing: undefined,
          allowedProviders: undefined,
        }),
      ],
      {
        status: "multiple_match_confirmed",
        callerPhone: "+17863488102",
        selectedCandidateRef: "precall:1",
        identityPromotion: "confirmed_by_identity_tool",
      },
    );
    storeAvailabilityBookingToken(state, "A", "token-a");
    state.identity.latestBookedAppointmentId = 123;
    state.insurance.lastEligibilityCheck = {
      plan: "Aetna",
      canonicalPlan: "Aetna",
      coverageType: "medical",
      currentCarrier: "Aetna",
      accepted: true,
    };

    const result = await resolve_patient.execute({ firstName: "Brandon" }, {
      ctx: createToolContext(state) as never,
      toolCallId: "tool-1",
    } as never);

    expect(testMiddleware.operations).toHaveLength(0);
    expect(result).toBe(
      "BRANDON ANDERSON is already the active patient. Continue with loaded patient state.",
    );
    expect(state.availability.slots.map((slot) => slot.slotId)).toEqual(["A"]);
    expect(state.availability.bookingTokensBySlotId).toEqual({
      A: "token-a",
    });
    expect(state.identity.latestBookedAppointmentId).toBe(123);
    expect(state.insurance.lastEligibilityCheck).toEqual({
      plan: "Aetna",
      canonicalPlan: "Aetna",
      coverageType: "medical",
      currentCarrier: "Aetna",
      accepted: true,
    });
  });

  it("resolves an exact short first name from pre-call candidates", async () => {
    const state = createState();
    setPatientUnknown(state);
    setMultiplePreCallCandidates(state, [
      preCallCandidate({
        ref: "precall:1",
        firstName: "AL",
        lastName: "DOE",
        dob: "01/01/1980",
        patientId: "patient-al",
        appointments: [
          {
            id: 123,
            date: "June 1",
            time: "9:00 AM",
            provider: "Dr. Bach",
            type: "Office Visit",
            facility: "Spring Hill",
            confirmed: false,
          },
        ],
        appointmentsStatus: "found",
        insuranceCarrier: "Aetna",
        routing: undefined,
        allowedProviders: undefined,
      }),
      preCallCandidate({
        ref: "precall:2",
        firstName: "BOB",
        lastName: "DOE",
        dob: "02/02/1980",
        patientId: "patient-bob",
        insuranceCarrier: undefined,
        routing: undefined,
        allowedProviders: undefined,
      }),
    ]);

    const result = await resolve_patient.execute({ firstName: "Al" }, {
      ctx: createToolContext(state) as never,
      toolCallId: "tool-1",
    } as never);

    expect(testMiddleware.operations).toHaveLength(0);
    expect(result).toMatch(
      /^Verified existing patient AL DOE\. Insurance on file: Aetna\. Loaded 1 appointment: June 1 at 9:00 AM with Dr\. Bach \(appointmentRef appointment-[a-z0-9]+\)\.$/,
    );
    expect(state.identity.patient.identityConfirmed).toBe(true);
    expect(state.identity.patient.patientId).toBe("patient-al");
  });

  it("asks for clarification when a first-name pre-call match is ambiguous", async () => {
    const state = createState();
    setPatientUnknown(state);
    setMultiplePreCallCandidates(state, [
      preCallCandidate({
        ref: "precall:1",
        firstName: "KYLE",
        lastName: "TEST",
        dob: "08/18/2000",
        patientId: "patient-kyle",
        appointmentsStatus: undefined,
        insuranceCarrier: undefined,
        routing: undefined,
        allowedProviders: undefined,
      }),
      preCallCandidate({
        ref: "precall:2",
        firstName: "KYLEE",
        lastName: "TEST",
        dob: "10/10/2015",
        patientId: "patient-kylee",
        appointmentsStatus: undefined,
        insuranceCarrier: undefined,
        routing: undefined,
        allowedProviders: undefined,
      }),
    ]);

    const result = await resolve_patient.execute(
      {
        firstName: "Kyle",
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    );
    expect(result).toBe(
      "More than one preloaded patient matched that first name. Ask for the patient's date of birth, then call resolve_patient with first name, last name, and DOB.",
    );
    expect(testMiddleware.operations).toHaveLength(0);
    expect(state.identity.patient.identityConfirmed).toBe(false);
  });

  it("does not call middleware until full identity is provided", async () => {
    const state = createState();
    state.identity.preCall = {
      status: "no_match",
      source: "phone_lookup",
      callerPhone: "+17275551212",
      candidates: [],
      identityPromotion: "none",
    };
    state.identity.patient.patientId = null;
    state.identity.patient.name = null;
    state.identity.patient.identityConfirmed = false;

    const result = await resolve_patient.execute(
      {
        firstName: "Jane",
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    );
    expect(result).toBe(
      "Collect the patient's last name and date of birth, then call resolve_patient again.",
    );
    expect(testMiddleware.operations).toHaveLength(0);
  });

  it("marks the new-chart path before chart creation while preserving accepted insurance eligibility", async () => {
    const state = createState();
    state.identity.patient.patientId = null;
    state.identity.patient.name = null;
    state.identity.patient.identityConfirmed = false;
    storeAvailabilityBookingToken(state, "A", "stale-token");
    state.identity.latestBookedAppointmentId = 123;
    state.insurance.lastEligibilityCheck = {
      plan: "Aetna",
      canonicalPlan: "Aetna",
      coverageType: "medical",
      currentCarrier: "Aetna",
      accepted: true,
    };

    const result = await resolve_patient.execute(
      { registrationStatus: "not_registered" },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    expect(result).toBe(
      "New-chart path confirmed. Continue registration and call add_patient only after read-back confirmation.",
    );
    expect(state.identity.patient.status).toBe("new");
    expect(state.identity.patient.identityConfirmed).toBe(false);
    expect(state.identity.patient.patientId).toBeNull();
    expect(state.availability.slots).toEqual([]);
    expect(state.identity.latestBookedAppointmentId).toBeUndefined();
    expect(state.insurance.lastEligibilityCheck).toEqual({
      plan: "Aetna",
      canonicalPlan: "Aetna",
      coverageType: "medical",
      currentCarrier: "Aetna",
      accepted: true,
    });
    expect(state.insurance.onFile).toBeNull();
  });

  it("does not demote an already confirmed patient to the new-chart path", async () => {
    const state = createState();

    const result = await resolve_patient.execute(
      { registrationStatus: "not_registered" },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    expect(result).toBe(
      "Jane Doe is already loaded as an existing patient. Continue with the loaded patient state instead of creating a new chart.",
    );
    expect(testMiddleware.operations).toHaveLength(0);
    expect(state.identity.patient).toMatchObject({
      status: "matched",
      identityConfirmed: true,
      patientId: "patient-1",
      name: "Jane Doe",
      dob: "01/01/1980",
    });
    expect(state.insurance.onFile).toEqual({
      plan: "self pay",
      canonicalPlan: "self pay",
      coverageType: "medical",
      currentCarrier: "self pay",
    });
  });

  it("does not demote a comma-formatted active patient name to the new-chart path", async () => {
    const state = createState();
    state.identity.patient.name = "TEST,CHASE";
    state.identity.patient.dob = "01/01/1980";

    const result = await resolve_patient.execute(
      {
        firstName: "Chase",
        lastName: "Test",
        dob: "01/01/1980",
        registrationStatus: "not_registered",
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    expect(result).toBe(
      "TEST,CHASE is already loaded as an existing patient. Continue with the loaded patient state instead of creating a new chart.",
    );
    expect(testMiddleware.operations).toHaveLength(0);
    expect(state.identity.patient).toMatchObject({
      status: "matched",
      identityConfirmed: true,
      patientId: "patient-1",
      name: "TEST,CHASE",
      dob: "01/01/1980",
    });
  });

  it("allows the new-chart path for a different patient after another patient is active", async () => {
    const state = createState();

    const result = await resolve_patient.execute(
      {
        firstName: "John",
        registrationStatus: "not_registered",
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    expect(result).toBe(
      "New-chart path confirmed. Continue registration and call add_patient only after read-back confirmation.",
    );
    expect(testMiddleware.operations).toHaveLength(0);
    expect(state.identity.patient).toMatchObject({
      status: "new",
      identityConfirmed: false,
      patientId: null,
      name: null,
      dob: null,
    });
    expect(state.insurance.onFile).toBeNull();
  });

  it("allows the new-chart path when the new first name is a substring of the active patient name", async () => {
    const state = createState();
    state.identity.patient.name = "Sally Doe";

    const result = await resolve_patient.execute(
      {
        firstName: "Al",
        registrationStatus: "not_registered",
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    expect(result).toBe(
      "New-chart path confirmed. Continue registration and call add_patient only after read-back confirmation.",
    );
    expect(testMiddleware.operations).toHaveLength(0);
    expect(state.identity.patient).toMatchObject({
      status: "new",
      identityConfirmed: false,
      patientId: null,
      name: null,
      dob: null,
    });
  });

  it("does not let a not-registered answer activate a preloaded first-name match", async () => {
    const state = createState();
    state.identity.patient.patientId = null;
    state.identity.patient.name = null;
    state.identity.patient.identityConfirmed = false;
    state.identity.preCall = {
      status: "single_match_pending_confirmation",
      source: "phone_lookup",
      callerPhone: "+17275551212",
      selectedCandidateRef: CALLER_CANDIDATE_REF,
      candidates: [
        {
          ref: CALLER_CANDIDATE_REF,
          firstName: "JANE",
          lastName: "DOE",
          dob: "01/01/1980",
          patientId: "patient-jane",
          appointments: [],
          appointmentsStatus: "none",
        },
      ],
      identityPromotion: "none",
    };

    const result = await resolve_patient.execute(
      { firstName: "Jane", registrationStatus: "not_registered" },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    expect(result).toBe(
      "New-chart path confirmed. Continue registration and call add_patient only after read-back confirmation.",
    );
    expect(testMiddleware.operations).toHaveLength(0);
    expect(state.identity.preCall.status).toBe(
      "single_match_pending_confirmation",
    );
    expect(state.identity.patient.status).toBe("new");
    expect(state.identity.patient.identityConfirmed).toBe(false);
    expect(state.identity.patient.patientId).toBeNull();
  });

  it("keeps a confirmed pre-call patient inactive after starting a new chart", async () => {
    const state = createState();
    state.identity.preCall = {
      status: "single_match_confirmed",
      source: "phone_lookup",
      callerPhone: "+17275551212",
      selectedCandidateRef: CALLER_CANDIDATE_REF,
      candidates: [
        {
          ref: CALLER_CANDIDATE_REF,
          firstName: "JANE",
          lastName: "DOE",
          dob: "01/01/1980",
          patientId: "patient-jane",
          appointments: [
            {
              id: 123,
              date: "2026-06-01",
              time: "9:00 AM",
              provider: "Doctor Smith",
              type: "Medical",
              facility: "Spring Hill",
              confirmed: true,
            },
          ],
          appointmentsStatus: "found",
        },
      ],
      identityPromotion: "confirmed_by_identity_tool",
    };

    await resolve_patient.execute(
      { firstName: "John", registrationStatus: "not_registered" },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    expect(state.identity.patient).toMatchObject({
      status: "new",
      identityConfirmed: false,
      patientId: null,
      name: null,
      dob: null,
      phone: null,
      appointments: [],
    });
    await expect(
      cancel_appointment.execute({}, {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-2",
      } as never),
    ).rejects.toThrow("Verify the patient before cancelling.");
    expect(testMiddleware.operations).toHaveLength(0);
    expect(state.identity.patient.status).toBe("new");
  });

  it("blocks new chart creation when a confirmed pre-call candidate has the same last name and DOB", async () => {
    const state = createState();
    markNewPatientPathConfirmed(state);
    markSchedulingTriaged(state);
    markAcceptedInsurance(state, {
      plan: "Aetna",
      canonicalPlan: "Aetna",
      coverageType: "medical",
    });
    state.identity.preCall = {
      status: "single_match_confirmed",
      source: "phone_lookup",
      callerPhone: "+17275551212",
      selectedCandidateRef: CALLER_CANDIDATE_REF,
      candidates: [
        {
          ref: CALLER_CANDIDATE_REF,
          firstName: "JANE",
          lastName: "DOE",
          dob: "01/01/1980",
          patientId: "patient-jane",
          appointments: [],
          appointmentsStatus: "none",
        },
      ],
      identityPromotion: "confirmed_by_identity_tool",
    };

    const result = await add_patient.execute(
      {
        firstName: "Jane",
        lastName: "Doe",
        dob: "01/01/1980",
        street: "123 Main St",
        aptSuite: "",
        city: "Spring Hill",
        state: "FL",
        zip: "34606",
        sex: "female",
        subscriberName: "Jane Doe",
        insuranceMemberId: "ABC123",
        inboundPhoneConfirmed: true,
        readBack: true,
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-2" } as never,
    );

    expect(result).toBe(
      "A patient record may already exist for that last name and date of birth from the caller phone lookup. Confirm the existing patient record before creating a new chart.",
    );
    expect(testMiddleware.operations).toHaveLength(0);
  });

  it("stores accepted insurance from check_insurance", async () => {
    const state = createState();

    const result = (await check_insurance.execute(
      {
        plan: "Blue Cross",
        coverageType: "medical",
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    )) as Record<string, unknown>;

    expect(result).toEqual({
      status: "accepted",
      plan: "Blue Cross Blue Shield",
    });
    expect(result).not.toHaveProperty("callerMessage");
    expect(result).not.toHaveProperty("canProceed");
    expect(result).not.toHaveProperty("callerFacingPlan");
    expect(result).not.toHaveProperty("canonicalPlan");
    expect(result).not.toHaveProperty("outcome");
    expect(result).not.toHaveProperty("facts");
    expect(result).not.toHaveProperty("retryable");
    expect(state.insurance.lastEligibilityCheck).toEqual({
      plan: "Blue Cross",
      canonicalPlan: "Florida Blue",
      coverageType: "medical",
      currentCarrier: "Blue Cross Blue Shield",
      accepted: true,
    });
    expect(state.workflow.current).toBeUndefined();
  });

  it("returns a staff-transfer result for preauth-required insurance checks", async () => {
    const state = createState();
    state.office.activeKey = "hollywood";

    const result = (await check_insurance.execute(
      {
        plan: "United Healthcare Individual Exchange Network (Medical)",
        coverageType: "medical",
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    )) as Record<string, unknown>;

    expect(result).toEqual({
      status: "needs_transfer",
      plan: "United Healthcare Individual Exchange Network (Medical)",
      preauthRequired: true,
      message:
        "Prior authorization is required for United Healthcare Individual Exchange Network (Medical). Transfer the caller to staff before scheduling.",
    });
    expect(state.insurance.lastEligibilityCheck).toEqual({
      plan: "United Healthcare Individual Exchange Network (Medical)",
      canonicalPlan: null,
      coverageType: "medical",
      currentCarrier: "United Healthcare Individual Exchange Network (Medical)",
      accepted: false,
    });
  });

  it("passes the checked canonical insurance plan to new patient creation", async () => {
    const state = createState();
    state.identity.patient.patientId = null;
    state.identity.patient.name = null;
    state.identity.patient.identityConfirmed = false;
    markNewPatientPathConfirmed(state);
    state.insurance.onFile = null;
    markSchedulingTriaged(state);
    const middleware = stubCreatePatient(
      createdPatientResult({
        insuranceCarrier: "Florida Blue",
      }),
    );

    await check_insurance.execute(
      {
        plan: "I have Blue Cross",
        coverageType: "medical",
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    await add_patient.execute(
      {
        firstName: "Jane",
        lastName: "Doe",
        dob: "01/01/1980",
        street: "123 Main St",
        aptSuite: "",
        city: "Spring Hill",
        state: "FL",
        zip: "34606",
        sex: "female",
        subscriberName: "Jane Doe",
        insuranceMemberId: "ABC123",
        ssnLast4: "1234",
        inboundPhoneConfirmed: true,
        readBack: true,
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-2" } as never,
    );

    expect(middleware.requests.createPatient[0]?.patient).toMatchObject({
      insurance: "Florida Blue",
      subscriberNum: "ABC123",
    });
    expect(middleware.requests.createPatient[0]?.patient).not.toHaveProperty(
      "ssn",
    );
    expect(state.insurance.onFile).toEqual({
      plan: "Florida Blue",
      canonicalPlan: "Florida Blue",
      coverageType: "medical",
      currentCarrier: "Florida Blue",
    });
    expect(state.insurance.lastEligibilityCheck).toBeNull();
    expect(state.workflow.current).toEqual({
      intent: "schedule",
      appointmentLane: "medical_md",
    });
  });

  it("passes patient SSN last 4 to new patient creation for routine vision", async () => {
    const state = createState();
    state.identity.patient.patientId = null;
    state.identity.patient.name = null;
    state.identity.patient.identityConfirmed = false;
    markNewPatientPathConfirmed(state);
    state.insurance.onFile = null;
    markSchedulingTriaged(state, "routine_od");
    const middleware = stubCreatePatient(
      createdPatientResult({
        insuranceCarrier: "VSP",
        routing: "optical_only",
      }),
    );

    await check_insurance.execute(
      {
        plan: "VSP",
        coverageType: "routine_vision",
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    await add_patient.execute(
      {
        firstName: "Jane",
        lastName: "Doe",
        dob: "01/01/1980",
        street: "123 Main St",
        aptSuite: "",
        city: "Spring Hill",
        state: "FL",
        zip: "34606",
        sex: "female",
        subscriberName: "Jane Doe",
        insuranceMemberId: "VSP123",
        ssnLast4: "1234",
        inboundPhoneConfirmed: true,
        readBack: true,
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-2" } as never,
    );

    expect(middleware.requests.createPatient[0]?.patient).toMatchObject({
      insurance: "VSP",
      subscriberNum: "VSP123",
      coverageType: "routine_vision",
      ssn: "1234",
    });
    expect(state.insurance.onFile).toEqual({
      plan: "VSP",
      canonicalPlan: "VSP",
      coverageType: "routine_vision",
      currentCarrier: "VSP",
    });
    expect(state.insurance.lastEligibilityCheck).toBeNull();
    expect(state.workflow.current).toEqual({
      intent: "schedule",
      appointmentLane: "routine_od",
    });
  });

  it("creates a chart when new-chart confirmation follows an accepted insurance check", async () => {
    const state = createState();
    state.office.activeKey = "hollywood";
    state.identity.patient.patientId = null;
    state.identity.patient.name = null;
    state.identity.patient.identityConfirmed = false;
    state.insurance.onFile = null;
    markSchedulingTriaged(state);
    const middleware = stubCreatePatient(
      createdPatientResult({
        name: "Maria Santos",
        insuranceCarrier: "United Healthcare",
      }),
    );
    const params = {
      firstName: "Maria",
      lastName: "Santos",
      dob: "01/01/1980",
      street: "123 Main St",
      aptSuite: "",
      city: "Spring Hill",
      state: "FL",
      zip: "34606",
      sex: "female" as const,
      subscriberName: "Maria Santos",
      insuranceMemberId: "ABC123",
      inboundPhoneConfirmed: true,
      readBack: true,
    };

    await check_insurance.execute(
      {
        plan: "United Healthcare",
        coverageType: "medical",
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    const prematureResult = await add_patient.execute(params, {
      ctx: createToolContext(state) as never,
      toolCallId: "tool-2",
    } as never);
    expect(prematureResult).toBe(
      "Before creating a new chart, ask whether the patient is already registered with us and call resolve_patient with registrationStatus not_registered after the caller confirms they are not registered.",
    );

    await resolve_patient.execute({ registrationStatus: "not_registered" }, {
      ctx: createToolContext(state) as never,
      toolCallId: "tool-3",
    } as never);
    const result = await add_patient.execute(params, {
      ctx: createToolContext(state) as never,
      toolCallId: "tool-4",
    } as never);

    expect(result).toBe(
      "Created a patient chart for Maria Santos. Continue with scheduling.",
    );
    expect(middleware.requests.createPatient).toHaveLength(1);
    expect(middleware.requests.createPatient[0]?.patient).toMatchObject({
      insurance: "United Healthcare",
      subscriberNum: "ABC123",
    });
    expect(state.insurance.onFile).toEqual({
      plan: "United Healthcare",
      canonicalPlan: "United Healthcare",
      coverageType: "medical",
      currentCarrier: "United Healthcare",
    });
    expect(state.insurance.lastEligibilityCheck).toBeNull();
  });

  it("treats duplicate add_patient after successful chart creation as already done", async () => {
    const state = createState();
    state.identity.patient.patientId = null;
    state.identity.patient.name = null;
    state.identity.patient.identityConfirmed = false;
    markNewPatientPathConfirmed(state);
    markSchedulingTriaged(state);
    markAcceptedInsurance(state);
    const middleware = stubCreatePatient(createdPatientResult());
    const params = {
      firstName: "Jane",
      lastName: "Doe",
      dob: "01/01/1980",
      street: "123 Main St",
      aptSuite: "",
      city: "Spring Hill",
      state: "FL",
      zip: "34606",
      sex: "female" as const,
      subscriberName: "Jane Doe",
      insuranceMemberId: "self pay",
      inboundPhoneConfirmed: true,
      readBack: true,
    };

    await add_patient.execute(params, {
      ctx: createToolContext(state) as never,
      toolCallId: "tool-1",
    } as never);
    const result = await add_patient.execute(params, {
      ctx: createToolContext(state) as never,
      toolCallId: "tool-2",
    } as never);

    expect(result).toBe(
      "Patient chart is already created for Jane Doe. Continue with scheduling.",
    );
    expect(middleware.requests.createPatient).toHaveLength(1);
  });

  it("keeps canonical insurance internal for caller-facing alias responses", async () => {
    const state = createState();

    const result = (await check_insurance.execute(
      {
        plan: "Ambetter",
        coverageType: "routine_vision",
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    )) as Record<string, unknown>;

    expect(result).toEqual({
      status: "accepted",
      plan: "Ambetter",
    });
    expect(result).not.toHaveProperty("callerMessage");
    expect(result).not.toHaveProperty("canonicalPlan");
    expect(state.insurance.lastEligibilityCheck).toEqual({
      plan: "Ambetter",
      canonicalPlan: "Envolve",
      coverageType: "routine_vision",
      currentCarrier: "Ambetter",
      accepted: true,
    });
  });

  it("accepts Simply Healthcare for routine vision checks", async () => {
    const state = createState();
    state.office.activeKey = "hollywood";

    const result = (await check_insurance.execute(
      {
        plan: "Simply Healthcare Medicaid",
        coverageType: "routine_vision",
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    )) as Record<string, unknown>;

    expect(result).toEqual({
      status: "accepted",
      plan: "Simply Healthcare Medicaid",
    });
    expect(result).not.toHaveProperty("callerMessage");
    expect(result).not.toHaveProperty("canonicalPlan");
    expect(state.insurance.lastEligibilityCheck).toEqual({
      plan: "Simply Healthcare Medicaid",
      canonicalPlan: "iCare",
      coverageType: "routine_vision",
      currentCarrier: "Simply Healthcare Medicaid",
      accepted: true,
    });
  });

  it("rejects medical insurance checks for North Miami Beach Optical", async () => {
    const state = createState();
    state.office.activeKey = "north-miami-beach-optical";

    const result = (await check_insurance.execute(
      {
        plan: "Humana PPO",
        coverageType: "medical",
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    )) as Record<string, unknown>;

    expect(result).toEqual({
      status: "not_accepted",
      plan: "Humana PPO",
    });
    expect(state.insurance.lastEligibilityCheck).toEqual({
      plan: "Humana PPO",
      canonicalPlan: null,
      coverageType: "medical",
      currentCarrier: "Humana PPO",
      accepted: false,
    });
  });

  it("keeps Crystal River insurance denial scoped to the active office", async () => {
    const state = createState();
    state.office.activeKey = "crystal-river";

    const result = (await check_insurance.execute(
      {
        plan: "Humana PPO",
        coverageType: "medical",
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    )) as Record<string, unknown>;

    expect(result).toMatchObject({
      status: "not_accepted",
      plan: "Humana PPO",
    });
    expect(result).not.toHaveProperty("acceptedAtAlternateOffice");
    expect(result).not.toHaveProperty("alternatePlan");
    expect(result).not.toHaveProperty("routeTool");
    expect(result).not.toHaveProperty("canonicalPlan");
    expect(result).not.toHaveProperty("callerMessage");
    expect(result).not.toHaveProperty("canProceed");
    expect(result).not.toHaveProperty("callerFacingPlan");
    expect(state.insurance.lastEligibilityCheck).toMatchObject({
      plan: "Humana PPO",
      canonicalPlan: null,
      coverageType: "medical",
      currentCarrier: "Humana PPO",
      accepted: false,
    });
  });

  it("does not accept routine vision insurance for Crystal River", async () => {
    const state = createState();
    state.office.activeKey = "crystal-river";

    const result = await check_insurance.execute(
      {
        plan: "Aetna",
        coverageType: "routine_vision",
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    expect(result).toEqual({
      status: "not_accepted",
      plan: "Aetna",
    });
    expect(state.insurance.lastEligibilityCheck).toMatchObject({
      plan: "Aetna",
      canonicalPlan: null,
      coverageType: "routine_vision",
      currentCarrier: "Aetna",
      accepted: false,
    });
  });

  it("updates insurance from the canonical checked medical plan in session state", async () => {
    const state = createState();
    state.insurance.onFile = {
      plan: "Old Plan",
      canonicalPlan: "Old Plan",
      coverageType: "medical",
      currentCarrier: "Old Plan",
    };
    state.insurance.lastEligibilityCheck = {
      plan: "UnitedHealthcare",
      canonicalPlan: "United Healthcare",
      coverageType: "medical",
      currentCarrier: "UnitedHealthcare",
      accepted: true,
    };
    state.identity.patientBackend = {
      insPlanId: "ins-old",
      respPartyId: "resp-1",
    };
    const ctx = createToolContext(state);
    const middleware = stubInsuranceUpdate(
      updatedInsuranceResult({
        newInsurance: "United Healthcare",
        routing: "bach_only",
        allowedProviders: ["Dr. Bach"],
        preauthRequired: true,
      }),
    );

    const result = await update_insurance.execute(
      {
        insuranceMemberId: "ABC123",
      },
      { ctx: ctx as never, toolCallId: "tool-1" } as never,
    );

    expect(ctx.speechHandle.allowInterruptions).toBe(false);
    expect(result).toBe("Updated insurance to United Healthcare.");
    expect(middleware.requests.updateInsurance[0]?.update).toMatchObject({
      patientId: "patient-1",
      dob: "01/01/1980",
      insPlanId: "ins-old",
      respPartyId: "resp-1",
      oldInsurance: "Old Plan",
      insurance: "United Healthcare",
      coverageType: "medical",
      subscriberNum: "ABC123",
    });
    expect(middleware.requests.updateInsurance[0]?.update).not.toHaveProperty(
      "subscriberName",
    );
    expect(state.insurance.onFile).toEqual({
      plan: "United Healthcare",
      canonicalPlan: "United Healthcare",
      coverageType: "medical",
      currentCarrier: "United Healthcare",
    });
    expect(state.insurance.lastEligibilityCheck).toBeNull();
    expect(state.identity.patientBackend).toEqual({
      insPlanId: null,
      respPartyId: "resp-1",
    });
    expect(state.workflow.routing.routing).toBe("bach_only");
    expect(state.workflow.routing.allowedProviders).toEqual(["Dr. Bach"]);
    expect(state.workflow.routing.preauthRequired).toBe(true);
    expect(state.availability.slots).toEqual([]);
  });

  it("updates routine vision insurance with the canonical checked plan", async () => {
    const state = createState();
    state.office.activeKey = "hollywood";
    state.insurance.onFile = null;
    state.insurance.lastEligibilityCheck = {
      plan: "Sunshine Health",
      canonicalPlan: "Envolve",
      coverageType: "routine_vision",
      currentCarrier: "Sunshine",
      accepted: true,
    };
    state.identity.patientBackend = {
      insPlanId: null,
      respPartyId: "resp-1",
    };
    const middleware = stubInsuranceUpdate(
      updatedInsuranceResult({
        newInsurance: "Envolve",
        routing: "optical_only",
      }),
    );

    const result = await update_insurance.execute(
      {
        insuranceMemberId: "946-327-2674",
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    expect(result).toBe("Updated insurance to Envolve.");
    expect(middleware.requests.updateInsurance[0]?.update).toMatchObject({
      patientId: "patient-1",
      dob: "01/01/1980",
      insPlanId: "",
      respPartyId: "resp-1",
      oldInsurance: "",
      insurance: "Envolve",
      coverageType: "routine_vision",
      subscriberNum: "946-327-2674",
    });
    expect(state.insurance.onFile).toEqual({
      plan: "Envolve",
      canonicalPlan: "Envolve",
      coverageType: "routine_vision",
      currentCarrier: "Envolve",
    });
    expect(state.insurance.lastEligibilityCheck).toBeNull();
    expect(state.identity.patientBackend).toEqual({
      insPlanId: null,
      respPartyId: "resp-1",
    });
    expect(state.workflow.routing.routing).toBe("optical_only");
    expect(state.workflow.routing.allowedProviders).toEqual([]);
    expect(state.workflow.routing.preauthRequired).toBe(false);
    expect(state.availability.slots).toEqual([]);
  });

  it("treats middleware update-insurance failures as tool errors", async () => {
    const state = createState();
    state.insurance.onFile = null;
    state.insurance.lastEligibilityCheck = {
      plan: "Sunshine Health",
      canonicalPlan: "Envolve",
      coverageType: "routine_vision",
      currentCarrier: "Sunshine",
      accepted: true,
    };
    stubInsuranceUpdate({
      status: "error",
      reason: "middleware_error",
    });

    await expect(
      update_insurance.execute(
        {
          insuranceMemberId: "946-327-2674",
        },
        {
          ctx: createToolContext(state) as never,
          toolCallId: "tool-1",
        } as never,
      ),
    ).rejects.toThrow("Insurance was not updated.");
    expect(state.insurance.onFile).toBeNull();
    expect(ownedMiddlewareFailures(state)).toMatchObject([
      { operation: "updateInsurance", reason: "middleware_error" },
    ]);
  });

  it("uses explicit self pay as the member ID sentinel", async () => {
    const state = createState();
    state.insurance.lastEligibilityCheck = {
      plan: "Self Pay",
      canonicalPlan: "Self Pay",
      coverageType: "medical",
      currentCarrier: "Self Pay",
      accepted: true,
    };
    const middleware = stubInsuranceUpdate(
      updatedInsuranceResult({
        newInsurance: "Self Pay",
      }),
    );

    const result = await update_insurance.execute(
      { insuranceMemberId: "self pay" },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    );

    expect(result).toBe("Updated insurance to Self Pay.");
    expect(middleware.requests.updateInsurance[0]?.update).toMatchObject({
      insurance: "Self Pay",
      subscriberNum: "self pay",
    });
  });
});
