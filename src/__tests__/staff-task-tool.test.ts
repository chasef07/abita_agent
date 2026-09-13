import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolError } from "@livekit/agents";
import type { PatientResolveResult } from "../clients/owned-middleware.js";
import { objectSchema } from "./support/tool-schema.js";
import {
  RHEUMATOLOGY_DEMO_TRUNK_PHONE,
  NEW_TAMPA_DEMO_TRUNK_PHONE,
  SPRING_HILL_OFFICE_PHONE,
  SWEETWATER_OFFICE_PHONE,
  SWEETWATER_OPTICAL_TRUNK_PHONE,
  SWEETWATER_TRUNK_PHONES,
} from "../customers/abita/profile.js";
import type { InitialCallStateInput } from "../state/call-state.js";
import { domainOutcomeReceipts } from "../state/observability.js";
import {
  beginNewPatientRegistration,
  beginPatientCreation,
  commitPatientCreation,
} from "../identity/patient-identity.js";
import { createResolvePatientTool } from "../tools/resolve-patient.js";
import { InMemoryOwnedMiddleware } from "./support/owned-middleware.js";
import { check_insurance, create_staff_task } from "../tools/index.js";
import { getAcuityProductStaffTasksUrl } from "../tools/create-staff-task.js";
import { createConfirmedPatientState } from "./support/call-state.js";

const PRODUCT_TASK_URL = "https://acuity-product.example/v1/tasks";
const PRODUCT_TASK_ID = "11111111-1111-4111-8111-111111111111";

function createState(overrides: Partial<InitialCallStateInput> = {}) {
  return createConfirmedPatientState({
    trunkPhone: "+18135484830",
    ...overrides,
  });
}

function createToolContext(state: ReturnType<typeof createState>) {
  return {
    disallowInterruptions: vi.fn(),
    session: { userData: state },
  };
}

function createDevState(overrides: Partial<InitialCallStateInput> = {}) {
  return createState({
    officeKey: "rheumatology-demo",
    trunkPhone: RHEUMATOLOGY_DEMO_TRUNK_PHONE,
    ...overrides,
  });
}

function configureProductTasks() {
  vi.stubEnv(
    "ACUITY_PRODUCT_HANDOFF_URL",
    "https://acuity-product.example/v1/handoffs",
  );
  vi.stubEnv("ACUITY_DEMO_PRODUCT_SERVICE_SECRET", "demo-secret");
  vi.stubEnv("ABITA_EYE_GROUP_PRODUCT_SERVICE_SECRET", "production-secret");
}

function expectIdenticalTaskRequests(
  calls: readonly (readonly unknown[])[],
): void {
  const [firstUrl, firstInit] = calls[0] as [string, RequestInit];
  const [secondUrl, secondInit] = calls[1] as [string, RequestInit];
  expect(secondUrl).toBe(firstUrl);
  expect(secondInit.body).toBe(firstInit.body);
  expect(secondInit.headers).toEqual(firstInit.headers);
  expect(secondInit.method).toBe(firstInit.method);
}

