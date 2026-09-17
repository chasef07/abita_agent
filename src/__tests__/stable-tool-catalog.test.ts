import type { PatientResolveVerified } from "../clients/owned-middleware.js";
import {
  AgentSession,
  type ChatContext,
  initializeLogger,
  ToolContext,
  voice,
} from "@livekit/agents";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createVoiceAgent } from "../agent.js";
import {
  CRYSTAL_RIVER_OFFICE_PHONE,
  SPRING_HILL_OFFICE_PHONE,
} from "../customers/abita/profile.js";
import {
  buildPreCallCandidates,
  lookupByPhone,
} from "../runtime/precall-bootstrap.js";
import { buildToolsForTrunk } from "../runtime/tool-registry.js";
import { setLastInsuranceEligibilityCheck } from "../scheduling/state.js";
import type { CallState } from "../state/call-state.js";
import { appointmentActions } from "../state/observability.js";
import {
  confirmedActivePatient,
  createConfirmedPatientState,
  createTestCallState,
} from "./support/call-state.js";
import {
  InMemoryOwnedMiddleware,
  candidateSearchResult,
} from "./support/owned-middleware.js";

class ToolCapturingFakeLLM extends voice.testing.FakeLLM {
  readonly toolRequests: string[][] = [];
  readonly contexts: ChatContext[] = [];

  override chat(options: Parameters<voice.testing.FakeLLM["chat"]>[0]) {
    const toolCtx = options.toolCtx as ToolContext<CallState> | undefined;
    this.toolRequests.push(Object.keys(toolCtx?.functionTools ?? {}).sort());
    this.contexts.push(options.chatCtx.copy());
    return super.chat(options);
  }
}

const SUPPORTED_TOOLS = [
  "add_patient",
  "book_appointment",
  "cancel_appointment",
  "check_insurance",
  "search_office_knowledge",
  "create_staff_task",
  "end_call",
  "list_available_appointments",
  "reschedule_appointment",
  "resolve_patient",
  "transfer_call",
  "update_insurance",
].sort();

