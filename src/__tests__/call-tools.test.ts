import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolError } from "@livekit/agents";

import {
  setOwnedMiddleware,
  type CreatePatientResult,
  type PatientResolveResult,
  type UpdateInsuranceResult,
} from "../clients/owned-middleware.js";
import {
  CALLER_CANDIDATE_REF,
  type PreCallPatientCandidate,
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
import { createResolvePatientTool } from "../tools/resolve-patient.js";
import { createConfirmedPatientState } from "./support/call-state.js";
import { deferredResult } from "./support/deferred-result.js";
import {
  InMemoryOwnedMiddleware,
  type InMemoryOwnedMiddlewareResponses,
} from "./support/owned-middleware.js";

type TestCallState = ReturnType<typeof createConfirmedPatientState>;
type PreCallCandidate = PreCallPatientCandidate;
let testMiddleware: InMemoryOwnedMiddleware;

function createState(): TestCallState {
  const state = createConfirmedPatientState();
  state.availability.slots = [
    {
      slotId: "S1",
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
  state.identity.activePatient = null;
  state.identity.registration = {};
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
  state.identity.activePatient = null;
  state.identity.registration = null;
}

function preCallCandidate(
  overrides: Partial<PreCallCandidate> = {},
): PreCallCandidate {
  return {
    status: "verified",
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
  state.identity.privateCandidates = [preCallCandidate()];
}

function setMultiplePreCallCandidates(
  state: TestCallState,
  candidates: PreCallCandidate[],
) {
  state.identity.privateCandidates = candidates;
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
    ]);
  });

  it("creates directly from explicit new-patient confirmation", async () => {
    const state = createState();
    setPatientUnknown(state);
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
        newPatientConfirmed: true,
        readBack: true,
      },
      { ctx: ctx as never, toolCallId: "tool-1" } as never,
    );

    expect(ctx.speechHandle.allowInterruptions).toBe(false);
    expect(result).toBe(
      "Created a patient chart for Jane Doe. Continue with scheduling.",
    );
    expect(state.identity.activePatient!.patientId).toBe("patient-new");
    expect(state.identity.activePatient!.kind).toBe("created");
    expect(state.identity.activePatient!.dob).toBe("01/01/1980");
    expect(state.identity.activePatient!.phone).toBe("+17275551212");
    expect(state.insurance.onFile).toEqual({
      plan: "self pay",
      canonicalPlan: "self pay",
      coverageType: "medical",
      currentCarrier: "self pay",
    });
    expect(state.insurance.lastEligibilityCheck).toBeNull();
    expect(state.workflow.current).toBeUndefined();
    expect(middleware.requests.createPatient[0]?.patient).toMatchObject({
      firstName: "Jane",
      lastName: "Doe",
      phone: "+17275551212",
      insurance: "self pay",
      subscriberNum: "self pay",
    });
    expect(middleware.operations.map(({ name }) => name)).toEqual([
      "createPatient",
    ]);
  });

  it("surfaces a failed chart creation as a recoverable tool error", async () => {
    const state = createState();
    setPatientUnknown(state);
    markSchedulingTriaged(state);
    markAcceptedInsurance(state);
    stubCreatePatient({ status: "error", reason: "middleware_error" });

    await expect(
      add_patient.execute(
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
          inboundPhoneConfirmed: true,
          newPatientConfirmed: true,
          readBack: true,
        },
        {
          ctx: createToolContext(state) as never,
          toolCallId: "tool-1",
        } as never,
      ),
    ).rejects.toThrow(
      "I couldn't create the patient chart. I can try once more or connect you with the office.",
    );
    expect(ownedMiddlewareFailures(state)).toMatchObject([
      { operation: "createPatient", reason: "middleware_error" },
    ]);
  });

  it("leaves a malformed chart-creation response as an internal error", async () => {
    const state = createState();
    setPatientUnknown(state);
    markSchedulingTriaged(state);
    markAcceptedInsurance(state);
    stubCreatePatient({ status: "error", reason: "invalid_response" });

    const failure = add_patient.execute(
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
        inboundPhoneConfirmed: true,
        newPatientConfirmed: true,
        readBack: true,
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    );

    await expect(failure).rejects.toThrow(
      "Owned Middleware returned a non-retryable failure.",
    );
    await expect(failure).rejects.not.toBeInstanceOf(ToolError);
  });

  it("does not activate a chart creation receipt for a different patient", async () => {
    const state = createState();
    setPatientUnknown(state);
    markSchedulingTriaged(state);
    markAcceptedInsurance(state);
    stubCreatePatient(
      createdPatientResult({
        patientId: "patient-wrong",
        name: "Anna Doe",
        dob: "01/01/1980",
      }),
    );

    const failure = add_patient.execute(
      {
        firstName: "Ana",
        lastName: "Doe",
        dob: "01/01/1980",
        street: "123 Main St",
        city: "Spring Hill",
        state: "FL",
        zip: "34606",
        sex: "female",
        subscriberName: "Ana Doe",
        insuranceMemberId: "self pay",
        inboundPhoneConfirmed: true,
        newPatientConfirmed: true,
        readBack: true,
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    );

    await expect(failure).resolves.toBe(
      "A patient chart was created, but its identity receipt did not match the current registration. Do not create another chart. Connect the caller to office staff to verify the chart.",
    );
    expect(state.identity.activePatient).toBeNull();
    expect(state.identity.registration).toEqual({
      firstName: "Ana",
      lastName: "Doe",
      dob: "01/01/1980",
    });
  });

  it("does not retry a created chart when identity evidence is missing", async () => {
    const state = createState();
    setPatientUnknown(state);
    markSchedulingTriaged(state);
    markAcceptedInsurance(state);
    stubCreatePatient(
      createdPatientResult({
        name: null,
        dob: null,
      }),
    );

    await expect(
      add_patient.execute(
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
          inboundPhoneConfirmed: true,
          newPatientConfirmed: true,
          readBack: true,
        },
        {
          ctx: createToolContext(state) as never,
          toolCallId: "tool-1",
        } as never,
      ),
    ).resolves.toBe(
      "A patient chart was created, but its identity receipt did not match the current registration. Do not create another chart. Connect the caller to office staff to verify the chart.",
    );
    expect(state.identity.activePatient).toBeNull();
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
          newPatientConfirmed: true,
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
      expect(state.identity.activePatient!).toMatchObject({
        kind: "existing",
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
      newPatientConfirmed: true,
      readBack: true,
    };

    const pendingCreation = add_patient.execute(params, {
      ctx: createToolContext(state) as never,
      toolCallId: "tool-1",
    } as never);
    const resolution = resolve_patient.execute(
      { firstName: "John", lastName: "Doe", dob: "02/02/1982" },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-2",
      } as never,
    );
    deferred.resolve(createdPatientResult());

    await expect(resolution).rejects.toThrow(
      "Patient lookup failed. Try again.",
    );
    await expect(pendingCreation).resolves.toBe(
      "Created a patient chart for Jane Doe. Continue with scheduling.",
    );
    expect(state.identity.activePatient!).toMatchObject({
      kind: "created",
      patientId: "patient-new",
      name: "Jane Doe",
    });
    expect(state.identity.registration).toBeNull();
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

  it("invalidates pending chart creation when a prefix-related new patient is named", async () => {
    const creation = deferredResult<CreatePatientResult>();
    const state = createState();
    markNewPatientPathConfirmed(state);
    markSchedulingTriaged(state);
    markAcceptedInsurance(state);
    storeAvailabilityBookingToken(state, "S1", "private-token");
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
        newPatientConfirmed: true,
        readBack: true,
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    );
    const newPatient = await add_patient.execute(
      {
        firstName: "Janet",
        lastName: "Doe",
        dob: "01/01/1980",
        street: "123 Main St",
        city: "Spring Hill",
        state: "FL",
        zip: "34606",
        sex: "female",
        subscriberName: "Janet Doe",
        insuranceMemberId: "self pay",
        phone: "7275551212",
        newPatientConfirmed: true,
        readBack: true,
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-2",
      } as never,
    );
    creation.resolve(createdPatientResult());

    expect(newPatient).toBe(
      "Run check_insurance for accepted medical or routine-vision coverage before creating a patient chart.",
    );
    await expect(pendingCreation).resolves.toBe(
      "Created a patient chart for Jane Doe, but the active patient changed before the result returned. Do not create another chart. Continue with the current patient's state.",
    );
    expect(state.identity.activePatient).toBeNull();
    expect(state.identity.registration).toEqual({
      firstName: "Janet",
      lastName: "Doe",
      dob: "01/01/1980",
    });
    expect(state.workflow.current).toBeUndefined();
    expect(state.availability.bookingTokensBySlotId).toEqual({});
    expect(state.insurance.lastEligibilityCheck).toBeNull();
    expect(middleware.operations.map(({ name }) => name)).toEqual([
      "createPatient",
    ]);
  });

  it("keeps a partially created chart active without claiming insurance was attached", async () => {
    const state = createState();
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
      newPatientConfirmed: true,
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
    expect(state.identity.activePatient!).toMatchObject({
      kind: "created",
      patientId: "patient-new",
      dob: "01/01/1980",
      phone: "+17275551212",
    });
    expect(state.insurance.onFile).toBeNull();
    expect(middleware.requests.createPatient).toHaveLength(1);
  });

  it("requires explicit new-patient confirmation before creating a chart", async () => {
    const state = createState();
    setPatientUnknown(state);
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
      "Before creating a new chart, ask the caller to confirm that the patient has never registered with or been added to the practice. Call add_patient again with newPatientConfirmed set to true only after the caller confirms.",
    );
    expect(ctx.speechHandle.allowInterruptions).toBe(false);
    expect(ctx.disallowInterruptions).toHaveBeenCalledOnce();
    expect(testMiddleware.operations).toHaveLength(0);
    expect(state.identity.activePatient).toBeNull();
    expect(state.identity.registration).toBeNull();
  });

  it("marks a created chart as new-patient state when middleware omits status", async () => {
    const state = createState();
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
        newPatientConfirmed: true,
        readBack: true,
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    );

    expect(state.identity.activePatient!.kind).toBe("created");
    expect(state.insurance.onFile).toEqual({
      plan: "self pay",
      canonicalPlan: "self pay",
      coverageType: "medical",
      currentCarrier: "self pay",
    });
    expect(state.insurance.lastEligibilityCheck).toBeNull();
  });

  it("does not reactivate a private candidate after explicit new registration", async () => {
    const state = createState();
    setSingleArshedPreCallCandidate(state);
    state.identity.registration = {
      firstName: "Lisa",
      lastName: "Arshed",
      dob: "10/03/2020",
    };
    markSchedulingTriaged(state);
    state.insurance.lastEligibilityCheck = {
      plan: "Florida Blue Shield",
      canonicalPlan: "Florida Blue Shield",
      coverageType: "routine_vision",
      currentCarrier: "Florida Blue Shield",
      accepted: true,
    };
    const middleware = stubCreatePatient(
      createdPatientResult({
        name: "Lisa Arshed",
        dob: "10/03/2020",
        insuranceCarrier: "Florida Blue Shield",
        routing: "optical_only",
      }),
    );

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
        ssnLast4Unavailable: true,
        inboundPhoneConfirmed: true,
        newPatientConfirmed: true,
        readBack: true,
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    );

    expect(result).toBe(
      "Created a patient chart for Lisa Arshed. Continue with scheduling.",
    );
    expect(state.identity.activePatient).toMatchObject({
      kind: "created",
      name: "Lisa Arshed",
    });
    expect(state.identity.registration).toBeNull();
    expect(middleware.requests.createPatient[0]?.patient).not.toHaveProperty(
      "ssn",
    );
  });

  it("requires an accepted insurance check before creating a patient", async () => {
    const state = createState();
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
        newPatientConfirmed: true,
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
        newPatientConfirmed: true,
        readBack: true,
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    );

    expect(result).toBe(
      "Eye Radiance handles medical eye care, including cataract evaluations. Route routine eye exams, glasses prescriptions, and contact lens prescriptions through a routine-vision office.",
    );
    expect(state.office.activeKey).toBe("crystal-river");
    expect(state.office.phoneOverrides).not.toHaveProperty("spring-hill");
    expect(testMiddleware.operations).toHaveLength(0);
  });

  it("creates a self-pay routine-vision chart without requesting SSN", async () => {
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
      newPatientConfirmed: true,
      readBack: true,
    };

    const routineState = createState();
    markNewPatientPathConfirmed(routineState);
    clearSchedulingContext(routineState);
    markAcceptedInsurance(routineState, {
      plan: "self pay",
      canonicalPlan: "self pay",
      coverageType: "routine_vision",
    });
    const middleware = stubCreatePatient(
      createdPatientResult({ routing: "optical_only" }),
    );

    await expect(
      add_patient.execute(baseParams, {
        ctx: createToolContext(routineState) as never,
        toolCallId: "tool-1",
      } as never),
    ).resolves.toBe(
      "Created a patient chart for Jane Doe. Continue with scheduling.",
    );

    expect(middleware.requests.createPatient[0]?.patient).toMatchObject({
      coverageType: "routine_vision",
    });
    expect(middleware.requests.createPatient[0]?.patient).not.toHaveProperty(
      "ssn",
    );
  });

  it("asks an insured routine-vision caller once when SSN status is unknown", async () => {
    const state = createState();
    markNewPatientPathConfirmed(state);
    clearSchedulingContext(state);
    markAcceptedInsurance(state, {
      plan: "VSP",
      canonicalPlan: "VSP",
      coverageType: "routine_vision",
    });
    stubCreatePatient(createdPatientResult({ routing: "optical_only" }));

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
        insuranceMemberId: "VSP123",
        phone: "7275551212",
        newPatientConfirmed: true,
        readBack: true,
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    expect(result).toBe(
      "Ask the caller once for the patient's SSN last four. If they decline or are unsure, call add_patient again with ssnLast4Unavailable set to true. Request only the last four digits.",
    );
    expect(testMiddleware.operations).toHaveLength(0);
  });

  it("creates an insured routine-vision chart after SSN is declined", async () => {
    const state = createState();
    markNewPatientPathConfirmed(state);
    clearSchedulingContext(state);
    markAcceptedInsurance(state, {
      plan: "VSP",
      canonicalPlan: "VSP",
      coverageType: "routine_vision",
    });
    const middleware = stubCreatePatient(
      createdPatientResult({ routing: "optical_only" }),
    );

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
        insuranceMemberId: "VSP123",
        ssnLast4Unavailable: true,
        phone: "7275551212",
        newPatientConfirmed: true,
        readBack: true,
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-2" } as never,
    );

    expect(result).toBe(
      "Created a patient chart for Jane Doe. Continue with scheduling.",
    );
    expect(middleware.requests.createPatient[0]?.patient).toMatchObject({
      coverageType: "routine_vision",
    });
    expect(middleware.requests.createPatient[0]?.patient).not.toHaveProperty(
      "ssn",
    );
  });

  it("requires read-back confirmation before creating a patient", async () => {
    const state = createState();
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
        newPatientConfirmed: true,
      },
      { ctx: ctx as never, toolCallId: "tool-1" } as never,
    );

    expect(result).toBe(
      "Read back the new patient details first: patient name, date of birth, sex, address, callback phone, email if provided, insurance plan, policyholder name, and member ID. Call add_patient again only after the caller confirms the details are correct.",
    );
    expect(testMiddleware.operations).toHaveLength(0);
    expect(ctx.speechHandle.allowInterruptions).toBe(false);
  });

  it("confirms a provided SSN last four without repeating the digits", async () => {
    const state = createState();
    markNewPatientPathConfirmed(state);
    markSchedulingTriaged(state, "routine_od");
    markAcceptedInsurance(state, {
      plan: "VSP",
      canonicalPlan: "VSP",
      coverageType: "routine_vision",
    });

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
        insuranceMemberId: "VSP123",
        ssnLast4: "1234",
        phone: "7275551212",
        newPatientConfirmed: true,
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    expect(result).toBe(
      "Read back the new patient details first: patient name, date of birth, sex, address, callback phone, email if provided, insurance plan, policyholder name, and member ID. Confirm that the SSN last four was captured without repeating the digits. Call add_patient again only after the caller confirms the details are correct.",
    );
    expect(result).not.toContain("1234");
    expect(testMiddleware.operations).toHaveLength(0);
  });

  it("asks before using the inbound caller phone for a new patient chart", async () => {
    const state = createState();
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
        newPatientConfirmed: true,
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
        newPatientConfirmed: true,
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
    setPatientUnknown(state);
    const middleware = stubPatient(
      verifiedPatientResult({
        appointmentsStatus: "found",
        appointments: [
          {
            id: 123,
            date: "July 27, 2026",
            time: "9:00 AM",
            provider: "Dr. Bach",
            type: "Office Visit",
            facility: "Spring Hill",
            confirmed: false,
            cancellationToken: "private-cancellation-token",
            rescheduleToken: "private-reschedule-token",
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
      /^Verified existing patient Jane Doe\. Insurance on file: self pay\. Loaded 1 appointment: Monday, July 27 at 9:00 AM with Dr\. Bach \(appointmentRef appointment-[a-z0-9]+\)\.$/,
    );
    expect(result).not.toContain("123");
    expect(result).not.toContain("private-cancellation-token");
    expect(result).not.toContain("private-reschedule-token");
    expect(state.identity.activePatient!.patientId).toBe("patient-1");
    expect(state.identity.activePatient!.appointments).toEqual([
      expect.objectContaining({
        appointmentRef: expect.stringMatching(/^appointment-[a-z0-9]+$/),
        cancellationToken: "private-cancellation-token",
        rescheduleToken: "private-reschedule-token",
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
    setPatientUnknown(state);
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
            rescheduleToken: "private-reschedule-token-one",
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
            rescheduleToken: "private-reschedule-token-two",
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
    expect(state.identity.activePatient!.appointments).toEqual([
      expect.objectContaining({
        appointmentRef: expect.stringMatching(/^appointment-[a-z0-9]+$/),
        cancellationToken: "private-token-one",
        rescheduleToken: "private-reschedule-token-one",
      }),
      expect.objectContaining({
        appointmentRef: expect.stringMatching(/^appointment-[a-z0-9]+$/),
        cancellationToken: "private-token-two",
        rescheduleToken: "private-reschedule-token-two",
      }),
    ]);
    expect(middleware.requests.resolvePatient).toHaveLength(1);
  });

  it("presents all loaded appointment references instead of hiding extra choices", async () => {
    const state = createState();
    setPatientUnknown(state);
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
    storeAvailabilityBookingToken(state, "S1", "stale-token");
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
      "Switched active patient to John Doe. Insurance on file: Aetna. No upcoming appointments are loaded. Check availability again before booking.",
    );
    expect(middleware.requests.resolvePatient[0]).toMatchObject({
      identity: {
        firstName: "John",
        lastName: "Doe",
        dob: "02/02/1982",
      },
      office: "+13523202007",
    });
    expect(state.identity.activePatient!.patientId).toBe("patient-2");
    expect(state.workflow.current).toBeUndefined();
    expect(state.office.activeKey).toBe("crystal-river");
    expect(state.availability.slots).toEqual([]);
    expect(state.availability.bookingTokensBySlotId).toEqual({});
    expect(state.identity.latestBookedAppointmentId).toBeUndefined();
    expect(state.insurance.lastEligibilityCheck).toBeNull();
  });

  it("clearly reports verified existing patients without insurance on file", async () => {
    const state = createState();
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
      "Verified existing patient TEST,CHASE. No upcoming appointments are loaded.",
    );
    expect(state.identity.activePatient!.patientId).toBe("patient-1");
    expect(state.identity.activePatient!.kind).toBe("existing");
    expect(state.insurance.onFile).toBeNull();
    expect(state.insurance.lastEligibilityCheck).toBeNull();
  });

  it("does not activate a verified lookup receipt for a different identity", async () => {
    const state = createState();
    setPatientUnknown(state);
    stubPatient(
      verifiedPatientResult({
        patientId: "patient-wrong",
        name: "ANNA,DOE",
        dob: "01/01/1980",
      }),
    );

    const result = resolve_patient.execute(
      {
        firstName: "Ana",
        lastName: "Doe",
        dob: "01/01/1980",
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    await expect(result).rejects.toThrow(
      "Owned Middleware returned a non-retryable failure.",
    );
    expect(state.identity.activePatient).toBeNull();
    expect(state.runtime.patientIdentityOutcomes).toEqual(["lookup_failed"]);
  });

  it("keeps a private candidate inactive after a full lookup finds no patient", async () => {
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
      "No matching patient was found. Confirm the spelling and date of birth, or ask whether the patient is already registered with us.",
    );
    expect(middleware.requests.resolvePatient[0]).toMatchObject({
      identity: {
        firstName: "Lisa",
        lastName: "Arshed",
        dob: "10/03/2020",
      },
    });
    expect(state.identity.privateCandidates).toHaveLength(1);
    expect(state.identity.activePatient).toBeNull();
  });

  it("preserves lookup failures instead of using the pre-call spelling fallback", async () => {
    const state = createState();
    setSingleArshedPreCallCandidate(state);
    stubPatient({
      status: "error",
      reason: "middleware_error",
    });

    await expect(
      resolve_patient.execute(
        {
          firstName: "Lisa",
          lastName: "Arshed",
          dob: "10/03/2020",
        },
        {
          ctx: createToolContext(state) as never,
          toolCallId: "tool-1",
        } as never,
      ),
    ).rejects.toThrow("Patient lookup failed. Try again.");
    expect(state.identity.privateCandidates).toHaveLength(1);
    expect(state.identity.activePatient).toBeNull();
    expect(ownedMiddlewareFailures(state)).toMatchObject([
      { operation: "resolvePatient", reason: "middleware_error" },
    ]);
  });

  it("leaves an invalid patient response as an internal error", async () => {
    const state = createState();
    setSingleArshedPreCallCandidate(state);
    stubPatient({ status: "error", reason: "invalid_response" });

    const failure = resolve_patient.execute(
      {
        firstName: "Lisa",
        lastName: "Arshed",
        dob: "10/03/2020",
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    );

    await expect(failure).rejects.toThrow(
      "Owned Middleware returned a non-retryable failure.",
    );
    await expect(failure).rejects.not.toBeInstanceOf(ToolError);
  });

  it("records a lookup outcome when identity resolution throws early", async () => {
    const state = createState();
    const tool = createResolvePatientTool(async () => {
      throw new Error("unexpected lookup failure");
    });

    await expect(
      tool.execute(
        {
          firstName: "Different",
          lastName: "Patient",
          dob: "01/01/1980",
        },
        {
          ctx: createToolContext(state) as never,
          toolCallId: "tool-1",
        } as never,
      ),
    ).rejects.toThrow("unexpected lookup failure");
    expect(state.runtime.patientIdentityOutcomes).toEqual(["lookup_failed"]);
  });

  it("contains a rejected private-candidate hydration within resolve_patient", async () => {
    const state = createState();
    setPatientUnknown(state);
    state.identity.privateCandidates = [
      {
        status: "candidate",
        ref: "precall:1",
        patientId: "patient-private",
        firstName: "Jane",
        lastName: "Doe",
        dob: "01/01/1980",
        appointments: [],
      },
    ];
    const tool = createResolvePatientTool(async () => {
      throw new Error("candidate hydration failed");
    });

    await expect(
      tool.execute({ firstName: "Jane" }, {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never),
    ).rejects.toThrow("candidate hydration failed");
    expect(state.identity.activePatient).toBeNull();
    expect(state.runtime.patientIdentityOutcomes).toEqual(["lookup_failed"]);
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
    expect(state.identity.activePatient!.kind).toBe("existing");
    expect(state.identity.activePatient!.patientId).toBe("patient-ella");
  });

  it("switches an active pre-call patient when another preloaded patient is resolved", async () => {
    const state = createState();
    state.identity.activePatient! = {
      ...state.identity.activePatient!,
      kind: "existing",
      patientId: "patient-brandon",
      name: "BRANDON ANDERSON",
      dob: "04/05/2012",
      phone: "+19045550199",
      appointments: [],
      appointmentsStatus: "none",
    };
    setMultiplePreCallCandidates(state, [
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
        insuranceCarrier: "HUMANA",
        routing: undefined,
        allowedProviders: undefined,
      }),
    ]);

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
      "Switched active patient to MONIQUE HAMILTON. Insurance on file: HUMANA. No upcoming appointments are loaded. Check availability again before booking.",
    );
    expect(state.identity.activePatient!.patientId).toBe("patient-monique");
    expect(state.identity.activePatient!.name).toBe("MONIQUE HAMILTON");
    expect(state.identity.activePatient!.phone).toBeNull();
  });

  it("does not clear booking state when resolving the already active pre-call patient", async () => {
    const state = createState();
    state.identity.activePatient! = {
      ...state.identity.activePatient!,
      kind: "existing",
      patientId: "patient-brandon",
      name: "BRANDON ANDERSON",
      dob: "04/05/2012",
      phone: null,
      appointments: [],
      appointmentsStatus: "none",
    };
    setMultiplePreCallCandidates(state, [
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
    ]);
    storeAvailabilityBookingToken(state, "S1", "token-a");
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
    expect(state.availability.slots.map((slot) => slot.slotId)).toEqual(["S1"]);
    expect(state.availability.bookingTokensBySlotId).toEqual({
      S1: "token-a",
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

  it("activates a unique pre-call patient through resolve_patient", async () => {
    const state = createState();
    setSingleArshedPreCallCandidate(state);

    const result = await resolve_patient.execute({ firstName: "Esa" }, {
      ctx: createToolContext(state) as never,
      toolCallId: "tool-1",
    } as never);

    expect(testMiddleware.operations).toHaveLength(0);
    expect(result).toBe(
      "Verified existing patient ESA ARSHED. Insurance on file: Florida Blue Shield. No upcoming appointments are loaded.",
    );
    expect(state.identity.activePatient!.patientId).toBe("patient-esa");
  });

  it("does not call middleware until full identity is provided", async () => {
    const state = createState();

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

  it("does not carry an active patient's insurance check into new-patient registration", async () => {
    const state = createState();
    markSchedulingTriaged(state);
    markAcceptedInsurance(state, {
      plan: "Aetna",
      canonicalPlan: "Aetna",
      coverageType: "medical",
    });

    const result = await add_patient.execute(
      {
        firstName: "Maria",
        lastName: "Santos",
        dob: "01/01/1980",
        street: "123 Main St",
        city: "Spring Hill",
        state: "FL",
        zip: "34606",
        sex: "female",
        subscriberName: "Maria Santos",
        insuranceMemberId: "ABC123",
        phone: "7275551212",
        newPatientConfirmed: true,
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    expect(result).toBe(
      "Run check_insurance for accepted medical or routine-vision coverage before creating a patient chart.",
    );
    expect(state.identity.activePatient).toBeNull();
    expect(state.identity.registration).toEqual({
      firstName: "Maria",
      lastName: "Santos",
      dob: "01/01/1980",
    });
    expect(state.insurance.lastEligibilityCheck).toBeNull();
    expect(testMiddleware.operations).toHaveLength(0);
  });

  it("establishes new-patient state while preserving its accepted insurance check", async () => {
    const state = createState();
    setPatientUnknown(state);
    storeAvailabilityBookingToken(state, "S1", "stale-token");
    state.identity.latestBookedAppointmentId = 123;
    state.insurance.lastEligibilityCheck = {
      plan: "Aetna",
      canonicalPlan: "Aetna",
      coverageType: "medical",
      currentCarrier: "Aetna",
      accepted: true,
    };

    const result = await add_patient.execute(
      {
        firstName: "Maria",
        lastName: "Santos",
        dob: "01/01/1980",
        street: "123 Main St",
        city: "Spring Hill",
        state: "FL",
        zip: "34606",
        sex: "female",
        subscriberName: "Maria Santos",
        insuranceMemberId: "ABC123",
        phone: "7275551212",
        newPatientConfirmed: true,
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    expect(result).toBe(
      "Read back the new patient details first: patient name, date of birth, sex, address, callback phone, email if provided, insurance plan, policyholder name, and member ID. Call add_patient again only after the caller confirms the details are correct.",
    );
    expect(state.identity.activePatient).toBeNull();
    expect(state.identity.registration).toEqual({
      firstName: "Maria",
      lastName: "Santos",
      dob: "01/01/1980",
    });
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
    expect(testMiddleware.operations).toHaveLength(0);
  });

  it("does not create over an active existing patient", async () => {
    const state = createState();

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
        newPatientConfirmed: true,
        readBack: true,
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    expect(result).toBe(
      "The active patient already matches that identity. Continue with the loaded patient instead of creating a new chart.",
    );
    expect(testMiddleware.operations).toHaveLength(0);
    expect(state.identity.activePatient!).toMatchObject({
      kind: "existing",
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
    state.identity.activePatient!.name = "TEST,CHASE";
    state.identity.activePatient!.dob = "01/01/1980";

    const result = await add_patient.execute(
      {
        firstName: "Chase",
        lastName: "Test",
        dob: "01/01/1980",
        street: "123 Main St",
        city: "Spring Hill",
        state: "FL",
        zip: "34606",
        sex: "female",
        subscriberName: "Chase Test",
        insuranceMemberId: "self pay",
        phone: "7275551212",
        newPatientConfirmed: true,
        readBack: true,
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    expect(result).toBe(
      "The active patient already matches that identity. Continue with the loaded patient instead of creating a new chart.",
    );
    expect(testMiddleware.operations).toHaveLength(0);
    expect(state.identity.activePatient!).toMatchObject({
      kind: "existing",
      patientId: "patient-1",
      name: "TEST,CHASE",
      dob: "01/01/1980",
    });
  });

  it("clears patient-scoped state when add_patient starts a different patient", async () => {
    const state = createState();
    storeAvailabilityBookingToken(state, "S1", "private-token");
    state.identity.latestBookedAppointmentId = 123;
    state.workflow.current = {
      intent: "schedule",
      appointmentLane: "medical_md",
    };
    state.office.activeKey = "hollywood";

    const result = await add_patient.execute(
      {
        firstName: "John",
        lastName: "Doe",
        dob: "02/02/1982",
        street: "123 Main St",
        city: "Spring Hill",
        state: "FL",
        zip: "34606",
        sex: "male",
        subscriberName: "John Doe",
        insuranceMemberId: "self pay",
        phone: "7275551212",
        newPatientConfirmed: true,
        readBack: true,
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    expect(result).toBe(
      "Run check_insurance for accepted medical or routine-vision coverage before creating a patient chart.",
    );
    expect(testMiddleware.operations).toHaveLength(0);
    expect(state.identity.activePatient).toBeNull();
    expect(state.identity.registration).toEqual({
      firstName: "John",
      lastName: "Doe",
      dob: "02/02/1982",
    });
    expect(state.insurance.onFile).toBeNull();
    expect(state.insurance.lastEligibilityCheck).toBeNull();
    expect(state.availability.slots).toEqual([]);
    expect(state.availability.bookingTokensBySlotId).toEqual({});
    expect(state.identity.latestBookedAppointmentId).toBeUndefined();
    expect(state.workflow.current).toBeUndefined();
    expect(state.workflow.routing).toMatchObject({
      routing: null,
      allowedProviders: [],
      routingAmbiguous: false,
      preauthRequired: false,
    });
    expect(state.office.activeKey).toBe("spring-hill");
  });

  it("keeps the prior pre-call patient inactive after add_patient switches to a new patient", async () => {
    const state = createState();
    state.identity.privateCandidates = [
      preCallCandidate({
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
      }),
    ];

    const result = await add_patient.execute(
      {
        firstName: "John",
        lastName: "Doe",
        dob: "02/02/1982",
        street: "123 Main St",
        city: "Spring Hill",
        state: "FL",
        zip: "34606",
        sex: "male",
        subscriberName: "John Doe",
        insuranceMemberId: "self pay",
        phone: "7275551212",
        newPatientConfirmed: true,
        readBack: true,
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    expect(result).toBe(
      "Run check_insurance for accepted medical or routine-vision coverage before creating a patient chart.",
    );
    expect(state.identity.activePatient).toBeNull();
    expect(state.identity.registration).toEqual({
      firstName: "John",
      lastName: "Doe",
      dob: "02/02/1982",
    });
    await expect(
      cancel_appointment.execute({}, {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-2",
      } as never),
    ).resolves.toBe("Verify the patient before cancelling.");
    expect(testMiddleware.operations).toHaveLength(0);
    expect(state.identity.activePatient).toBeNull();
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
    state.identity.privateCandidates = [
      preCallCandidate({
        firstName: "JANE",
        lastName: "DOE",
        dob: "01/01/1980",
        patientId: "patient-jane",
        appointments: [],
        appointmentsStatus: "none",
      }),
    ];

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
        newPatientConfirmed: true,
        readBack: true,
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-2" } as never,
    );

    expect(result).toBe(
      "Do not create a new chart yet. Ask the privacy-safe first-name question, then use the runtime-confirmed patient state or continue an existing-patient lookup.",
    );
    expect(result).not.toMatch(
      /record|matches that identity|Jane|01\/01\/1980/,
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
        newPatientConfirmed: true,
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
    expect(state.workflow.current).toBeUndefined();
  });

  it("passes patient SSN last 4 to new patient creation for routine vision", async () => {
    const state = createState();
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
        newPatientConfirmed: true,
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
    expect(state.workflow.current).toBeUndefined();
  });

  it("creates a chart directly after explicit new-patient confirmation", async () => {
    const state = createState();
    setPatientUnknown(state);
    state.office.activeKey = "hollywood";
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
      newPatientConfirmed: true,
      readBack: true,
    };

    await check_insurance.execute(
      {
        plan: "United Healthcare",
        coverageType: "medical",
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    const result = await add_patient.execute(params, {
      ctx: createToolContext(state) as never,
      toolCallId: "tool-2",
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
    expect(middleware.operations.map(({ name }) => name)).toEqual([
      "createPatient",
    ]);
  });

  it("treats duplicate add_patient after successful chart creation as already done", async () => {
    const state = createState();
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
      newPatientConfirmed: true,
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

  it("stores iCare for any Aetna government routine vision variant", async () => {
    const state = createState();

    const result = (await check_insurance.execute(
      {
        plan: "Aetna Dual Eligible Medicare Advantage",
        coverageType: "routine_vision",
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    )) as Record<string, unknown>;

    expect(result).toEqual({
      status: "accepted",
      plan: "Aetna Dual Eligible Medicare Advantage",
    });
    expect(state.insurance.lastEligibilityCheck).toEqual({
      plan: "Aetna Dual Eligible Medicare Advantage",
      canonicalPlan: "iCare",
      coverageType: "routine_vision",
      currentCarrier: "Aetna Dual Eligible Medicare Advantage",
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
    state.identity.activePatient!.backend = {
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
    expect(state.identity.activePatient!.backend).toEqual({
      insPlanId: null,
      respPartyId: "resp-1",
    });
    expect(state.workflow.routing.routing).toBe("bach_only");
    expect(state.workflow.routing.allowedProviders).toEqual(["Dr. Bach"]);
    expect(state.workflow.routing.preauthRequired).toBe(true);
    expect(state.availability.slots).toEqual([]);
  });

  it("returns update-insurance prerequisites without a tool error", async () => {
    const state = createState();
    state.identity.activePatient!.patientId = null;

    await expect(
      update_insurance.execute({ insuranceMemberId: "ABC123" }, {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never),
    ).resolves.toBe("Verify the patient before updating insurance.");

    state.identity.activePatient!.patientId = "patient-1";
    state.insurance.lastEligibilityCheck = null;
    await expect(
      update_insurance.execute({ insuranceMemberId: "ABC123" }, {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-2",
      } as never),
    ).resolves.toBe(
      "Run check_insurance for accepted coverage before updating insurance.",
    );
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
    state.identity.activePatient!.backend = {
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
    expect(state.identity.activePatient!.backend).toEqual({
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
    ).rejects.toThrow(
      "I couldn't update the insurance. I can try once more or connect you with the office.",
    );
    expect(state.insurance.onFile).toBeNull();
    expect(ownedMiddlewareFailures(state)).toMatchObject([
      { operation: "updateInsurance", reason: "middleware_error" },
    ]);
  });

  it("leaves an invalid insurance-update response as an internal error", async () => {
    const state = createState();
    state.insurance.lastEligibilityCheck = {
      plan: "Sunshine Health",
      canonicalPlan: "Envolve",
      coverageType: "routine_vision",
      currentCarrier: "Sunshine",
      accepted: true,
    };
    stubInsuranceUpdate({ status: "error", reason: "invalid_response" });

    const failure = update_insurance.execute(
      { insuranceMemberId: "946-327-2674" },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    );

    await expect(failure).rejects.toThrow(
      "Owned Middleware returned a non-retryable failure.",
    );
    await expect(failure).rejects.not.toBeInstanceOf(ToolError);
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