describe("create_staff_task", () => {
  beforeEach(() => {
    configureProductTasks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("accepts exactly the nine shared categories and rejects billing", () => {
    const input = {
      urgency: "normal",
      summary: "Follow-up",
      message: "Staff review requested.",
    };
    for (const category of [
      "appointments",
      "documentation",
      "medication",
      "optical",
      "referrals",
      "other",
      "insurance",
      "pre_op",
      "post_op",
    ]) {
      expect(
        objectSchema(create_staff_task.parameters).safeParse({
          ...input,
          category,
        }).success,
        category,
      ).toBe(true);
    }
    expect(
      objectSchema(create_staff_task.parameters).safeParse({
        ...input,
        category: "billing",
      }).success,
    ).toBe(false);
  });

  it("retains the intended unmatched patient without attaching the previous chart or deduplicating another patient", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (): Promise<Response> =>
      Response.json({
        status: "created",
        taskId: `task-${fetchMock.mock.calls.length}`,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const state = createState();
    const options = {
      ctx: createToolContext(state) as never,
      toolCallId: "identity-intake",
    } as never;
    const resolve = createResolvePatientTool(
      new InMemoryOwnedMiddleware({
        resolvePatient: [
          {
            status: "candidates",
            source: "first_name",
            complete: true,
            matches: [],
          },
          {
            status: "candidates",
            source: "first_name",
            complete: true,
            matches: [],
          },
        ],
      }),
    );
    const input = {
      category: "documentation" as const,
      urgency: "normal" as const,
      summary: "Visit summary",
      message: "Patient requests a visit summary for staff review.",
    };
    for (const firstName of ["Alex", "Morgan"]) {
      await resolve.execute({ firstName, dob: "02/03/1990" }, options);
      await create_staff_task.execute(input, options);
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const bodies = fetchMock.mock.calls.map((call) =>
      JSON.parse(call[1]!.body as string),
    );
    expect(bodies.map((body) => body.patient)).toEqual([
      { name: "Alex", dob: "02/03/1990" },
      { name: "Morgan", dob: "02/03/1990" },
    ]);
    expect(bodies[0].idempotencyKey).not.toBe(bodies[1].idempotencyKey);
    expect(bodies.map((body) => body.callId)).toEqual([
      "call-test",
      "call-test",
    ]);
    expect(state.identity.activePatient).toBeNull();
  });

  it("rejects over-limit intake without sending or truncating any details, then accepts a lossless revision", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({ status: "created", taskId: "complete-intake" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const options = {
      ctx: createToolContext(createState()) as never,
      toolCallId: "long-intake",
    } as never;
    const input = {
      category: "documentation" as const,
      urgency: "normal" as const,
      summary: "Attorney records request",
      message: "x".repeat(2501),
    };
    await expect(create_staff_task.execute(input, options)).rejects.toThrow(
      "No request was sent",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    const message =
      "Requester: attorney office, Example Legal. Requested: full records. Delivery: fax, +12025550199. Records request faxed: caller reports yes, September 1. Patient authorization faxed: no. Not ready for fulfillment; both documents must be faxed first. Missing: patient DOB, authorization fax date.";
    await create_staff_task.execute({ ...input, message }, options);
    expect(
      JSON.parse(fetchMock.mock.calls[0]![1]!.body as string).message,
    ).toBe(message);
  });

  it("preserves an incomplete new-patient registration without inventing a chart", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({ status: "created", taskId: "registration-follow-up" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const state = createState();
    beginNewPatientRegistration(state, {
      firstName: "Morgan",
      lastName: "Example",
    });
    await create_staff_task.execute(
      {
        category: "documentation",
        urgency: "normal",
        summary: "Records follow-up",
        message: "Caller requests records. Missing details: DOB.",
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "registration-task",
      } as never,
    );
    expect(
      JSON.parse(fetchMock.mock.calls[0]![1]!.body as string).patient,
    ).toEqual({ name: "Morgan Example" });
  });

  it("uses the created chart after the same registration is refreshed during creation", async () => {
    const transport = vi.fn<typeof fetch>(async () =>
      Response.json({ status: "created", taskId: "created-patient-task" }),
    );
    vi.stubGlobal("fetch", transport);
    const state = createState();
    const identity = {
      firstName: "Morgan",
      lastName: "Example",
      dob: "02/03/1990",
    };
    beginNewPatientRegistration(state, identity);
    const operation = beginPatientCreation(state)!;
    beginNewPatientRegistration(state, identity);
    expect(
      commitPatientCreation(state, operation, {
        status: "created",
        patientId: "created-morgan",
        name: "Morgan Example",
        dob: identity.dob,
        phone: "+12025550147",
        insuranceCarrier: null,
        insPlanId: null,
        respPartyId: null,
        routing: null,
        preauthRequired: false,
      }).outcome,
    ).toBe("activated");
    await create_staff_task.execute(
      {
        category: "documentation",
        urgency: "normal",
        summary: "Records follow-up",
        message: "Morgan requests records.",
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "created-patient-task",
      } as never,
    );
    expect(
      JSON.parse(transport.mock.calls[0]![1]!.body as string).patient,
    ).toEqual({
      id: "created-morgan",
      name: "Morgan Example",
      dob: identity.dob,
    });
  });

  it("keeps verified chart identity when the same preloaded patient is resolved twice", async () => {
    const transport = vi.fn<typeof fetch>(async () =>
      Response.json({ status: "created", taskId: "verified-again" }),
    );
    vi.stubGlobal("fetch", transport);
    const state = createState({
      preCallCandidates: [
        {
          status: "verified",
          ref: "alex",
          patientId: "synthetic-alex",
          firstName: "Alex",
          lastName: "Example",
          dob: "02/03/1990",
          appointments: [],
          appointmentsStatus: "none",
        },
      ],
    });
    const options = {
      ctx: createToolContext(state) as never,
      toolCallId: "same-patient",
    } as never;
    const resolve = createResolvePatientTool(new InMemoryOwnedMiddleware());
    for (let i = 0; i < 2; i++)
      await resolve.execute({ firstName: "Alex", dob: null }, options);
    await create_staff_task.execute(
      {
        category: "optical",
        urgency: "normal",
        summary: "Glasses copy",
        message: "Patient requests a glasses prescription copy.",
      },
      options,
    );
    expect(
      JSON.parse(transport.mock.calls[0]![1]!.body as string).patient,
    ).toEqual({
      id: "synthetic-alex",
      name: "Alex Example",
      dob: "02/03/1990",
    });
  });

  it.each(["full lookup", "candidate hydration", "registration"])(
    "keeps the newer incomplete Task patient when an older %s completes",
    async (mode) => {
      const transport = vi.fn<typeof fetch>(async () =>
        Response.json({ status: "created", taskId: "newer-patient" }),
      );
      vi.stubGlobal("fetch", transport);
      const state = createState();
      const options = {
        ctx: createToolContext(state) as never,
        toolCallId: "pending-patient",
      } as never;
      const receipt = {
        status: "verified" as const,
        patientId: "synthetic-alex",
        name: "Alex Example",
        dob: "02/03/1990",
        phone: "+12025550147",
        appointments: [],
        appointmentsStatus: "none" as const,
        appointmentsMessage: null,
        message: null,
        insuranceCarrier: null,
        insPlanId: null,
        respPartyId: null,
        routing: null,
        allowedProviders: [],
        routingAmbiguous: false,
        preauthRequired: false,
      };
      let finish!: (value: typeof receipt) => void;
      const pending = new Promise<typeof receipt>((resolve) => {
        finish = resolve;
      });
      const resolve = createResolvePatientTool(
        new InMemoryOwnedMiddleware({ resolvePatient: [pending] }),
      );
      if (mode === "candidate hydration")
        state.identity.privateCandidates = [
          {
            status: "candidate",
            ref: "alex",
            patientId: "synthetic-alex",
            firstName: "Alex",
            lastName: "Example",
            dob: "02/03/1990",
            appointments: [],
          },
        ];
      let older: Promise<unknown> | undefined;
      let registration: ReturnType<typeof beginPatientCreation> = null;
      if (mode === "registration") {
        beginNewPatientRegistration(state, {
          firstName: "Alex",
          lastName: "Example",
          dob: "02/03/1990",
        });
        registration = beginPatientCreation(state);
      } else {
        older = resolve.execute(
          { firstName: "Alex", dob: "02/03/1990" },
          options,
        );
        await Promise.resolve();
        await Promise.resolve();
      }
      await resolve.execute({ firstName: "Morgan", dob: null }, options);
      if (registration)
        commitPatientCreation(state, registration, {
          ...receipt,
          status: "created",
        });
      else {
        finish(receipt);
        await older;
      }
      await create_staff_task.execute(
        {
          category: "documentation",
          urgency: "normal",
          summary: "Records request",
          message: "Morgan requests records. Missing details: surname and DOB.",
        },
        options,
      );
      expect(
        JSON.parse(transport.mock.calls[0]![1]!.body as string).patient,
      ).toEqual({ name: "Morgan" });
    },
  );

  it.each([false, true])(
    "preserves the current patient evidence when an older lookup completes (verified phone candidate=%s)",
    async (preloaded) => {
      const transport = vi.fn<typeof fetch>(async () =>
        Response.json({ status: "created", taskId: "reconfirmed" }),
      );
      vi.stubGlobal("fetch", transport);
      const state = createState();
      if (preloaded)
        state.identity.privateCandidates = [
          {
            status: "verified",
            ref: "jane",
            patientId: "patient-1",
            firstName: "Jane",
            lastName: "Doe",
            dob: "01/01/1980",
            appointments: [],
            appointmentsStatus: "none",
          },
        ];
      let finish!: (result: PatientResolveResult) => void;
      const pending = new Promise<PatientResolveResult>((resolve) => {
        finish = resolve;
      });
      const middleware = new InMemoryOwnedMiddleware({
        resolvePatient: [pending],
      });
      const resolve = createResolvePatientTool(middleware);
      const options = {
        ctx: createToolContext(state) as never,
        toolCallId: "reconfirm",
      } as never;
      const oldLookup = resolve.execute(
        { firstName: "Alex", dob: "02/03/1990" },
        options,
      );
      await vi.waitFor(() =>
        expect(middleware.requests.resolvePatient).toHaveLength(1),
      );
      await resolve.execute({ firstName: "Jane", dob: null }, options);
      finish({
        status: "verified",
        patientId: "synthetic-alex",
        name: "Alex Example",
        dob: "02/03/1990",
        phone: null,
        appointments: [],
        appointmentsStatus: "none",
        insuranceCarrier: null,
        routing: null,
        insPlanId: null,
        respPartyId: null,
        preauthRequired: false,
        appointmentsMessage: null,
        message: null,
      });
      await oldLookup;
      await create_staff_task.execute(
        {
          category: "optical",
          urgency: "normal",
          summary: "Glasses copy",
          message: "Jane requests a glasses prescription copy.",
        },
        options,
      );
      expect(
        JSON.parse(transport.mock.calls[0]![1]!.body as string).patient,
      ).toEqual(
        preloaded
          ? { id: "patient-1", name: "Jane Doe", dob: "01/01/1980" }
          : { name: "Jane" },
      );
    },
  );

  it("derives the Product task URL from the shared Product handoff URL", () => {
    expect(
      getAcuityProductStaffTasksUrl({
        ACUITY_PRODUCT_HANDOFF_URL:
          "https://acuity-product.example/v1/handoffs",
      }),
    ).toBe(PRODUCT_TASK_URL);
    expect(
      getAcuityProductStaffTasksUrl({
        ACUITY_PRODUCT_HANDOFF_URL: "https://acuity-product.example/other",
      }),
    ).toBeUndefined();
  });

  it("routes a production task to Product with the production tenant credential", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({
        status: "created",
        taskId: "task-1",
        category: "insurance",
        urgency: "high_priority",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const state = createState({
      officeKey: "sweetwater",
      trunkPhone: SWEETWATER_TRUNK_PHONES[1],
    });
    const ctx = createToolContext(state);

    const result = await create_staff_task.execute(
      {
        category: "insurance",
        urgency: "high_priority",
        summary: "Caller has a coverage question.",
        message:
          "Caller needs staff to review an unresolved coverage question.",
      },
      {
        ctx: ctx as never,
        toolCallId: "tool-1",
      } as never,
    );

    expect(result).toBe(
      "I wrote that down for the team. They'll review it and follow up.",
    );
    expect(ctx.disallowInterruptions).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      PRODUCT_TASK_URL,
      expect.objectContaining({
        headers: {
          Authorization: "Bearer production-secret",
          "Content-Type": "application/json",
        },
        method: "POST",
      }),
    );

    const body = JSON.parse(
      fetchMock.mock.calls[0]?.[1]?.body as string,
    ) as Record<string, unknown>;
    expect(body).toMatchObject({
      callId: "call-test",
      callerPhone: "+17275551212",
      category: "insurance",
      inboundOfficePhone: SWEETWATER_TRUNK_PHONES[1],
      message: "Caller needs staff to review an unresolved coverage question.",
      officeKey: "sweetwater",
      officePhone: SWEETWATER_OFFICE_PHONE,
      source: "agent",
      summary: "Caller has a coverage question.",
      urgency: "high_priority",
    });
    expect(body.idempotencyKey).toMatch(/^staff_task_[a-f0-9]{64}$/);
    expect(body.patient).toEqual({
      dob: "01/01/1980",
      id: "patient-1",
      name: "Jane Doe",
    });
    expect(state.runtime.staffTasks).toMatchObject([
      {
        idempotencyKey: body.idempotencyKey,
        status: "created",
        taskId: "task-1",
      },
    ]);
    expect(JSON.stringify(state.runtime.staffTasks)).not.toContain(
      "Caller needs staff",
    );
  });

  it("records a prior-authorization task after the insurance check requires staff follow-up", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({
        status: "created",
        taskId: "prior-auth-task-1",
        category: "insurance",
        urgency: "normal",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const state = createState({
      officeKey: "sweetwater",
      trunkPhone: SWEETWATER_TRUNK_PHONES[1],
    });
    state.office.activeKey = "sweetwater";
    const ctx = createToolContext(state);

    const insuranceResult = await check_insurance.execute(
      {
        plan: "United Healthcare Individual Exchange Network (Medical)",
        coverageType: "medical",
      },
      { ctx: ctx as never, toolCallId: "insurance-tool-1" } as never,
    );

    expect(insuranceResult).toBe(
      "This plan requires prior authorization before we can schedule. I can send a task to staff to follow up with the insurance company. Is that okay?",
    );
    expect(typeof insuranceResult).toBe("string");

    const taskResult = await create_staff_task.execute(
      {
        category: "insurance",
        urgency: "normal",
        summary:
          "Prior authorization for United Healthcare Individual Exchange Network.",
        message:
          "Jane Doe needs prior authorization from United Healthcare Individual Exchange Network for a medical eye visit before scheduling.",
      },
      { ctx: ctx as never, toolCallId: "task-tool-1" } as never,
    );

    expect(taskResult).toBe(
      "I wrote that down for the team. They'll review it and follow up.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      fetchMock.mock.calls[0]?.[1]?.body as string,
    ) as Record<string, unknown>;
    expect(body).toMatchObject({
      category: "insurance",
      message:
        "Jane Doe needs prior authorization from United Healthcare Individual Exchange Network for a medical eye visit before scheduling.",
      patient: {
        dob: "01/01/1980",
        id: "patient-1",
        name: "Jane Doe",
      },
      summary:
        "Prior authorization for United Healthcare Individual Exchange Network.",
      urgency: "normal",
    });
    expect(state.runtime.staffTasks).toMatchObject([
      {
        status: "created",
        taskId: "prior-auth-task-1",
      },
    ]);
  });

  it("blocks staff tasks for sandbox demos even if active office changes", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json(
        {
          status: "created",
          taskId: PRODUCT_TASK_ID,
          category: "other",
          urgency: "normal",
        },
        { status: 201 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const state = createDevState({
      callerPhone: "17275551212",
    });
    state.office.activeKey = "spring-hill";

    const result = await create_staff_task.execute(
      {
        category: "other",
        urgency: "normal",
        summary: "Caller has a follow-up request.",
        message: "Caller wants the Harborleaf team to review their question.",
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    );

    expect(result).toContain(
      "Staff tasks are unavailable in this sandbox call",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.runtime.staffTasks).toEqual([]);
    expect(domainOutcomeReceipts(state)).toMatchObject([
      { outcome: "staff_task_failed", status: "blocked" },
    ]);
  });

  it("blocks staff tasks on a dedicated demo trunk", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json(
        {
          status: "created",
          taskId: PRODUCT_TASK_ID,
          category: "appointments",
          urgency: "normal",
        },
        { status: 201 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const state = createDevState({
      officeKey: "new-tampa-demo",
      trunkPhone: NEW_TAMPA_DEMO_TRUNK_PHONE,
    });

    await create_staff_task.execute(
      {
        category: "appointments",
        urgency: "normal",
        summary: "Caller needs scheduling help.",
        message:
          "Caller wants the New Tampa team to review a scheduling question.",
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-new-tampa-demo",
      } as never,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.runtime.staffTasks).toEqual([]);
  });

  it("preserves the sweetwater-optical Product route from the inbound trunk", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json(
        { status: "created", taskId: PRODUCT_TASK_ID },
        { status: 201 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const state = createState({
      officeKey: "sweetwater",
      trunkPhone: SWEETWATER_OPTICAL_TRUNK_PHONE,
    });

    await create_staff_task.execute(
      {
        category: "optical",
        urgency: "normal",
        summary: "Caller has an optical request.",
        message: "Caller wants the optical team to review their request.",
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    );

    const body = JSON.parse(
      fetchMock.mock.calls[0]?.[1]?.body as string,
    ) as Record<string, unknown>;
    expect(body).toMatchObject({
      inboundOfficePhone: SWEETWATER_OPTICAL_TRUNK_PHONE,
      officeKey: "sweetwater-optical",
      officePhone: SWEETWATER_OFFICE_PHONE,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      PRODUCT_TASK_URL,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer production-secret",
        }),
      }),
    );
  });

  it("returns the existing receipt for a duplicate task in one call", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({ status: "created", taskId: "task-1" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const state = createState();
    const ctx = createToolContext(state);
    const input = {
      category: "documentation" as const,
      urgency: "normal" as const,
      summary: "Caller needs paperwork sent.",
      message: "Caller wants the team to send the school form.",
    };

    await create_staff_task.execute(input, {
      ctx: ctx as never,
      toolCallId: "tool-1",
    } as never);
    const result = await create_staff_task.execute(input, {
      ctx: ctx as never,
      toolCallId: "tool-2",
    } as never);

    expect(result).toBe(
      "I already sent that to the team. They'll review it and follow up.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(state.runtime.staffTasks).toHaveLength(1);
    expect(domainOutcomeReceipts(state)).toMatchObject([
      {
        callId: "tool-1",
        evidence: { taskId: "task-1" },
        outcome: "staff_task_created",
        status: "success",
        toolName: "create_staff_task",
      },
      {
        callId: "tool-2",
        evidence: { taskId: "task-1" },
        outcome: "staff_task_duplicate",
        status: "success",
        toolName: "create_staff_task",
      },
    ]);
  });

  it("leaves missing delivery configuration as an internal error", async () => {
    vi.stubEnv("ABITA_EYE_GROUP_PRODUCT_SERVICE_SECRET", "");
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const state = createState();

    const failure = create_staff_task.execute(
      {
        category: "other",
        urgency: "normal",
        summary: "Caller wants a message sent.",
        message: "Caller wants Debbie to call them back about their glasses.",
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    );

    await expect(failure).rejects.toThrow(
      "Staff task delivery is not configured.",
    );
    await expect(failure).rejects.not.toBeInstanceOf(ToolError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.runtime.staffTasks).toEqual([]);
  });

  it.each([408, 429, 500, 503])(
    "retries status %i exactly once with the identical request",
    async (status) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status }))
        .mockResolvedValueOnce(
          Response.json(
            { status: "created", taskId: PRODUCT_TASK_ID },
            { status: 201 },
          ),
        );
      vi.stubGlobal("fetch", fetchMock);
      const state = createState();

      const result = await create_staff_task.execute(
        {
          category: "other",
          urgency: "normal",
          summary: "Caller wants a message sent.",
          message: "Caller wants Debbie to call them back about their glasses.",
        },
        {
          ctx: createToolContext(state) as never,
          toolCallId: "tool-1",
        } as never,
      );

      expect(result).toBe(
        "I wrote that down for the team. They'll review it and follow up.",
      );
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expectIdenticalTaskRequests(fetchMock.mock.calls);
      expect(state.runtime.staffTasks).toHaveLength(1);
    },
  );

  it.each([
    ["transport failure", () => Promise.reject(new Error("connection reset"))],
    [
      "uncertain response-body read",
      () => Promise.resolve(new Response("{", { status: 201 })),
    ],
  ])("retries %s exactly once", async (_name, firstAttempt) => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(firstAttempt)
      .mockResolvedValueOnce(
        Response.json(
          { status: "created", taskId: PRODUCT_TASK_ID },
          { status: 201 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const state = createState();

    const result = await create_staff_task.execute(
      {
        category: "other",
        urgency: "normal",
        summary: "Caller wants a message sent.",
        message: "Caller wants Debbie to call them back about their glasses.",
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    );

    expect(result).toBe(
      "I wrote that down for the team. They'll review it and follow up.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expectIdenticalTaskRequests(fetchMock.mock.calls);
    expect(state.runtime.staffTasks).toHaveLength(1);
  });

  it("returns a safe ToolError after one retryable failure retry", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 503 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const state = createState();

    const failure = create_staff_task.execute(
      {
        category: "other",
        urgency: "normal",
        summary: "Caller wants a message sent.",
        message: "Caller wants Debbie to call them back about their glasses.",
      },
      {
        ctx: createToolContext(state) as never,
        toolCallId: "tool-1",
      } as never,
    );

    await expect(failure).rejects.toThrow(
      "I couldn't send the message. I can transfer you to the office.",
    );
    await expect(failure).rejects.toBeInstanceOf(ToolError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(state.runtime.staffTasks).toEqual([]);
    expect(domainOutcomeReceipts(state)).toMatchObject([
      {
        callId: "tool-1",
        outcome: "staff_task_failed",
        status: "failed",
        toolName: "create_staff_task",
      },
    ]);
  });

  it.each([400, 401, 403, 409])(
    "does not retry permanent status %i",
    async (status) => {
      const fetchMock = vi.fn<typeof fetch>(
        async () => new Response(null, { status }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const state = createState({ trunkPhone: SPRING_HILL_OFFICE_PHONE });

      const failure = create_staff_task.execute(
        {
          category: "other",
          urgency: "normal",
          summary: "Caller wants a message sent.",
          message: "Caller wants Debbie to call them back about their glasses.",
        },
        {
          ctx: createToolContext(state) as never,
          toolCallId: "tool-1",
        } as never,
      );

      await expect(failure).rejects.toThrow(
        `Staff task POST returned ${status}`,
      );
      await expect(failure).rejects.not.toBeInstanceOf(ToolError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(state.runtime.staffTasks).toEqual([]);
    },
  );
});