describe("stable tool catalog", () => {
  beforeAll(() => {
    initializeLogger({ pretty: false, level: "silent" });
  });

  const sessions: AgentSession<CallState>[] = [];
  const defaultMiddleware = new InMemoryOwnedMiddleware();

  afterEach(async () => {
    await Promise.all(sessions.splice(0).map((session) => session.close()));
  });

  it("keeps pre-call, identity, and availability work on one call-scoped middleware", async () => {
    const middleware = new InMemoryOwnedMiddleware({
      resolvePatient: [
        { status: "not_found" },
        candidateSearchResult(verifiedPatient()),
        verifiedPatient(),
      ],
      getAvailability: [availabilityFound()],
    });
    const preCall = await lookupByPhone(
      middleware,
      "+17275551212",
      SPRING_HILL_OFFICE_PHONE,
    );
    const state = createTestCallState({
      preCallCandidates: buildPreCallCandidates(preCall),
      preCallLookup: { status: preCall?.status ?? "not_attempted" },
    });
    state.workflow.visitType = "medical";
    const llm = new ToolCapturingFakeLLM([
      {
        input: "This is Jane Doe, January 1, 1980.",
        toolCalls: [
          {
            name: "resolve_patient",
            args: {
              firstName: "Jane",
              dob: "01/01/1980",
            },
          },
        ],
      },
      {
        input: "Find the next medical appointment.",
        toolCalls: [
          {
            name: "list_available_appointments",
            args: {
              visitType: "medical",
            },
          },
        ],
      },
    ]);
    const session = new AgentSession<CallState>({ llm });
    sessions.push(session);
    session.userData = state;

    await session.start({
      agent: createVoiceAgent(SPRING_HILL_OFFICE_PHONE, {
        ownedMiddleware: middleware,
        suppressGreeting: true,
      }).agent,
    });
    await session
      .run({ userInput: "This is Jane Doe, January 1, 1980." })
      .wait();
    await session
      .run({ userInput: "Find the next medical appointment." })
      .wait();

    expect(middleware.operations.map(({ name }) => name)).toEqual([
      "resolvePatient",
      "resolvePatient",
      "getAvailability",
    ]);
    expect(middleware.requests.getAvailability).toEqual([
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ]);
  });

  it("keeps every supported tool visible across Call State changes", async () => {
    const unresolved = createTestCallState();
    const newPatient = createTestCallState();
    setLastInsuranceEligibilityCheck(newPatient, acceptedInsurance());
    const activePatient = createConfirmedPatientState();
    const availabilityLoaded = createConfirmedPatientState();
    availabilityLoaded.workflow.visitType = "medical";
    availabilityLoaded.availability.slots = [storedSlot()];
    const postMutation = createConfirmedPatientState();
    postMutation.identity.activePatient!.appointments = [
      {
        id: 456,
        date: "Tuesday, September 1, 2026",
        time: "9:00 AM",
        provider: "Dr. Bach",
        type: "Medical",
        facility: "Spring Hill",
        confirmed: true,
      },
    ];

    for (const [name, state] of [
      ["unresolved", unresolved],
      ["new-patient", newPatient],
      ["active-patient", activePatient],
      ["availability-loaded", availabilityLoaded],
      ["post-mutation", postMutation],
    ] as const) {
      const llm = new ToolCapturingFakeLLM([
        { input: name, content: "I can continue." },
      ]);
      const session = new AgentSession<CallState>({ llm });
      sessions.push(session);
      session.userData = state;
      const { agent } = createVoiceAgent(SPRING_HILL_OFFICE_PHONE, {
        ownedMiddleware: defaultMiddleware,
        suppressGreeting: true,
      });
      const updateTools = vi.spyOn(agent, "updateTools");

      await session.start({ agent });
      await session.run({ userInput: name }).wait();

      expect(llm.toolRequests).toEqual([SUPPORTED_TOOLS]);
      expect(updateTools).not.toHaveBeenCalled();
      expect(Object.keys(agent.toolCtx.functionTools).sort()).toEqual(
        SUPPORTED_TOOLS,
      );
    }
  });

  it("keeps Office Profile capability filtering authoritative", () => {
    expect(toolNamesForTrunk(SPRING_HILL_OFFICE_PHONE)).toEqual(
      SUPPORTED_TOOLS,
    );
    expect(toolNamesForTrunk(CRYSTAL_RIVER_OFFICE_PHONE)).toEqual(
      SUPPORTED_TOOLS.filter((name) => name !== "create_staff_task"),
    );
  });

  it.each([
    "I'm Jane, calling for my son John.",
    "I am not Jane. This appointment is for John.",
  ])(
    "activates the intended patient only through the tool for %s",
    async (input) => {
      const candidates = ["Jane", "John"].map((firstName) => ({
        status: "verified" as const,
        ref: firstName,
        firstName,
        lastName: "Doe",
        dob: "01/01/1980",
        patientId: firstName,
        appointments: [],
        appointmentsStatus: "none" as const,
      }));
      const state = createTestCallState({
        preCallCandidates: candidates,
        preCallLookup: { status: "multiple_matches" },
      });
      const middleware = new InMemoryOwnedMiddleware();
      const model = new ToolCapturingFakeLLM([
        {
          input,
          toolCalls: [
            {
              name: "resolve_patient",
              args: {
                firstName: "John",
                dob: null,
              },
            },
          ],
        },
      ]);
      const session = new AgentSession<CallState>({ llm: model });
      sessions.push(session);
      session.userData = state;
      await session.start({
        agent: createVoiceAgent(SPRING_HILL_OFFICE_PHONE, {
          ownedMiddleware: middleware,
          suppressGreeting: true,
        }).agent,
      });
      await session.run({ userInput: input }).wait();
      expect(state.identity.activePatient?.patientId).toBe("John");
      expect(middleware.operations).toEqual([]);
      expect(
        JSON.stringify(
          model.contexts
            .at(-1)!
            .items.filter((item) => item.type === "function_call_output"),
        ),
      ).toContain("I found you in our system, John Doe.");
    },
  );

  it("returns resolved patient details through tool history while the catalog stays stable", async () => {
    const verifiedReply =
      "Verified existing patient Jane Doe. No upcoming appointments are loaded.";
    const llm = new ToolCapturingFakeLLM([
      {
        input: "This is for Jane Doe, January 2, 1980.",
        toolCalls: [
          {
            name: "resolve_patient",
            args: {
              firstName: "Jane",
              dob: "01/02/1980",
            },
          },
        ],
      },
      {
        input: JSON.stringify(verifiedReply),
        content: "I found the patient record.",
      },
    ]);
    const session = new AgentSession<CallState>({ llm });
    sessions.push(session);
    session.userData = createTestCallState();
    const middleware = new InMemoryOwnedMiddleware({
      resolvePatient: [
        candidateSearchResult(verifiedPatient({ dob: "01/02/1980" })),
        verifiedPatient({
          dob: "01/02/1980",
          insuranceCarrier: null,
          routing: null,
        }),
      ],
    });

    await session.start({
      agent: createVoiceAgent(SPRING_HILL_OFFICE_PHONE, {
        ownedMiddleware: middleware,
        suppressGreeting: true,
      }).agent,
    });
    await session
      .run({ userInput: "This is for Jane Doe, January 2, 1980." })
      .wait();

    expect(llm.toolRequests).toEqual([SUPPORTED_TOOLS, SUPPORTED_TOOLS]);
    expect(session.userData.identity.activePatient?.name).toBe("Jane Doe");
    expect(
      llm.contexts[0]!.items.some(
        (item) => item.type === "function_call_output",
      ),
    ).toBe(false);
    expect(
      JSON.stringify(
        llm.contexts[1]!.items.filter(
          (item) => item.type === "function_call_output",
        ),
      ),
    ).toContain("I found you in our system, Jane Doe.");
  });

  it("returns the add_patient identity guard before middleware mutation", async () => {
    const middleware = new InMemoryOwnedMiddleware({
      resolvePatient: [candidateSearchResult()],
      createPatient: [createdPatient()],
    });
    const state = createTestCallState({
      activePatient: confirmedActivePatient({
        patientId: "patient-existing",
        name: "John Smith",
        dob: "02/02/1970",
        appointmentsStatus: "found",
        appointments: [
          {
            id: 123,
            date: "Monday, August 31, 2026",
            time: "9:00 AM",
            provider: "Dr. Bach",
            type: "Follow-up",
            facility: "Spring Hill",
            confirmed: true,
          },
        ],
      }),
    });
    setLastInsuranceEligibilityCheck(state, acceptedInsurance());
    const activePatientBefore = structuredClone(state.identity.activePatient);
    const llm = new ToolCapturingFakeLLM([
      {
        input: "Register the new patient now.",
        toolCalls: [
          {
            name: "add_patient",
            args: completeRegistration(),
          },
        ],
      },
      {
        input: "Check whether Jane already has a chart.",
        toolCalls: [
          {
            name: "resolve_patient",
            args: {
              firstName: "Jane",
              dob: "01/01/1980",
            },
          },
        ],
      },
      {
        input: "Try creating Jane before checking insurance.",
        toolCalls: [
          {
            name: "add_patient",
            args: completeRegistration(),
          },
        ],
      },
      {
        input: "Check self pay for the medical visit.",
        toolCalls: [
          {
            name: "check_insurance",
            args: { plan: "self pay", coverageType: "medical" },
          },
        ],
      },
      {
        input: "Create Jane's chart now.",
        toolCalls: [
          {
            name: "add_patient",
            args: completeRegistration(),
          },
        ],
      },
    ]);
    const session = new AgentSession<CallState>({ llm });
    sessions.push(session);
    session.userData = state;

    await session.start({
      agent: createVoiceAgent(SPRING_HILL_OFFICE_PHONE, {
        ownedMiddleware: middleware,
        suppressGreeting: true,
      }).agent,
    });
    await session.run({ userInput: "Register the new patient now." }).wait();

    expect(toolOutputs(session)[0]).toMatchObject({
      isError: false,
      output: JSON.stringify(
        "I need to check whether this patient already has a chart before creating a new one.",
      ),
    });
    expect(middleware.operations).toEqual([]);
    expect(session.userData.identity.activePatient).toEqual(
      activePatientBefore,
    );
    expect(functionCallNames(session)).toEqual(["add_patient"]);
    expect(functionCallNames(session)).not.toContain("create_staff_task");
    expect(functionCallNames(session)).not.toContain("transfer_call");
    expectStableToolRequests(llm);

    await session
      .run({ userInput: "Check whether Jane already has a chart." })
      .wait();
    expect(session.userData.identity.unregisteredPatientReceipt).toEqual({
      identity: {
        firstName: "Jane",
        dob: "01/01/1980",
      },
      lookupOperationVersion: session.userData.identity.operationVersion,
      insuranceCheckVersion: 0,
    });
    await session
      .run({ userInput: "Try creating Jane before checking insurance." })
      .wait();
    expect(middleware.operations.map(({ name }) => name)).toEqual([
      "resolvePatient",
    ]);
    expect(session.userData.identity.activePatient).toBeNull();
    expect(
      session.userData.identity.unregisteredPatientReceipt
        ?.insuranceCheckVersion,
    ).toBe(0);
    await session
      .run({ userInput: "Check self pay for the medical visit." })
      .wait();
    expect(
      session.userData.identity.unregisteredPatientReceipt
        ?.insuranceCheckVersion,
    ).toBe(1);
    await session.run({ userInput: "Create Jane's chart now." }).wait();

    expect(middleware.operations.map(({ name }) => name)).toEqual([
      "resolvePatient",
      "createPatient",
    ]);
    expect(session.userData.identity.activePatient).toMatchObject({
      kind: "created",
      patientId: "patient-new",
      name: "Jane Doe",
    });
    expect(session.userData.identity.unregisteredPatientReceipt).toBeNull();
    expect(functionCallNames(session)).toEqual([
      "add_patient",
      "resolve_patient",
      "add_patient",
      "check_insurance",
      "add_patient",
    ]);
    expect(functionCallNames(session)).not.toContain("create_staff_task");
    expect(functionCallNames(session)).not.toContain("transfer_call");
    expectStableToolRequests(llm);
  });

  it("returns the book_appointment availability guard before middleware mutation", async () => {
    const middleware = new InMemoryOwnedMiddleware();
    const llm = new ToolCapturingFakeLLM([
      {
        input: "Book the appointment now.",
        toolCalls: [
          {
            name: "book_appointment",
            args: currentBooking(),
          },
        ],
      },
    ]);
    const session = new AgentSession<CallState>({ llm });
    sessions.push(session);
    session.userData = createConfirmedPatientState();

    await session.start({
      agent: createVoiceAgent(SPRING_HILL_OFFICE_PHONE, {
        ownedMiddleware: middleware,
        suppressGreeting: true,
      }).agent,
    });
    await session.run({ userInput: "Book the appointment now." }).wait();

    expect(toolOutputs(session)[0]).toMatchObject({
      isError: false,
      output: JSON.stringify(
        "Is this visit for medical care or routine vision?",
      ),
    });
    expect(middleware.operations).toEqual([]);
    expect(appointmentActions(session.userData)).toEqual([]);
    expect(functionCallNames(session)).toEqual(["book_appointment"]);
    expect(functionCallNames(session)).not.toContain("create_staff_task");
    expect(functionCallNames(session)).not.toContain("transfer_call");
    expectStableToolRequests(llm);
  });

  it("recovers from incomplete add_patient arguments and completes booking in the same session", async () => {
    const middleware = new InMemoryOwnedMiddleware({
      createPatient: [createdPatient()],
      getAvailability: [availabilityFound()],
      bookAppointment: [bookedAppointment()],
    });
    const state = createTestCallState();
    setLastInsuranceEligibilityCheck(state, acceptedInsurance());
    const llm = new ToolCapturingFakeLLM([
      {
        input: "Register Jane with the details I have.",
        toolCalls: [
          {
            name: "add_patient",
            args: {
              firstName: "Jane",
              lastName: "Doe",
              dob: "01/01/1980",
            },
          },
        ],
      },
      {
        input: "I collected and confirmed the registration details.",
        toolCalls: [
          {
            name: "add_patient",
            args: completeRegistration(),
          },
        ],
      },
      {
        input: "Find the next medical appointment.",
        toolCalls: [
          {
            name: "list_available_appointments",
            args: {
              visitType: "medical",
            },
          },
        ],
      },
      {
        input: "I confirmed that exact slot.",
        toolCalls: [
          {
            name: "book_appointment",
            args: currentBooking(),
          },
        ],
      },
    ]);
    const session = new AgentSession<CallState>({ llm });
    sessions.push(session);
    session.userData = state;

    await session.start({
      agent: createVoiceAgent(SPRING_HILL_OFFICE_PHONE, {
        ownedMiddleware: middleware,
        suppressGreeting: true,
      }).agent,
    });
    await session
      .run({ userInput: "Register Jane with the details I have." })
      .wait();

    expect(middleware.operations).toEqual([]);
    expect(toolOutputs(session)[0]).toMatchObject({
      isError: true,
      output: expect.stringContaining("Invalid arguments for add_patient"),
    });

    await session
      .run({
        userInput: "I collected and confirmed the registration details.",
      })
      .wait();
    await session
      .run({ userInput: "Find the next medical appointment." })
      .wait();
    await session.run({ userInput: "I confirmed that exact slot." }).wait();

    expect(middleware.operations.map(({ name }) => name)).toEqual([
      "createPatient",
      "getAvailability",
      "bookAppointment",
    ]);
    expect(state.identity.activePatient).toMatchObject({
      kind: "created",
      patientId: "patient-new",
    });
    expect(state.identity.activePatient?.appointments).toContainEqual(
      expect.objectContaining({ id: 456 }),
    );
    expect(functionCallNames(session)).toEqual([
      "add_patient",
      "add_patient",
      "list_available_appointments",
      "book_appointment",
    ]);
    expect(functionCallNames(session)).not.toContain("create_staff_task");
    expect(functionCallNames(session)).not.toContain("transfer_call");
    expectStableToolRequests(llm);
  });

  it("recovers from obsolete book_appointment arguments without premature mutation or escalation", async () => {
    const middleware = new InMemoryOwnedMiddleware({
      getAvailability: [availabilityFound()],
      bookAppointment: [bookedAppointment()],
    });
    const state = createConfirmedPatientState();
    const llm = new ToolCapturingFakeLLM([
      {
        input: "Book it now.",
        toolCalls: [
          {
            name: "book_appointment",
            args: {
              patientId: "patient-1",
              appointmentDate: "2026-09-01",
              appointmentTime: "9:00 AM",
            },
          },
        ],
      },
      {
        input: "Find the next medical appointment.",
        toolCalls: [
          {
            name: "list_available_appointments",
            args: {
              visitType: "medical",
            },
          },
        ],
      },
      {
        input: "I confirmed that exact slot.",
        toolCalls: [
          {
            name: "book_appointment",
            args: currentBooking(),
          },
        ],
      },
    ]);
    const session = new AgentSession<CallState>({ llm });
    sessions.push(session);
    session.userData = state;

    await session.start({
      agent: createVoiceAgent(SPRING_HILL_OFFICE_PHONE, {
        ownedMiddleware: middleware,
        suppressGreeting: true,
      }).agent,
    });
    await session.run({ userInput: "Book it now." }).wait();

    expect(middleware.operations).toEqual([]);
    expect(appointmentActions(state)).toEqual([]);
    expect(toolOutputs(session)[0]).toMatchObject({
      isError: true,
      output: expect.stringContaining("Invalid arguments for book_appointment"),
    });

    await session
      .run({ userInput: "Find the next medical appointment." })
      .wait();
    await session.run({ userInput: "I confirmed that exact slot." }).wait();

    expect(middleware.operations.map(({ name }) => name)).toEqual([
      "getAvailability",
      "bookAppointment",
    ]);
    expect(appointmentActions(state)).toMatchObject([
      { action: "booked", status: "success" },
    ]);
    expect(functionCallNames(session)).toEqual([
      "book_appointment",
      "list_available_appointments",
      "book_appointment",
    ]);
    expect(functionCallNames(session)).not.toContain("create_staff_task");
    expect(functionCallNames(session)).not.toContain("transfer_call");
    expectStableToolRequests(llm);
  });
});

