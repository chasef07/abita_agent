import { objectSchema } from "./support/tool-schema.js";
import { candidateSearchResult } from "./support/owned-middleware.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolError } from "@livekit/agents";

import {
  type CreatePatientResult,
  type PatientResolveResult,
  type UpdateInsuranceResult,
} from "../clients/owned-middleware.js";
import {
  CALLER_CANDIDATE_REF,
  type PreCallPatientCandidate,
} from "../state/call-state.js";
import { storeAvailabilityBookingToken } from "../scheduling/availability.js";
import { domainOutcomeReceipts } from "../state/observability.js";
import {
  check_insurance,
  createAddPatientTool,
  createUpdateInsuranceTool,
} from "../tools/index.js";
import { createResolvePatientTool } from "../tools/resolve-patient.js";
import { createConfirmedPatientState } from "./support/call-state.js";
import { createToolContext } from "./support/tool-context.js";
import { deferredResult } from "./support/deferred-result.js";
import {
  InMemoryOwnedMiddleware,
  type InMemoryOwnedMiddlewareResponses,
} from "./support/owned-middleware.js";

type TestCallState = ReturnType<typeof createConfirmedPatientState>;
type PreCallCandidate = PreCallPatientCandidate;
let testMiddleware: InMemoryOwnedMiddleware;
let add_patient: ReturnType<typeof createAddPatientTool>;
let resolve_patient: ReturnType<typeof createResolvePatientTool>;
let update_insurance: ReturnType<typeof createUpdateInsuranceTool>;

function createState(): TestCallState {
  const state = createConfirmedPatientState();
  state.availability.slots = [
    {
      slotId: "S1",
      provider: "Doctor Smith",
      date: "2026-06-01",
      time: "9:00 AM",
      datetime: "2026-06-01T09:00:00",
      routing: "all_three",
    },
  ];
  return state;
}

function markSchedulingTriaged(
  state: TestCallState,
  visitType: "medical" | "routine_vision" = "medical",
) {
  state.workflow.visitType = visitType;
}

function markNewPatientPathConfirmed(state: TestCallState) {
  state.identity.activePatient = null;
  state.identity.registration = {};
}

function clearSchedulingContext(state: TestCallState) {
  state.workflow.visitType = null;
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
  overrides: Partial<Extract<PreCallCandidate, { status: "verified" }>> = {},
): Extract<PreCallCandidate, { status: "verified" }> {
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
  add_patient = createAddPatientTool(middleware);
  resolve_patient = createResolvePatientTool(middleware);
  update_insurance = createUpdateInsuranceTool(middleware);
  return middleware;
}

function stubPatient(
  ...responses: PatientResolveResult[]
): InMemoryOwnedMiddleware {
  return useMiddleware({ resolvePatient: responses });
}

function stubPatientSearch(
  ...responses: PatientResolveResult[]
): InMemoryOwnedMiddleware {
  return stubPatient(...responses);
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
    preauthRequired: false,
    ...overrides,
  };
}