function toolNamesForTrunk(trunkPhone: string): string[] {
  return buildToolsForTrunk(new InMemoryOwnedMiddleware(), trunkPhone)
    .map(({ id }) => id)
    .sort();
}

function expectStableToolRequests(llm: ToolCapturingFakeLLM): void {
  expect(llm.toolRequests.length).toBeGreaterThan(0);
  for (const tools of llm.toolRequests) {
    expect(tools).toEqual(SUPPORTED_TOOLS);
  }
}

function functionCallNames(session: AgentSession<CallState>): string[] {
  return session.history.items.flatMap((item) =>
    item.type === "function_call" ? [item.name] : [],
  );
}

function toolOutputs(session: AgentSession<CallState>) {
  return session.history.items.filter(
    (item) => item.type === "function_call_output",
  );
}

function acceptedInsurance() {
  return {
    accepted: true,
    canonicalPlan: "VSP",
    coverageType: "medical" as const,
    currentCarrier: "VSP",
    plan: "VSP",
  };
}

function completeRegistration() {
  return {
    firstName: "Jane",
    lastName: "Doe",
    dob: "01/01/1980",
    phone: null,
    inboundPhoneConfirmed: true,
    email: null,
    street: "123 Main St",
    aptSuite: null,
    city: "Spring Hill",
    state: "FL",
    zip: "34606",
    sex: "female",
    subscriberName: "Jane Doe",
    insuranceMemberId: "VSP-123",
    ssnLast4: null,
    newPatientConfirmed: true,
    readBack: true,
  };
}

function currentBooking() {
  return {
    appointmentSlotRef: "S1",
    appointmentReason: "left eye pain since yesterday",
    referringDoctor: "none",
    readBack: true,
  };
}

function createdPatient() {
  return {
    status: "created" as const,
    patientId: "patient-new",
    name: "Jane Doe",
    dob: "01/01/1980",
    phone: "+17275551212",
    insuranceCarrier: "VSP",
    insPlanId: null,
    respPartyId: null,
    routing: "all_three",
    preauthRequired: false,
  };
}

function verifiedPatient(
  overrides: Partial<ReturnType<typeof verifiedPatientBase>> = {},
) {
  return { ...verifiedPatientBase(), ...overrides };
}

function verifiedPatientBase(): PatientResolveVerified {
  return {
    status: "verified" as const,
    patientId: "patient-1",
    name: "Jane Doe",
    dob: "01/01/1980",
    phone: "+17275551212",
    insuranceCarrier: "self pay",
    insPlanId: null,
    respPartyId: null,
    routing: "all_three",
    preauthRequired: false,
    appointmentsStatus: "none" as const,
    appointmentsMessage: null,
    appointments: [],
    message: null,
  };
}

function availabilityFound() {
  return {
    status: "found" as const,
    requestedDate: "2026-09-01",
    actualDate: "2026-09-01",
    searchedFrom: "2026-09-01",
    searchedThrough: "2026-09-01",
    bookingTokenExpiresAt: "2099-09-01T16:15:00Z",
    dateShifted: false,
    shouldRetrySameSearch: false,
    slots: [
      {
        provider: "Dr. Austin Bach",
        date: "2026-09-01",
        time: "9:00 AM",
        datetime: "2026-09-01T09:00:00-04:00",
        bookingToken: "private-token",
      },
    ],
  };
}

function bookedAppointment() {
  return {
    status: "booked" as const,
    appointmentId: 456,
    providerName: "Dr. Bach",
    locationName: "Spring Hill",
    appointmentTypeName: "Medical",
    message: null,
  };
}

function storedSlot() {
  return {
    slotId: "S1",
    provider: "Dr. Bach",
    date: "2026-09-01",
    time: "9:00 AM",
    datetime: "2026-09-01T09:00:00-04:00",
    routing: "all_three",
  };
}