function createdPatientResult(
  overrides: Partial<Extract<CreatePatientResult, { status: "created" }>> = {},
): Extract<CreatePatientResult, { status: "created" }> {
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
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("rejects concurrent duplicate identity writes", () => {
    expect(resolve_patient.onDuplicate).toBe("reject");
    expect(add_patient.onDuplicate).toBe("reject");
  });

  it("keeps private patient references out of the resolve_patient schema", () => {
    expect(Object.keys(objectSchema(resolve_patient.parameters).shape)).toEqual(
      ["firstName", "lastName", "dob"],
    );
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
        phone: null,
        email: null,
        ssnLast4: null,
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
      "I created a patient chart for Jane Doe. We can continue with scheduling.",
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
    expect(state.workflow.visitType).toBeNull();
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
    expect(domainOutcomeReceipts(state)).toMatchObject([
      {
        callId: "tool-1",
        outcome: "patient_created",
        status: "success",
        toolName: "add_patient",
      },
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
          phone: null,
          email: null,
          aptSuite: null,
          ssnLast4: null,
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
  });

  it("leaves a malformed chart-creation response as an internal error", async () => {
    const state = createState();
    setPatientUnknown(state);
    markSchedulingTriaged(state);
    markAcceptedInsurance(state);
    stubCreatePatient({ status: "error", reason: "invalid_response" });

    const failure = add_patient.execute(
      {
        phone: null,
        email: null,
        aptSuite: null,
        ssnLast4: null,
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
        phone: null,
        email: null,
        aptSuite: null,
        ssnLast4: null,
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
      "I created a patient chart, but I couldn't verify the registration details. Office staff needs to check it.",
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
          phone: null,
          email: null,
          aptSuite: null,
          ssnLast4: null,
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
      "I created a patient chart, but I couldn't verify the registration details. Office staff needs to check it.",
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
          phone: null,
          email: null,
          ssnLast4: null,
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
        { lastName: "Doe", firstName: "John", dob: "02/02/1982" },
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
        "I found you in our system, John Doe",
      );
      await expect(pendingCreation).resolves.toContain(
        "I created a patient chart for Jane Doe, but insurance was not attached. Office staff needs to finish the registration.",
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
      phone: null,
      email: null,
      ssnLast4: null,
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
      inboundPhoneConfirmed: true as const,
      newPatientConfirmed: true as const,
      readBack: true as const,
    };

    const pendingCreation = add_patient.execute(params, {
      ctx: createToolContext(state) as never,
      toolCallId: "tool-1",
    } as never);
    const resolution = resolve_patient.execute(
      { lastName: "Doe", firstName: "John", dob: "02/02/1982" },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-2",
      } as never,
    );
    deferred.resolve(createdPatientResult());

    await expect(resolution).rejects.toThrow(
      "I couldn't safely verify the patient chart.",
    );
    await expect(pendingCreation).resolves.toBe(
      "I created a patient chart for Jane Doe. We can continue with scheduling.",
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
    ).resolves.toContain("The patient chart for Jane Doe already exists");
    expect(middleware.operations.map(({ name }) => name)).toEqual([
      "createPatient",
      "resolvePatient",
    ]);
  });

  it("preserves pending chart creation when a different new patient is named", async () => {
    const creation = deferredResult<CreatePatientResult>();
    const state = createState();
    markNewPatientPathConfirmed(state);
    markSchedulingTriaged(state);
    markAcceptedInsurance(state);
    storeAvailabilityBookingToken(state, "S1", "private-token");
    const middleware = useMiddleware({ createPatient: [creation.promise] });

    const pendingCreation = add_patient.execute(
      {
        phone: null,
        email: null,
        ssnLast4: null,
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
        inboundPhoneConfirmed: null,
        email: null,
        aptSuite: null,
        ssnLast4: null,
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
      "I need to check whether this patient already has a chart before creating a new one.",
    );
    await expect(pendingCreation).resolves.toBe(
      "I created a patient chart for Jane Doe. We can continue with scheduling.",
    );
    expect(state.identity.activePatient).toMatchObject({
      kind: "created",
      patientId: "patient-new",
      name: "Jane Doe",
    });
    expect(state.identity.registration).toBeNull();
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
      preauthRequired: false,
    });
    const params = {
      phone: null,
      email: null,
      ssnLast4: null,
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
      inboundPhoneConfirmed: true as const,
      newPatientConfirmed: true as const,
      readBack: true as const,
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
      "I created a patient chart for Jane Doe, but insurance was not attached. Office staff needs to finish the registration.",
    );
    expect(secondResult).toBe(
      "The patient chart for Jane Doe already exists, but insurance is not attached. Office staff needs to finish the registration.",
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
        aptSuite: null,
        city: "Spring Hill",
        state: "FL",
        zip: "34606",
        sex: "female",
        subscriberName: "Jane Doe",
        insuranceMemberId: "self pay",
        phone: null,
        inboundPhoneConfirmed: true,
        email: null,
        ssnLast4: null,
        newPatientConfirmed: null,
        readBack: true,
      },
      {
        ctx: ctx as never,
        toolCallId: "tool-1",
      } as never,
    );

    expect(result).toBe(
      "Has the patient ever registered with or been added to the practice?",
    );
    expect(ctx.speechHandle.allowInterruptions).toBe(false);
    expect(ctx.disallowInterruptions).toHaveBeenCalledOnce();
    expect(testMiddleware.operations).toHaveLength(0);
    expect(state.identity.activePatient).toBeNull();
    expect(state.identity.registration).toBeNull();
    expect(domainOutcomeReceipts(state)).toEqual([]);
  });

  it("marks a created chart as new-patient state when middleware omits status", async () => {
    const state = createState();
    markNewPatientPathConfirmed(state);
    markSchedulingTriaged(state);
    markAcceptedInsurance(state);
    stubCreatePatient(createdPatientResult({ insuranceCarrier: null }));

    await add_patient.execute(
      {
        phone: null,
        email: null,
        ssnLast4: null,
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
        phone: null,
        email: null,
        ssnLast4: null,
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
        newPatientConfirmed: true,
        readBack: true,
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    );

    expect(result).toBe(
      "I created a patient chart for Lisa Arshed. We can continue with scheduling.",
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

  it.each([null, "Florida Blue", "Florida Blue HMO"])(
    "requires accepted coverage before creating a patient after checking %s",
    async (plan) => {
      const state = createState();
      markNewPatientPathConfirmed(state);
      clearSchedulingContext(state);
      state.office.activeKey = "sweetwater";
      if (plan) {
        await check_insurance.execute({ plan, coverageType: "medical" }, {
          ctx: createToolContext(state) as never,
          toolCallId: "insurance-check",
        } as never);
      }

      const result = await add_patient.execute(
        {
          inboundPhoneConfirmed: null,
          email: null,
          aptSuite: null,
          ssnLast4: null,
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
        "I need to confirm accepted medical or routine vision coverage before creating the chart.",
      );
      expect(testMiddleware.operations).toHaveLength(0);
    },
  );

  it("blocks routine vision chart creation for Crystal River", async () => {
    const state = createState();
    state.office.activeKey = "crystal-river";
    markNewPatientPathConfirmed(state);
    clearSchedulingContext(state);
    markAcceptedInsurance(state, {
      plan: "self pay",
      canonicalPlan: "self pay",
      coverageType: "routine_vision",
    });

    const result = await add_patient.execute(
      {
        inboundPhoneConfirmed: null,
        email: null,
        ssnLast4: null,
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
    expect(testMiddleware.operations).toHaveLength(0);
  });

  it("omits SSN from self-pay routine-vision creation", async () => {
    const baseParams = {
      email: null,
      inboundPhoneConfirmed: null,
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
      ssnLast4: "1234",
      phone: "7275551212",
      newPatientConfirmed: true as const,
      readBack: true as const,
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
      "I created a patient chart for Jane Doe. We can continue with scheduling.",
    );

    expect(middleware.requests.createPatient[0]?.patient).toMatchObject({
      coverageType: "routine_vision",
    });
    expect(middleware.requests.createPatient[0]?.patient).not.toHaveProperty(
      "ssn",
    );
  });

  it("keeps SSN out of self-pay registration read-back", async () => {
    const state = createState();
    markNewPatientPathConfirmed(state);
    clearSchedulingContext(state);
    markAcceptedInsurance(state, {
      plan: "self pay",
      canonicalPlan: "self pay",
      coverageType: "routine_vision",
    });

    const result = await add_patient.execute(
      {
        inboundPhoneConfirmed: null,
        email: null,
        aptSuite: null,
        readBack: null,
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
        ssnLast4: "1234",
        phone: "7275551212",
        newPatientConfirmed: true,
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    expect(result).not.toContain("SSN");
    expect(result).not.toContain("1234");
    expect(result).not.toContain("last four");
    expect(testMiddleware.operations).toHaveLength(0);
  });

  it("creates an insured routine-vision chart without SSN last four", async () => {
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
        inboundPhoneConfirmed: null,
        email: null,
        aptSuite: null,
        ssnLast4: null,
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
      { ctx: createToolContext(state) as never, toolCallId: "tool-2" } as never,
    );

    expect(result).toBe(
      "I created a patient chart for Jane Doe. We can continue with scheduling.",
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
        inboundPhoneConfirmed: null,
        ssnLast4: null,
        readBack: null,
        firstName: "Jane",
        lastName: "Doe",
        dob: "01/01/1980",
        street: "123 Main St",
        aptSuite: "Apt 2",
        city: "Spring Hill",
        state: "FL",
        zip: "34606",
        sex: "female",
        subscriberName: "Jane Doe",
        insuranceMemberId: "self pay",
        phone: "7275551212",
        email: "jane@example.com",
        newPatientConfirmed: true,
      },
      { ctx: ctx as never, toolCallId: "tool-1" } as never,
    );

    expect(result).toBe(
      "Let me confirm the registration for Jane Doe, date of birth 01/01/1980, female. The address is 123 Main St, Apt 2, Spring Hill, FL 34606. The callback number is 727-555-1212. The email is jane@example.com. The patient will use self-pay. Is all of that correct?",
    );
    expect(testMiddleware.operations).toHaveLength(0);
    expect(ctx.speechHandle.allowInterruptions).toBe(false);
  });

  it("keeps a provided SSN last four out of the read-back", async () => {
    const state = createState();
    markNewPatientPathConfirmed(state);
    markSchedulingTriaged(state, "routine_vision");
    markAcceptedInsurance(state, {
      plan: "VSP",
      canonicalPlan: "VSP",
      coverageType: "routine_vision",
    });

    const result = await add_patient.execute(
      {
        inboundPhoneConfirmed: null,
        email: null,
        aptSuite: null,
        readBack: null,
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
      "Let me confirm the registration for Jane Doe, date of birth 01/01/1980, female. The address is 123 Main St, Spring Hill, FL 34606. The callback number is 727-555-1212. The insurance is VSP, with Jane Doe as the policyholder and member ID VSP123. I also recorded the requested last four digits without reading them aloud. Is all of that correct?",
    );
    expect(result).not.toContain("SSN");
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
        phone: null,
        inboundPhoneConfirmed: null,
        email: null,
        ssnLast4: null,
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
      "Is the number you're calling from a good callback number to put on file?",
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
        email: null,
        ssnLast4: null,
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
    const middleware = stubPatientSearch(
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
      { lastName: "Doe", firstName: "Jane", dob: "01/01/1980" },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    expect(result).toContain(
      "I found you in our system, Jane Doe. We have self pay on file. I found one upcoming appointment, Monday, July 27 at 9:00 AM with Dr. Bach.\nInternal appointment references (do not read aloud):",
    );
    expect(result).toMatch(/appointmentRef appointment-[a-z0-9]+/);
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
        dob: "01/01/1980",
      },
    });
    expect(middleware.requests.resolvePatient[0]?.identity).not.toHaveProperty(
      "phone",
    );
    expect(domainOutcomeReceipts(state)).toMatchObject([
      {
        callId: "tool-1",
        outcome: "patient_verified",
        status: "success",
        toolName: "resolve_patient",
      },
    ]);
  });

  it.each(["verified", "candidate", "absent"] as const)(
    "records a switch through %s phone candidates after conflicting identity is clarified",
    async (status) => {
      const state = createState();
      if (status !== "absent")
        state.identity.privateCandidates = [
          {
            status,
            ref: "second",
            patientId: "patient-2",
            firstName: "John",
            lastName: "Doe",
            dob: "02/02/1982",
            appointments: [],
            appointmentsStatus: "none",
          },
        ];
      const resolved = verifiedPatientResult({
        patientId: "patient-2",
        name: "John Doe",
        dob: "02/02/1982",
      });
      if (status === "absent") stubPatientSearch(resolved);
      else stubPatient(resolved, resolved);
      const ctx = createToolContext(state);

      await resolve_patient.execute(
        { lastName: null, firstName: "Different", dob: null },
        {
          ctx,
          toolCallId: "switch-start",
        } as never,
      );
      expect(state.identity.activePatient).toBeNull();
      expect(state.availability.slots).toEqual([]);
      await resolve_patient.execute(
        { lastName: "Doe", firstName: "John", dob: "02/02/1982" },
        {
          ctx,
          toolCallId: "switch-finish",
        } as never,
      );

      expect(state.identity.activePatient?.patientId).toBe("patient-2");
      await resolve_patient.execute(
        { lastName: "Doe", firstName: "John", dob: "02/02/1982" },
        {
          ctx,
          toolCallId: "same-patient",
        } as never,
      );
      expect(domainOutcomeReceipts(state)).toMatchObject([
        {
          callId: "switch-start",
          outcome: "patient_lookup_needs_identity",
          status: "blocked",
        },
        {
          callId: "switch-finish",
          outcome: "patient_switched",
          status: "success",
        },
        {
          callId: "same-patient",
          outcome: "patient_verified",
          status: "success",
        },
      ]);
    },
  );

  it("reports verification when a different-patient request has no previous chart", async () => {
    const state = createState();
    setPatientUnknown(state);
    stubPatientSearch(verifiedPatientResult());

    await resolve_patient.execute(
      { lastName: "Doe", firstName: "Jane", dob: "01/01/1980" },
      { ctx: createToolContext(state), toolCallId: "first-patient" } as never,
    );

    expect(domainOutcomeReceipts(state)).toMatchObject([
      {
        callId: "first-patient",
        outcome: "patient_verified",
        status: "success",
      },
    ]);
  });

  it("keeps distinct loaded appointment references in state instead of the reply", async () => {
    const state = createState();
    setPatientUnknown(state);
    const middleware = stubPatientSearch(
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
      { lastName: "Doe", firstName: "Jane", dob: "01/01/1980" },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    const storedRefs = state.identity.activePatient!.appointments.flatMap(
      (appointment) =>
        appointment.appointmentRef ? [appointment.appointmentRef] : [],
    );
    expect(storedRefs).toHaveLength(2);
    expect(new Set(storedRefs).size).toBe(2);
    expect(result).toContain(storedRefs[0]);
    expect(result).toContain(storedRefs[1]);
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

  it("returns every loaded appointment reference for subsequent appointment tools", async () => {
    const state = createState();
    setPatientUnknown(state);
    stubPatientSearch(
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
      { lastName: "Doe", firstName: "Jane", dob: "01/01/1980" },
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
    markSchedulingTriaged(state, "routine_vision");
    state.availability.latestRouting = "optical_only";
    storeAvailabilityBookingToken(state, "S1", "stale-token");
    state.insurance.lastEligibilityCheck = {
      plan: "Aetna",
      canonicalPlan: "Aetna",
      coverageType: "routine_vision",
      currentCarrier: "Aetna",
      accepted: true,
    };
    const middleware = stubPatientSearch(
      verifiedPatientResult({
        patientId: "patient-2",
        name: "John Doe",
        dob: "02/02/1982",
        insuranceCarrier: "Aetna",
        routing: "bach_only",
      }),
    );

    const result = await resolve_patient.execute(
      { lastName: "Doe", firstName: "John", dob: "02/02/1982" },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    expect(result).toBe(
      "I found you in our system, John Doe. We have Aetna on file. I don't see any upcoming appointments.\nDOB is on file. Do not ask for DOB.",
    );
    expect(middleware.requests.resolvePatient[0]).toMatchObject({
      identity: {
        firstName: "John",
        dob: "02/02/1982",
      },
      office: "+13523202007",
    });
    expect(state.identity.activePatient!.patientId).toBe("patient-2");
    expect(state.workflow.visitType).toBeNull();
    expect(state.office.activeKey).toBe("crystal-river");
    expect(state.availability.slots).toEqual([]);
    expect(state.availability.bookingTokensBySlotId).toEqual({});
    expect(state.insurance.lastEligibilityCheck).toBeNull();
  });

  it("clearly reports verified existing patients without insurance on file", async () => {
    const state = createState();
    stubPatientSearch(
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
      { lastName: "Test", firstName: "Chase", dob: "04/07/2000" },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    expect(result).toBe(
      "I found you in our system, CHASE TEST. I don't see any upcoming appointments.\nDOB is on file. Do not ask for DOB.",
    );
    expect(state.identity.activePatient!.patientId).toBe("patient-1");
    expect(state.identity.activePatient!.kind).toBe("existing");
    expect(state.insurance.onFile).toBeNull();
    expect(state.insurance.lastEligibilityCheck).toBeNull();
  });

  it.each(["Garcia", "Lopez", "Garcia Lopez"])(
    "activates a verified compound-surname receipt using %s",
    async (lastName) => {
      const state = createState();
      setPatientUnknown(state);
      stubPatientSearch(
        verifiedPatientResult({
          name: "GARCIA LOPEZ,ANA",
          dob: "01/01/1980",
        }),
      );

      const identity = { firstName: "Ana", lastName, dob: "01/01/1980" };
      await resolve_patient.execute(identity, {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never);

      expect(state.identity.activePatient?.patientId).toBe("patient-1");
      expect(domainOutcomeReceipts(state)).toMatchObject([
        { callId: "tool-1", outcome: "patient_verified", status: "success" },
      ]);
    },
  );

  it.each([
    { firstName: "Other", lastName: "Garcia", dob: "01/01/1980" },
    { firstName: "Ana", lastName: "Garcia", dob: "02/02/1980" },
  ])("rejects a mismatched compound-surname receipt: %j", async (identity) => {
    const state = createState();
    setPatientUnknown(state);
    stubPatient(
      candidateSearchResult(
        verifiedPatientResult({
          name: `${identity.lastName},${identity.firstName}`,
          dob: identity.dob,
        }),
      ),
      verifiedPatientResult({ name: "GARCIA LOPEZ,ANA", dob: "01/01/1980" }),
    );

    await expect(
      resolve_patient.execute(identity, {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never),
    ).rejects.toThrow("I couldn't safely verify the patient chart.");
    expect(state.identity.activePatient).toBeNull();
  });

  it("does not activate a verified lookup receipt for a different identity", async () => {
    const state = createState();
    setPatientUnknown(state);
    stubPatient(
      candidateSearchResult(
        verifiedPatientResult({ name: "Doe,Ana", dob: "01/01/1980" }),
      ),
      verifiedPatientResult({
        patientId: "patient-wrong",
        name: "ANNA,DOE",
        dob: "01/01/1980",
      }),
    );

    const result = resolve_patient.execute(
      { lastName: "Doe", firstName: "Ana", dob: "01/01/1980" },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    await expect(result).rejects.toThrow(
      "I couldn't safely verify the patient chart.",
    );
    expect(state.identity.activePatient).toBeNull();
    expect(domainOutcomeReceipts(state)).toMatchObject([
      {
        callId: "tool-1",
        outcome: "patient_lookup_failed",
        status: "failed",
      },
    ]);
  });

  it("keeps a private candidate inactive after a full lookup finds no patient", async () => {
    const state = createState();
    setSingleArshedPreCallCandidate(state);
    const middleware = stubPatientSearch({
      status: "not_found",
    });

    const result = await resolve_patient.execute(
      { lastName: "Doe", firstName: "Lisa", dob: "10/03/2020" },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    expect(result).toBe("I couldn't find a matching patient.");
    expect(middleware.requests.resolvePatient[0]).toMatchObject({
      identity: {
        firstName: "Lisa",
        dob: "10/03/2020",
      },
    });
    expect(state.identity.privateCandidates).toHaveLength(1);
    expect(state.identity.activePatient).toBeNull();
  });

  it("preserves lookup failures instead of using the pre-call spelling fallback", async () => {
    const state = createState();
    setSingleArshedPreCallCandidate(state);
    stubPatient({ status: "error", reason: "middleware_error" });

    await expect(
      resolve_patient.execute(
        { lastName: "Doe", firstName: "Lisa", dob: "10/03/2020" },
        {
          ctx: createToolContext(state) as never,
          toolCallId: "tool-1",
        } as never,
      ),
    ).rejects.toThrow("I couldn't safely verify the patient chart.");
    expect(state.identity.privateCandidates).toHaveLength(1);
    expect(state.identity.activePatient).toBeNull();
  });

  it("asks for a surname to recover an invalid broad patient response", async () => {
    const state = createState();
    setSingleArshedPreCallCandidate(state);
    stubPatient({ status: "error", reason: "invalid_response" });

    const failure = resolve_patient.execute(
      { lastName: null, firstName: "Lisa", dob: "10/03/2020" },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    );

    await expect(failure).resolves.toContain("last name");
    expect(state.identity.activePatient).toBeNull();
    expect(state.identity.unregisteredPatientReceipt).toBeNull();
  });

  it("records a lookup outcome when identity resolution throws early", async () => {
    const state = createState();
    const tool = createResolvePatientTool(
      new InMemoryOwnedMiddleware({
        resolvePatient: [new Error("unexpected lookup failure")],
      }),
    );

    await expect(
      tool.execute(
        { lastName: "Doe", firstName: "Different", dob: "01/01/1980" },
        {
          ctx: createToolContext(state) as never,
          toolCallId: "tool-1",
        } as never,
      ),
    ).rejects.toThrow("unexpected lookup failure");
    expect(domainOutcomeReceipts(state)).toMatchObject([
      {
        callId: "tool-1",
        outcome: "patient_lookup_failed",
        status: "failed",
      },
    ]);
  });

  it("resolves patients through the supplied Owned Middleware", async () => {
    const state = createState();
    setPatientUnknown(state);
    const middleware = new InMemoryOwnedMiddleware({
      resolvePatient: [verifiedPatientResult()],
    });
    const tool = createResolvePatientTool(middleware);

    await expect(
      tool.execute({ lastName: "Doe", firstName: "Jane", dob: "01/01/1980" }, {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never),
    ).resolves.toContain("I found you in our system, Jane Doe.");
    expect(
      middleware.requests.resolvePatient.map((request) => request.identity),
    ).toEqual([{ firstName: "Jane", lastName: "Doe", dob: "01/01/1980" }]);
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
    const tool = createResolvePatientTool(
      new InMemoryOwnedMiddleware({
        resolvePatient: [new Error("candidate hydration failed")],
      }),
    );

    await expect(
      tool.execute({ lastName: null, dob: null, firstName: "Jane" }, {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never),
    ).rejects.toThrow("candidate hydration failed");
    expect(state.identity.activePatient).toBeNull();
    expect(domainOutcomeReceipts(state)).toMatchObject([
      {
        callId: "tool-1",
        outcome: "patient_lookup_failed",
        status: "failed",
      },
    ]);
  });

  it("verifies a backend patient before spelling fallback when a pre-call single match shares last name and DOB", async () => {
    const state = createState();
    setSingleArshedPreCallCandidate(state);
    const middleware = stubPatientSearch({
      status: "verified",
      patientId: "patient-ella",
      name: "ELLA ARSHED",
      dob: "10/03/2020",
      phone: "+17275551212",
      insuranceCarrier: "Aetna",
      insPlanId: null,
      respPartyId: null,
      routing: "all_three",
      preauthRequired: false,
      appointmentsStatus: "none",
      appointmentsMessage: null,
      appointments: [],
      message: null,
    });

    const result = await resolve_patient.execute(
      { lastName: "Arshed", firstName: "Ella", dob: "10/03/2020" },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    expect(result).toBe(
      "I found you in our system, ELLA ARSHED. We have Aetna on file. I don't see any upcoming appointments.\nDOB is on file. Do not ask for DOB.",
    );
    expect(middleware.requests.resolvePatient[0]).toMatchObject({
      identity: {
        firstName: "Ella",
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
      }),
      preCallCandidate({
        ref: "precall:2",
        firstName: "MONIQUE",
        lastName: "HAMILTON",
        dob: "12/21/2016",
        patientId: "patient-monique",
        insuranceCarrier: "HUMANA",
        routing: undefined,
      }),
    ]);

    const result = await resolve_patient.execute(
      { lastName: "Doe", firstName: "Monique", dob: "12/21/2016" },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    expect(testMiddleware.operations).toHaveLength(0);
    expect(result).toBe(
      "I found you in our system, MONIQUE HAMILTON. We have HUMANA on file. I don't see any upcoming appointments.\nDOB is on file. Do not ask for DOB.",
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
      }),
    ]);
    storeAvailabilityBookingToken(state, "S1", "token-a");
    state.insurance.lastEligibilityCheck = {
      plan: "Aetna",
      canonicalPlan: "Aetna",
      coverageType: "medical",
      currentCarrier: "Aetna",
      accepted: true,
    };

    const result = await resolve_patient.execute(
      { lastName: null, dob: null, firstName: "Brandon" },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    );

    expect(testMiddleware.operations).toHaveLength(0);
    expect(result).toBe(
      "BRANDON ANDERSON is already the active patient.\nDOB is on file. Do not ask for DOB.",
    );
    expect(state.availability.slots.map((slot) => slot.slotId)).toEqual(["S1"]);
    expect(state.availability.bookingTokensBySlotId).toEqual({
      S1: "token-a",
    });
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

    const result = await resolve_patient.execute(
      { lastName: null, dob: null, firstName: "Esa" },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    );

    expect(testMiddleware.operations).toHaveLength(0);
    expect(result).toBe(
      "I found you in our system, ESA ARSHED. We have Florida Blue Shield on file. I don't see any upcoming appointments.\nDOB is on file. Do not ask for DOB.",
    );
    expect(state.identity.activePatient!.patientId).toBe("patient-esa");
  });

  it("promotes a fuzzy phone match and returns its loaded appointment through resolve_patient", async () => {
    const state = createState();
    setPatientUnknown(state);
    state.identity.privateCandidates = [
      preCallCandidate({
        firstName: "Emmy",
        lastName: "Example",
        patientId: "patient-example",
        appointmentsStatus: "found",
        appointments: [
          {
            id: 1,
            date: "2026-10-15",
            time: "9:00 AM",
            provider: "Dr. Example",
            type: "Office Visit",
            facility: "Example Clinic",
            confirmed: false,
          },
        ],
      }),
    ];
    const identity = objectSchema<
      Parameters<typeof resolve_patient.execute>[0]
    >(resolve_patient.parameters).parse({
      lastName: null,
      firstName: "Amy",
      dob: null,
    });

    const result = await resolve_patient.execute(identity, {
      ctx: createToolContext(state),
      toolCallId: "fuzzy-phone-match",
    } as never);

    expect(testMiddleware.operations).toHaveLength(0);
    expect(state.identity.activePatient?.patientId).toBe("patient-example");
    expect(state.identity.activePatient?.appointments).toHaveLength(1);
    expect(result).toContain("one upcoming appointment");
    expect(result).toContain("9:00 AM");
    expect(domainOutcomeReceipts(state)).toMatchObject([
      {
        toolName: "resolve_patient",
        outcome: "patient_verified",
        status: "success",
      },
    ]);
  });

  it("treats model-emitted empty surname and DOB as unknown", async () => {
    const state = createState();
    setSingleArshedPreCallCandidate(state);
    const identity = objectSchema<
      Parameters<typeof resolve_patient.execute>[0]
    >(resolve_patient.parameters).parse({
      lastName: null,
      firstName: "Esa",
      dob: "",
    });
    await resolve_patient.execute(identity, {
      ctx: createToolContext(state),
      toolCallId: "empty-identity",
    } as never);
    expect(state.identity.activePatient?.patientId).toBe("patient-esa");
    expect(testMiddleware.operations).toHaveLength(0);
  });

  it("does not call middleware until full identity is provided", async () => {
    const state = createState();
    setPatientUnknown(state);

    const result = await resolve_patient.execute(
      { lastName: null, firstName: "Jane", dob: null },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    );
    expect(result).toContain("date of birth");
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
    const patientScopedStateBefore = structuredClone({
      activePatient: state.identity.activePatient,
      registration: state.identity.registration,
      insurance: state.insurance,
      availability: state.availability,
      workflow: state.workflow,
      office: state.office,
    });

    const result = await add_patient.execute(
      {
        inboundPhoneConfirmed: null,
        email: null,
        aptSuite: null,
        ssnLast4: null,
        readBack: null,
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
      "I need to check whether this patient already has a chart before creating a new one.",
    );
    expect(testMiddleware.operations).toHaveLength(0);
    expect({
      activePatient: state.identity.activePatient,
      registration: state.identity.registration,
      insurance: state.insurance,
      availability: state.availability,
      workflow: state.workflow,
      office: state.office,
    }).toEqual(patientScopedStateBefore);
  });

  it("does not consume a new-patient receipt for an incomplete identity", async () => {
    const state = createState();
    markAcceptedInsurance(state);
    state.identity.unregisteredPatientReceipt = {
      identity: {
        firstName: "Maria",
        lastName: "Santos",
        dob: "01/01/1980",
      },
      lookupOperationVersion: state.identity.operationVersion,
      insuranceCheckVersion: 1,
    };
    const patientScopedStateBefore = structuredClone({
      activePatient: state.identity.activePatient,
      registration: state.identity.registration,
      unregisteredPatientReceipt: state.identity.unregisteredPatientReceipt,
      insurance: state.insurance,
      availability: state.availability,
      workflow: state.workflow,
      office: state.office,
    });

    const result = await add_patient.execute(
      {
        inboundPhoneConfirmed: null,
        email: null,
        aptSuite: null,
        ssnLast4: null,
        firstName: "Maria",
        lastName: "Santos",
        dob: "   ",
        street: "123 Main St",
        city: "Spring Hill",
        state: "FL",
        zip: "34606",
        sex: "female",
        subscriberName: "Maria Santos",
        insuranceMemberId: "self pay",
        phone: "7275551212",
        newPatientConfirmed: true,
        readBack: true,
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    expect(result).toBe("What is the patient's full name and date of birth?");
    expect(testMiddleware.operations).toHaveLength(0);
    expect({
      activePatient: state.identity.activePatient,
      registration: state.identity.registration,
      unregisteredPatientReceipt: state.identity.unregisteredPatientReceipt,
      insurance: state.insurance,
      availability: state.availability,
      workflow: state.workflow,
      office: state.office,
    }).toEqual(patientScopedStateBefore);
  });

  it("does not start unresolved registration with an incomplete identity", async () => {
    const state = createState();
    setPatientUnknown(state);
    markAcceptedInsurance(state);
    const patientScopedStateBefore = structuredClone({
      activePatient: state.identity.activePatient,
      registration: state.identity.registration,
      unregisteredPatientReceipt: state.identity.unregisteredPatientReceipt,
      insurance: state.insurance,
      availability: state.availability,
      workflow: state.workflow,
      office: state.office,
    });

    const result = await add_patient.execute(
      {
        inboundPhoneConfirmed: null,
        email: null,
        aptSuite: null,
        ssnLast4: null,
        firstName: "Maria",
        lastName: "Santos",
        dob: "   ",
        street: "123 Main St",
        city: "Spring Hill",
        state: "FL",
        zip: "34606",
        sex: "female",
        subscriberName: "Maria Santos",
        insuranceMemberId: "self pay",
        phone: "7275551212",
        newPatientConfirmed: true,
        readBack: true,
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    expect(result).toBe("What is the patient's full name and date of birth?");
    expect(testMiddleware.operations).toHaveLength(0);
    expect({
      activePatient: state.identity.activePatient,
      registration: state.identity.registration,
      unregisteredPatientReceipt: state.identity.unregisteredPatientReceipt,
      insurance: state.insurance,
      availability: state.availability,
      workflow: state.workflow,
      office: state.office,
    }).toEqual(patientScopedStateBefore);
  });

  it("does not carry accepted insurance into a different registration", async () => {
    const state = createState();
    setPatientUnknown(state);
    state.identity.registration = {
      firstName: "Maria",
      lastName: "Santos",
      dob: "01/01/1980",
    };
    markAcceptedInsurance(state, {
      plan: "Aetna",
      canonicalPlan: "Aetna",
      coverageType: "medical",
    });
    const registrationBefore = structuredClone(state.identity.registration);
    const insuranceBefore = structuredClone(state.insurance);

    const result = await add_patient.execute(
      {
        inboundPhoneConfirmed: null,
        email: null,
        aptSuite: null,
        ssnLast4: null,
        readBack: null,
        firstName: "John",
        lastName: "Doe",
        dob: "02/02/1982",
        street: "123 Main St",
        city: "Spring Hill",
        state: "FL",
        zip: "34606",
        sex: "male",
        subscriberName: "John Doe",
        insuranceMemberId: "ABC123",
        phone: "7275551212",
        newPatientConfirmed: true,
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    expect(result).toBe(
      "I need to check whether this patient already has a chart before creating a new one.",
    );
    expect(testMiddleware.operations).toHaveLength(0);
    expect(state.identity.registration).toEqual(registrationBefore);
    expect(state.insurance).toEqual(insuranceBefore);
  });

  it("establishes new-patient state while preserving its accepted insurance check", async () => {
    const state = createState();
    setPatientUnknown(state);
    storeAvailabilityBookingToken(state, "S1", "stale-token");
    state.insurance.lastEligibilityCheck = {
      plan: "Aetna",
      canonicalPlan: "Aetna",
      coverageType: "medical",
      currentCarrier: "Aetna",
      accepted: true,
    };

    const result = await add_patient.execute(
      {
        inboundPhoneConfirmed: null,
        email: null,
        aptSuite: null,
        ssnLast4: null,
        readBack: null,
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
      "Let me confirm the registration for Maria Santos, date of birth 01/01/1980, female. The address is 123 Main St, Spring Hill, FL 34606. The callback number is 727-555-1212. The insurance is Aetna, with Maria Santos as the policyholder and member ID ABC123. Is all of that correct?",
    );
    expect(state.identity.activePatient).toBeNull();
    expect(state.identity.registration).toEqual({
      firstName: "Maria",
      lastName: "Santos",
      dob: "01/01/1980",
    });
    expect(state.availability.slots).toEqual([]);
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
        inboundPhoneConfirmed: null,
        email: null,
        aptSuite: null,
        ssnLast4: null,
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
      "That patient is already active, so I won't create another chart.",
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
        inboundPhoneConfirmed: null,
        email: null,
        aptSuite: null,
        ssnLast4: null,
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
      "That patient is already active, so I won't create another chart.",
    );
    expect(testMiddleware.operations).toHaveLength(0);
    expect(state.identity.activePatient!).toMatchObject({
      kind: "existing",
      patientId: "patient-1",
      name: "TEST,CHASE",
      dob: "01/01/1980",
    });
  });

  it("preserves patient-scoped state when add_patient lacks accepted insurance", async () => {
    const state = createState();
    storeAvailabilityBookingToken(state, "S1", "private-token");
    state.workflow.visitType = "medical";
    state.office.activeKey = "hollywood";
    const patientScopedStateBefore = structuredClone({
      activePatient: state.identity.activePatient,
      registration: state.identity.registration,
      insurance: state.insurance,
      availability: state.availability,
      workflow: state.workflow,
      office: state.office,
    });

    const result = await add_patient.execute(
      {
        inboundPhoneConfirmed: null,
        email: null,
        aptSuite: null,
        ssnLast4: null,
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
      "I need to check whether this patient already has a chart before creating a new one.",
    );
    expect(testMiddleware.operations).toHaveLength(0);
    expect({
      activePatient: state.identity.activePatient,
      registration: state.identity.registration,
      insurance: state.insurance,
      availability: state.availability,
      workflow: state.workflow,
      office: state.office,
    }).toEqual(patientScopedStateBefore);
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
        phone: null,
        email: null,
        ssnLast4: null,
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
      "I need to confirm the patient's first name before creating a new chart. Could you spell it for me?",
    );
    expect(result).not.toMatch(
      /record|matches that identity|Jane|01\/01\/1980/,
    );
    expect(testMiddleware.operations).toHaveLength(0);
  });

  it("stores accepted insurance from check_insurance", async () => {
    const state = createState();

    const result = await check_insurance.execute(
      {
        plan: "Blue Cross",
        coverageType: "medical",
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    expect(result).toBe("Yes, we take Blue Cross Blue Shield.");
    expect(typeof result).toBe("string");
    expect(state.insurance.lastEligibilityCheck).toEqual({
      plan: "Blue Cross",
      canonicalPlan: "Florida Blue",
      coverageType: "medical",
      currentCarrier: "Blue Cross Blue Shield",
      accepted: true,
    });
    expect(state.workflow.visitType).toBeNull();
  });

  it("returns a staff-task result for preauth-required insurance checks", async () => {
    const state = createState();
    state.office.activeKey = "hollywood";

    const result = await check_insurance.execute(
      {
        plan: "United Healthcare Individual Exchange Network (Medical)",
        coverageType: "medical",
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    expect(result).toBe(
      "This plan requires prior authorization before we can schedule. I can send a task to staff to follow up with the insurance company. Is that okay?",
    );
    expect(typeof result).toBe("string");
    expect(state.insurance.lastEligibilityCheck).toEqual({
      plan: "United Healthcare Individual Exchange Network (Medical)",
      canonicalPlan: null,
      coverageType: "medical",
      currentCarrier: "United Healthcare Individual Exchange Network (Medical)",
      accepted: false,
    });
  });

  it("returns a plain clarification prompt without changing structured state", async () => {
    const state = createState();

    const result = await check_insurance.execute(
      { plan: "Cigna", coverageType: "medical" },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    expect(result).toBe(
      "I can check that, but I need to know which Cigna plan is on the card.",
    );
    expect(typeof result).toBe("string");
    expect(state.insurance.lastEligibilityCheck).toEqual({
      plan: "Cigna",
      canonicalPlan: null,
      coverageType: "medical",
      currentCarrier: null,
      accepted: false,
    });
  });

  it("returns the Staff Task path for pending routine vision", async () => {
    const state = createState();
    state.office.activeKey = "hollywood";

    const result = await check_insurance.execute(
      { plan: "CarePlus", coverageType: "routine_vision" },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    expect(result).toBe(
      "CarePlus Medicare routine vision is pending for these providers. I can send a task to staff to confirm coverage before scheduling. Is that okay?",
    );
    expect(state.insurance.lastEligibilityCheck).toEqual({
      plan: "CarePlus",
      canonicalPlan: null,
      coverageType: "routine_vision",
      currentCarrier: "CarePlus",
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
        phone: null,
        email: null,
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
    expect(state.workflow.visitType).toBeNull();
  });

  it("passes patient SSN last 4 to new patient creation for routine vision", async () => {
    const state = createState();
    markNewPatientPathConfirmed(state);
    state.insurance.onFile = null;
    markSchedulingTriaged(state, "routine_vision");
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
        phone: null,
        email: null,
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
    expect(state.workflow.visitType).toBeNull();
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
      phone: null,
      email: null,
      ssnLast4: null,
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
      inboundPhoneConfirmed: true as const,
      newPatientConfirmed: true as const,
      readBack: true as const,
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
      "I created a patient chart for Maria Santos. We can continue with scheduling.",
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
      phone: null,
      email: null,
      ssnLast4: null,
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
      inboundPhoneConfirmed: true as const,
      newPatientConfirmed: true as const,
      readBack: true as const,
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
      "The patient chart for Jane Doe already exists. We can continue with scheduling.",
    );
    expect(middleware.requests.createPatient).toHaveLength(1);
  });

  it("keeps canonical insurance internal for caller-facing alias responses", async () => {
    const state = createState();

    const result = await check_insurance.execute(
      {
        plan: "Ambetter",
        coverageType: "routine_vision",
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    expect(result).toBe("Yes, we take Ambetter.");
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

    const result = await check_insurance.execute(
      {
        plan: "Simply Healthcare Medicaid",
        coverageType: "routine_vision",
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    expect(result).toBe("Yes, we take Simply Healthcare Medicaid.");
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

    const result = await check_insurance.execute(
      {
        plan: "Aetna Dual Eligible Medicare Advantage",
        coverageType: "routine_vision",
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    expect(result).toBe("Yes, we take Aetna Dual Eligible Medicare Advantage.");
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

    const result = await check_insurance.execute(
      {
        plan: "Humana PPO",
        coverageType: "medical",
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    expect(result).toBe("No, we don't accept Humana PPO.");
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

    const result = await check_insurance.execute(
      {
        plan: "Humana PPO",
        coverageType: "medical",
      },
      { ctx: createToolContext(state) as never, toolCallId: "tool-1" } as never,
    );

    expect(result).toBe("No, we don't accept Humana PPO.");
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

    expect(result).toBe("No, we don't accept Aetna.");
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
    expect(state.workflow.routing.preauthRequired).toBe(true);
    expect(state.availability.slots).toEqual([]);
    expect(domainOutcomeReceipts(state)).toMatchObject([
      {
        callId: "tool-1",
        outcome: "insurance_updated",
        status: "success",
        toolName: "update_insurance",
      },
    ]);
  });

  it("returns update-insurance prerequisites without a tool error", async () => {
    const state = createState();
    // @ts-expect-error Verify rejection of a malformed active patient from runtime state.
    state.identity.activePatient!.patientId = null;

    await expect(
      update_insurance.execute({ insuranceMemberId: "ABC123" }, {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never),
    ).resolves.toBe("I need to verify the patient before updating insurance.");

    state.identity.activePatient!.patientId = "patient-1";
    state.insurance.lastEligibilityCheck = null;
    await expect(
      update_insurance.execute({ insuranceMemberId: "ABC123" }, {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-2",
      } as never),
    ).resolves.toBe(
      "I need to confirm that we accept the new coverage before updating it.",
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
