import {
  AgentSession,
  ChatContext,
  ChatMessage,
  initializeLogger,
  voice,
} from "@livekit/agents";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVoiceAgent } from "../agent.js";
import type {
  PatientResolveResult,
  PatientResolveVerified,
} from "../clients/owned-middleware.js";
import { SPRING_HILL_OFFICE_PHONE } from "../customers/abita/profile.js";
import {
  confirmIdentityFromTranscript,
  resolvePatientIdentity,
  type PatientResolveLookup,
} from "../identity/promotion.js";
import { buildPreCallContextState } from "../runtime/precall-bootstrap.js";
import { appointmentRefForPatient } from "../state/appointments.js";
import type { PreCallContextState } from "../state/call-state.js";
import {
  applySchedulingLaneToState,
  storeAvailabilityBookingToken,
} from "../scheduling/state.js";
import { createTestCallState } from "./support/call-state.js";

const createAgent = (...args: Parameters<typeof createVoiceAgent>) =>
  createVoiceAgent(...args).agent;

class CapturingFakeLLM extends voice.testing.FakeLLM {
  readonly requests: ChatContext[] = [];

  override chat(options: Parameters<voice.testing.FakeLLM["chat"]>[0]) {
    this.requests.push(options.chatCtx.copy());
    const fakeContext = options.chatCtx.copy();
    const lastItem = fakeContext.items.at(-1);
    const lastUserMessage = [...fakeContext.items]
      .reverse()
      .find((item) => item.type === "message" && item.role === "user");
    if (
      lastItem?.type === "message" &&
      lastItem.role !== "user" &&
      lastUserMessage?.type === "message"
    ) {
      fakeContext.addMessage({
        role: "user",
        content: lastUserMessage.textContent ?? "",
      });
    }
    return super.chat({ ...options, chatCtx: fakeContext });
  }
}

describe("Voice Agent identity promotion", () => {
  initializeLogger({ pretty: false, level: "silent" });

  const sessions: AgentSession[] = [];

  afterEach(async () => {
    await Promise.all(sessions.splice(0).map((session) => session.close()));
  });

  it("promotes a remotely verified patient through resolve_patient", async () => {
    const appointment = {
      id: 123,
      date: "Monday, June 1, 2026",
      time: "9:00 AM",
      provider: "Dr. Bach",
      type: "Follow-up",
      facility: "Spring Hill",
      confirmed: false,
    };
    const appointmentRef = appointmentRefForPatient(
      "private-patient-id",
      appointment,
    );
    const loadedReply = `Verified existing patient Doe, Jane. Insurance on file: Aetna. Loaded 1 appointment: Monday, June 1 at 9:00 AM with Dr. Bach (appointmentRef ${appointmentRef}).`;
    const lookup: PatientResolveLookup = async (_officePhone, identity) => {
      expect(identity).toEqual({
        firstName: "Jane",
        lastName: "Doe",
        dob: "01/02/1980",
      });
      return {
        status: "verified",
        patientId: "private-patient-id",
        name: "Doe, Jane",
        dob: "01/02/1980",
        phone: "+17275551212",
        insuranceCarrier: "Aetna",
        insPlanId: "private-plan-id",
        respPartyId: "private-party-id",
        routing: "all_three",
        allowedProviders: ["Dr. Bach"],
        routingAmbiguous: false,
        preauthRequired: false,
        appointmentsStatus: "found",
        appointmentsMessage: null,
        appointments: [appointment],
        message: null,
      };
    };
    const llm = new voice.testing.FakeLLM([
      {
        input: "I need to schedule for Jane Doe, born January 2, 1980.",
        toolCalls: [
          {
            name: "resolve_patient",
            args: {
              firstName: "Jane",
              lastName: "Doe",
              dob: "01/02/1980",
            },
          },
        ],
      },
      {
        input: JSON.stringify(loadedReply),
        content: "I found Jane's record and upcoming appointment.",
      },
    ]);
    const session = new AgentSession({ llm });
    sessions.push(session);
    session.userData = createTestCallState({
      officeKey: "spring-hill",
      amdOfficePhone: SPRING_HILL_OFFICE_PHONE,
      trunkPhone: SPRING_HILL_OFFICE_PHONE,
    });

    await session.start({
      agent: createAgent("no_match", SPRING_HILL_OFFICE_PHONE, {
        identityLookup: lookup,
        suppressGreeting: true,
      }),
    });
    const run = session.run({
      userInput: "I need to schedule for Jane Doe, born January 2, 1980.",
    });
    await run.wait();

    run.expect.containsFunctionCall({
      name: "resolve_patient",
      args: {
        firstName: "Jane",
        lastName: "Doe",
        dob: "01/02/1980",
      },
    });
    run.expect.containsFunctionCallOutput({
      output: JSON.stringify(loadedReply),
      isError: false,
    });
    expect(session.userData.identity.patient).toMatchObject({
      status: "verified",
      identityConfirmed: true,
      patientId: "private-patient-id",
      name: "Doe, Jane",
      appointmentsStatus: "found",
    });
    expect(session.userData.identity.patient.appointments).toEqual([
      { ...appointment, appointmentRef },
    ]);
    expect(session.userData.identity.patientBackend).toEqual({
      insPlanId: "private-plan-id",
      respPartyId: "private-party-id",
    });
    expect(session.userData.runtime.patientIdentityTransitions).toEqual([
      { outcome: "confirmed", source: "resolve_patient" },
    ]);
  });

  it("keeps the later identity lookup active when an earlier lookup finishes last", async () => {
    const first = deferredResult<PatientResolveResult>();
    const second = deferredResult<PatientResolveResult>();
    const responses = [first.promise, second.promise];
    const state = createTestCallState();
    const lookup: PatientResolveLookup = async () => {
      const response = responses.shift();
      if (!response) throw new Error("Unexpected identity lookup.");
      return response;
    };

    const earlier = resolvePatientIdentity(
      state,
      { firstName: "Jane", lastName: "Doe", dob: "01/02/1980" },
      lookup,
    );
    const later = resolvePatientIdentity(
      state,
      { firstName: "John", lastName: "Doe", dob: "02/03/1982" },
      lookup,
    );
    second.resolve(
      verifiedPatient({
        patientId: "private-john-id",
        name: "John Doe",
        dob: "02/03/1982",
      }),
    );
    await expect(later).resolves.toContain(
      "Verified existing patient John Doe",
    );
    first.resolve(
      verifiedPatient({
        patientId: "private-jane-id",
        name: "Jane Doe",
        dob: "01/02/1980",
      }),
    );

    await expect(earlier).resolves.toContain(
      "Patient lookup was superseded by a newer identity change.",
    );
    expect(state.identity.patient).toMatchObject({
      patientId: "private-john-id",
      name: "John Doe",
    });
    expect(state.runtime.patientIdentityOutcomes).toEqual(["verified"]);
  });

  it("preserves active-patient work when the caller repeats the same identity", async () => {
    let lookupCalls = 0;
    const lookup: PatientResolveLookup = async () => {
      lookupCalls += 1;
      return verifiedPatient({
        patientId: "private-patient-id",
        name: "Jane Doe",
        dob: "01/02/1980",
      });
    };
    const initialReply =
      "Verified existing patient Jane Doe. No upcoming appointments are loaded.";
    const toolReply =
      "Jane Doe is already the active patient. Continue with loaded patient state.";
    const llm = new voice.testing.FakeLLM([
      {
        input: "This is for Jane Doe, January 2, 1980.",
        toolCalls: [
          {
            name: "resolve_patient",
            args: {
              firstName: "Jane",
              lastName: "Doe",
              dob: "01/02/1980",
            },
          },
        ],
      },
      {
        input: JSON.stringify(initialReply),
        content: "I found Jane's record.",
      },
      {
        input: "This is still for Jane Doe, January 2, 1980.",
        toolCalls: [
          {
            name: "resolve_patient",
            args: {
              firstName: "Jane",
              lastName: "Doe",
              dob: "01/02/1980",
            },
          },
        ],
      },
      {
        input: JSON.stringify(toolReply),
        content: "We'll continue where we left off.",
      },
    ]);
    const session = new AgentSession({ llm });
    sessions.push(session);
    session.userData = createTestCallState({
      officeKey: "spring-hill",
      amdOfficePhone: SPRING_HILL_OFFICE_PHONE,
      trunkPhone: SPRING_HILL_OFFICE_PHONE,
    });

    await session.start({
      agent: createAgent("no_match", SPRING_HILL_OFFICE_PHONE, {
        identityLookup: lookup,
        suppressGreeting: true,
      }),
    });
    const initialRun = session.run({
      userInput: "This is for Jane Doe, January 2, 1980.",
    });
    await initialRun.wait();
    applySchedulingLaneToState(session.userData, "medical_md");
    storeAvailabilityBookingToken(
      session.userData,
      "S1",
      "private-booking-token",
    );
    session.userData.identity.latestBookedAppointmentId = 123;

    const run = session.run({
      userInput: "This is still for Jane Doe, January 2, 1980.",
    });
    await run.wait();

    run.expect.containsFunctionCallOutput({
      output: JSON.stringify(toolReply),
      isError: false,
    });
    expect(lookupCalls).toBe(1);
    expect(session.userData.workflow.current).toEqual({
      intent: "schedule",
      appointmentLane: "medical_md",
    });
    expect(session.userData.availability.bookingTokensBySlotId).toEqual({
      S1: "private-booking-token",
    });
    expect(session.userData.identity.latestBookedAppointmentId).toBe(123);
  });

  it("retries failed appointment loading without clearing active-patient work", async () => {
    let lookupCalls = 0;
    const appointment = {
      id: 123,
      date: "Monday, June 1, 2026",
      time: "9:00 AM",
      provider: "Dr. Bach",
      type: "Follow-up",
      facility: "Spring Hill",
      confirmed: false,
    };
    const appointmentRef = appointmentRefForPatient(
      "private-patient-id",
      appointment,
    );
    const lookup: PatientResolveLookup = async () => {
      lookupCalls += 1;
      return verifiedPatient({
        patientId: "private-patient-id",
        name: "Jane Doe",
        dob: "01/02/1980",
        appointmentsStatus: "found",
        appointments: [appointment],
      });
    };
    const loadedReply = `Verified existing patient Jane Doe. Loaded 1 appointment: Monday, June 1 at 9:00 AM with Dr. Bach (appointmentRef ${appointmentRef}).`;
    const llm = new voice.testing.FakeLLM([
      resolveTurn(
        "Please retry Jane Doe, January 2, 1980.",
        "Jane",
        "Doe",
        "01/02/1980",
      ),
      {
        input: JSON.stringify(loadedReply),
        content: "Jane's appointment is loaded.",
      },
    ]);
    const session = new AgentSession({ llm });
    sessions.push(session);
    session.userData = createTestCallState({
      officeKey: "spring-hill",
      amdOfficePhone: SPRING_HILL_OFFICE_PHONE,
      trunkPhone: SPRING_HILL_OFFICE_PHONE,
      patientId: "private-patient-id",
      patientName: "Jane Doe",
      dob: "01/02/1980",
      appointmentsStatus: "error",
    });
    session.userData.identity.patient.identityConfirmed = true;

    await session.start({
      agent: createAgent("no_match", SPRING_HILL_OFFICE_PHONE, {
        identityLookup: lookup,
        suppressGreeting: true,
      }),
    });
    applySchedulingLaneToState(session.userData, "medical_md");
    storeAvailabilityBookingToken(
      session.userData,
      "S1",
      "private-booking-token",
    );

    const retry = session.run({
      userInput: "Please retry Jane Doe, January 2, 1980.",
    });
    await retry.wait();

    retry.expect.containsFunctionCallOutput({
      output: JSON.stringify(loadedReply),
      isError: false,
    });
    expect(lookupCalls).toBe(1);
    expect(session.userData.identity.patient).toMatchObject({
      patientId: "private-patient-id",
      appointmentsStatus: "found",
      appointments: [{ ...appointment, appointmentRef }],
    });
    expect(session.userData.workflow.current).toEqual({
      intent: "schedule",
      appointmentLane: "medical_md",
    });
    expect(session.userData.availability.bookingTokensBySlotId).toEqual({
      S1: "private-booking-token",
    });
  });

  it("observes a corrected lookup for the same backend patient as confirmed", async () => {
    const state = createTestCallState({
      patientId: "private-patient-id",
      patientName: "Jane Doe",
      dob: "01/02/1980",
      appointmentsStatus: "none",
    });
    state.identity.patient.identityConfirmed = true;
    applySchedulingLaneToState(state, "medical_md");
    storeAvailabilityBookingToken(state, "S1", "private-booking-token");

    const reply = await resolvePatientIdentity(
      state,
      { firstName: "John", lastName: "Doe", dob: "01/02/1980" },
      async () =>
        verifiedPatient({
          patientId: "private-patient-id",
          name: "Jane Doe",
          dob: "01/02/1980",
        }),
    );

    expect(reply).toContain("Verified existing patient Jane Doe");
    expect(state.runtime.patientIdentityTransitions).toEqual([
      { outcome: "confirmed", source: "resolve_patient" },
    ]);
    expect(state.availability.bookingTokensBySlotId).toEqual({
      S1: "private-booking-token",
    });
  });

  it("keeps the active patient intact when a different-patient lookup fails", async () => {
    const lookup: PatientResolveLookup = async (_officePhone, identity) =>
      identity.firstName === "Jane"
        ? verifiedPatient({
            patientId: "private-jane-id",
            name: "Jane Doe",
            dob: "01/02/1980",
          })
        : {
            status: "error",
            reason: "network_error",
          };
    const initialReply =
      "Verified existing patient Jane Doe. No upcoming appointments are loaded.";
    const llm = new voice.testing.FakeLLM([
      {
        input: "This is for Jane Doe, January 2, 1980.",
        toolCalls: [
          {
            name: "resolve_patient",
            args: {
              firstName: "Jane",
              lastName: "Doe",
              dob: "01/02/1980",
            },
          },
        ],
      },
      {
        input: JSON.stringify(initialReply),
        content: "I found Jane's record.",
      },
      {
        input: "Now I need to help John Doe, born February 3, 1982.",
        toolCalls: [
          {
            name: "resolve_patient",
            args: {
              firstName: "John",
              lastName: "Doe",
              dob: "02/03/1982",
            },
          },
        ],
      },
      {
        input: JSON.stringify("Patient lookup failed. Try again."),
        content: "I couldn't verify John's record yet.",
      },
    ]);
    const session = new AgentSession({ llm });
    sessions.push(session);
    session.userData = createTestCallState({
      officeKey: "spring-hill",
      amdOfficePhone: SPRING_HILL_OFFICE_PHONE,
      trunkPhone: SPRING_HILL_OFFICE_PHONE,
    });

    await session.start({
      agent: createAgent("no_match", SPRING_HILL_OFFICE_PHONE, {
        identityLookup: lookup,
        suppressGreeting: true,
      }),
    });
    const initialRun = session.run({
      userInput: "This is for Jane Doe, January 2, 1980.",
    });
    await initialRun.wait();
    applySchedulingLaneToState(session.userData, "medical_md");
    storeAvailabilityBookingToken(
      session.userData,
      "S1",
      "private-booking-token",
    );
    session.userData.identity.latestBookedAppointmentId = 123;

    const run = session.run({
      userInput: "Now I need to help John Doe, born February 3, 1982.",
    });
    await run.wait();

    run.expect.containsFunctionCallOutput({
      output: JSON.stringify("Patient lookup failed. Try again."),
      isError: false,
    });
    expect(session.userData.identity.patient).toMatchObject({
      identityConfirmed: true,
      patientId: "private-jane-id",
      name: "Jane Doe",
      dob: "01/02/1980",
    });
    expect(session.userData.workflow.current).toEqual({
      intent: "schedule",
      appointmentLane: "medical_md",
    });
    expect(session.userData.availability.bookingTokensBySlotId).toEqual({
      S1: "private-booking-token",
    });
    expect(session.userData.identity.latestBookedAppointmentId).toBe(123);
  });

  it("confirms a phone candidate from caller transcript without exposing private references", async () => {
    const session = new AgentSession();
    sessions.push(session);
    session.userData = createTestCallState({
      officeKey: "spring-hill",
      amdOfficePhone: SPRING_HILL_OFFICE_PHONE,
      trunkPhone: SPRING_HILL_OFFICE_PHONE,
      preCall: buildPreCallContextState(
        verifiedPatient({
          patientId: "private-patient-id",
          name: "Jane Doe",
          dob: "01/02/1980",
          insuranceCarrier: "Aetna",
          insPlanId: "private-plan-id",
          respPartyId: "private-party-id",
          routing: "all_three",
          allowedProviders: ["Dr. Bach"],
          appointmentsStatus: "found",
          appointments: [
            {
              id: 123,
              date: "Monday, June 1, 2026",
              time: "9:00 AM",
              provider: "Dr. Bach",
              type: "Follow-up",
              facility: "Spring Hill",
              confirmed: false,
            },
          ],
        }),
        "+17275551212",
      ),
    });

    await session.start({
      agent: createAgent("no_match", SPRING_HILL_OFFICE_PHONE, {
        suppressGreeting: true,
      }),
    });
    const chatCtx = ChatContext.empty();
    chatCtx.addMessage({
      role: "assistant",
      content: "Who is the appointment for?",
    });
    await session.currentAgent.onUserTurnCompleted(
      chatCtx,
      ChatMessage.create({
        role: "user",
        content: "Jane, and what are your office hours?",
      }),
    );

    expect(session.userData.identity.patient).toMatchObject({
      identityConfirmed: true,
      patientId: "private-patient-id",
      name: "Jane Doe",
      appointmentsStatus: "found",
    });
    const appointmentRef =
      session.userData.identity.patient.appointments[0]?.appointmentRef;
    expect(appointmentRef).toMatch(/^appointment-[a-z0-9]+$/);
    expect(session.userData.runtime.patientIdentityTransitions).toEqual([
      { outcome: "pending", source: "pre_call_phone_lookup" },
      { outcome: "confirmed", source: "caller_transcript" },
    ]);
    const turnSystemText = chatCtx.items
      .filter((item) => item.type === "message" && item.role === "system")
      .map((item) => item.textContent ?? "")
      .join(" ");
    expect(turnSystemText).toContain(
      `Upcoming appointments loaded: Monday, June 1 at 9:00 AM with Dr. Bach (appointmentRef ${appointmentRef}).`,
    );
    expect(turnSystemText).toContain("Insurance on file: Aetna.");
    expect(turnSystemText).not.toContain("private-patient-id");
    expect(turnSystemText).not.toContain("private-plan-id");
    expect(turnSystemText).not.toContain("private-party-id");
    expect(
      session.currentAgent.chatCtx.items.some(
        (item) =>
          item.type === "message" &&
          item.role === "system" &&
          item.textContent?.includes("Patient: Jane Doe."),
      ),
    ).toBe(false);
    const turnKnowledge = chatCtx.items
      .filter(
        (item) =>
          item.type === "message" &&
          item.role === "system" &&
          item.textContent?.includes("ACTIVE OFFICE KNOWLEDGE CONTEXT"),
      )
      .map((item) => (item.type === "message" ? item.textContent : null));
    expect(turnKnowledge).toHaveLength(1);
    expect(turnKnowledge[0]).toContain("## Location and Contact");
    expect(
      session.currentAgent.chatCtx.items.some(
        (item) =>
          item.type === "message" &&
          item.role === "system" &&
          item.textContent?.includes("ACTIVE OFFICE KNOWLEDGE CONTEXT"),
      ),
    ).toBe(true);
  });

  it("hydrates a lightweight transcript selection before activating it", async () => {
    const hydration = deferredResult<PatientResolveResult>();
    const lookup = vi.fn<PatientResolveLookup>(
      async (_officePhone, identity) => {
        expect(identity).toEqual({ patientId: "private-jane-id" });
        return hydration.promise;
      },
    );
    const session = new AgentSession();
    sessions.push(session);
    session.userData = createTestCallState({
      officeKey: "spring-hill",
      amdOfficePhone: SPRING_HILL_OFFICE_PHONE,
      trunkPhone: SPRING_HILL_OFFICE_PHONE,
      preCall: buildPreCallContextState(
        {
          status: "multiple_matches",
          message: "Multiple patient matches found.",
          matches: [
            {
              status: "candidate",
              patientId: "private-jane-id",
              firstName: "Jane",
              lastName: "Doe",
              dob: "01/02/1980",
            },
            {
              status: "candidate",
              patientId: "private-maria-id",
              firstName: "Maria",
              lastName: "Doe",
              dob: "02/03/1982",
            },
          ],
        },
        "+17275551212",
      ),
    });
    await session.start({
      agent: createAgent(undefined, SPRING_HILL_OFFICE_PHONE, {
        identityLookup: lookup,
        suppressGreeting: true,
      }),
    });
    const chatCtx = ChatContext.empty();
    chatCtx.addMessage({
      role: "assistant",
      content: "Who is the appointment for?",
    });

    const completingTurn = session.currentAgent.onUserTurnCompleted(
      chatCtx,
      ChatMessage.create({ role: "user", content: "Jane" }),
    );
    await Promise.resolve();

    expect(lookup).toHaveBeenCalledTimes(1);
    expect(session.userData.identity.patient).toMatchObject({
      identityConfirmed: false,
      patientId: null,
    });

    hydration.resolve(
      verifiedPatient({
        patientId: "private-jane-id",
        name: "Jane Doe",
        dob: "01/02/1980",
      }),
    );
    await completingTurn;

    expect(session.userData.identity.patient).toMatchObject({
      status: "verified",
      identityConfirmed: true,
      patientId: "private-jane-id",
      name: "Jane Doe",
    });
    const turnSystemText = chatCtx.items
      .filter((item) => item.type === "message" && item.role === "system")
      .map((item) => item.textContent ?? "")
      .join(" ");
    expect(turnSystemText).toContain("Patient: Jane Doe.");
    expect(turnSystemText).not.toContain("private-jane-id");
    expect(turnSystemText).not.toContain("01/02/1980");
    expect(
      session.currentAgent.chatCtx.items.some(
        (item) =>
          item.type === "message" &&
          item.role === "system" &&
          item.textContent?.includes("Patient: Jane Doe."),
      ),
    ).toBe(false);
  });

  it("hydrates exactly the transcript-selected lightweight candidate before activation", async () => {
    const hydration = deferredResult<PatientResolveResult>();
    const lookup = vi.fn<PatientResolveLookup>(
      async (_officePhone, identity) => {
        expect(identity).toEqual({ patientId: "private-maria-id" });
        return hydration.promise;
      },
    );
    const state = createTestCallState({
      officeKey: "spring-hill",
      amdOfficePhone: SPRING_HILL_OFFICE_PHONE,
      trunkPhone: SPRING_HILL_OFFICE_PHONE,
      preCall: buildPreCallContextState(
        {
          status: "multiple_matches",
          message: "Multiple patient matches found.",
          matches: [
            {
              status: "candidate",
              patientId: "private-jane-id",
              firstName: "Jane",
              lastName: "Doe",
              dob: "01/02/1980",
            },
            {
              status: "candidate",
              patientId: "private-maria-id",
              firstName: "Maria",
              lastName: "Doe",
              dob: "02/03/1982",
            },
          ],
        },
        "+17275551212",
      ),
    });

    const resolving = confirmIdentityFromTranscript(
      {
        state,
        transcript: "Maria",
      },
      lookup,
    );

    expect(lookup).toHaveBeenCalledTimes(1);
    expect(state.identity.preCall).toMatchObject({
      status: "multiple_matches_pending_selection",
      selectedCandidateRef: "precall:2",
    });
    expect(state.identity.patient).toMatchObject({
      status: "unknown",
      identityConfirmed: false,
      patientId: null,
      appointments: [],
    });

    hydration.resolve(
      verifiedPatient({
        patientId: "private-maria-id",
        name: "Maria Doe",
        dob: "02/03/1982",
        appointmentsStatus: "found",
        appointments: [
          {
            id: 12345,
            cancellationToken: "private-cancellation-token",
            date: "Monday, August 3, 2026",
            time: "9:00 AM",
            provider: "Dr. Bach",
            type: "Follow-up",
            facility: "Spring Hill",
            confirmed: true,
          },
        ],
      }),
    );

    await expect(resolving).resolves.toMatchObject({
      candidateRef: "precall:2",
      systemMessage: expect.stringContaining("Patient: Maria Doe."),
    });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(state.identity.patient).toMatchObject({
      status: "verified",
      identityConfirmed: true,
      patientId: "private-maria-id",
      name: "Maria Doe",
      appointmentsStatus: "found",
      appointments: [
        expect.objectContaining({
          cancellationToken: "private-cancellation-token",
        }),
      ],
    });
    expect(state.identity.preCall).toMatchObject({
      status: "multiple_match_confirmed",
      selectedCandidateRef: "precall:2",
      identityPromotion: "confirmed_by_transcript",
    });

    await expect(
      resolvePatientIdentity(state, { firstName: "Maria" }, lookup),
    ).resolves.toBe(
      "Maria Doe is already the active patient. Continue with loaded patient state.",
    );
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("joins overlapping transcript hydration attempts for the same candidate", async () => {
    const hydration = deferredResult<PatientResolveResult>();
    const lookup = vi.fn<PatientResolveLookup>(async () => hydration.promise);
    const state = createTestCallState({
      officeKey: "spring-hill",
      amdOfficePhone: SPRING_HILL_OFFICE_PHONE,
      trunkPhone: SPRING_HILL_OFFICE_PHONE,
      preCall: buildPreCallContextState(
        {
          status: "multiple_matches",
          message: "Multiple patient matches found.",
          matches: [
            {
              status: "candidate",
              patientId: "private-maria-id",
              firstName: "Maria",
              lastName: "Doe",
              dob: "02/03/1982",
            },
          ],
        },
        "+17275551212",
      ),
    });

    const confirmation = {
      state,
      transcript: "Maria",
    };
    const first = confirmIdentityFromTranscript(confirmation, lookup);
    const second = confirmIdentityFromTranscript(confirmation, lookup);

    expect(lookup).toHaveBeenCalledTimes(1);
    expect(state.identity.patient.identityConfirmed).toBe(false);

    hydration.resolve(
      verifiedPatient({
        patientId: "private-maria-id",
        name: "Maria Doe",
        dob: "02/03/1982",
      }),
    );

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({
        systemMessage: expect.stringContaining("Patient: Maria Doe."),
      }),
      expect.objectContaining({
        systemMessage: expect.stringContaining("Patient: Maria Doe."),
      }),
    ]);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(state.identity.patient).toMatchObject({
      identityConfirmed: true,
      patientId: "private-maria-id",
    });
  });

  it("does not activate an incomplete transcript-selected candidate", async () => {
    const state = createTestCallState({
      officeKey: "spring-hill",
      amdOfficePhone: SPRING_HILL_OFFICE_PHONE,
      trunkPhone: SPRING_HILL_OFFICE_PHONE,
      preCall: buildPreCallContextState(
        {
          status: "multiple_matches",
          message: "Multiple patient matches found.",
          matches: [
            {
              status: "candidate",
              patientId: "private-maria-id",
              firstName: "Maria",
              lastName: "Doe",
              dob: "02/03/1982",
            },
          ],
        },
        "+17275551212",
      ),
    });

    await expect(
      confirmIdentityFromTranscript(
        {
          state,
          transcript: "Maria",
        },
        async () =>
          verifiedPatient({
            patientId: "private-maria-id",
            name: null,
            dob: "02/03/1982",
          }),
      ),
    ).resolves.toMatchObject({
      candidateRef: "precall:1",
      systemMessage: expect.stringContaining(
        "Patient lookup returned an incomplete identity. Try again.",
      ),
    });
    expect(state.identity.patient).toMatchObject({
      status: "unknown",
      identityConfirmed: false,
      patientId: null,
    });
    expect(state.runtime.preCallLookup.hydrationOutcome).toBe("incomplete");
  });

  it("keeps the active patient intact when selected-candidate hydration fails", async () => {
    const state = createTestCallState({
      officeKey: "spring-hill",
      amdOfficePhone: SPRING_HILL_OFFICE_PHONE,
      trunkPhone: SPRING_HILL_OFFICE_PHONE,
      preCall: buildPreCallContextState(
        {
          status: "multiple_matches",
          message: "Multiple patient matches found.",
          matches: [
            {
              status: "candidate",
              patientId: "private-maria-id",
              firstName: "Maria",
              lastName: "Doe",
              dob: "02/03/1982",
            },
          ],
        },
        "+17275551212",
      ),
    });
    await resolvePatientIdentity(
      state,
      { firstName: "Jane", lastName: "Doe", dob: "01/02/1980" },
      async () =>
        verifiedPatient({
          patientId: "private-jane-id",
          name: "Jane Doe",
          dob: "01/02/1980",
        }),
    );
    applySchedulingLaneToState(state, "medical_md");
    storeAvailabilityBookingToken(state, "S1", "private-booking-token");

    const reply = await resolvePatientIdentity(
      state,
      { firstName: "Maria" },
      async () => ({ status: "error", reason: "network_error" }),
    );

    expect(reply).toBe("Patient lookup failed. Try again.");
    expect(state.identity.patient).toMatchObject({
      identityConfirmed: true,
      patientId: "private-jane-id",
      name: "Jane Doe",
    });
    expect(state.workflow.current).toEqual({
      intent: "schedule",
      appointmentLane: "medical_md",
    });
    expect(state.availability.bookingTokensBySlotId).toEqual({
      S1: "private-booking-token",
    });
    expect(state.identity.preCall).toMatchObject({
      status: "multiple_matches_pending_selection",
      selectedCandidateRef: "precall:1",
      identityPromotion: "none",
    });
    expect(state.runtime.preCallLookup.hydrationOutcome).toBe("lookup_failed");
  });

  it("leaves ambiguous transcript names for a full existing-patient lookup", async () => {
    const state = createTestCallState({
      officeKey: "spring-hill",
      amdOfficePhone: SPRING_HILL_OFFICE_PHONE,
      trunkPhone: SPRING_HILL_OFFICE_PHONE,
      preCall: buildPreCallContextState(
        {
          status: "multiple_matches",
          message: "Multiple patient matches found.",
          matches: [
            {
              status: "candidate",
              patientId: "private-jane-doe-id",
              firstName: "Jane",
              lastName: "Doe",
              dob: "01/02/1980",
            },
            {
              status: "candidate",
              patientId: "private-jane-smith-id",
              firstName: "Jane",
              lastName: "Smith",
              dob: "02/03/1982",
            },
          ],
        },
        "+17275551212",
      ),
    });
    const lookup = vi.fn<PatientResolveLookup>(
      async (_officePhone, identity) => {
        expect(identity).toEqual({
          firstName: "Jane",
          lastName: "Smith",
          dob: "02/03/1982",
        });
        return verifiedPatient({
          patientId: "private-jane-smith-id",
          name: "Jane Smith",
          dob: "02/03/1982",
        });
      },
    );

    await expect(
      confirmIdentityFromTranscript(
        {
          state,
          transcript: "Jane",
        },
        lookup,
      ),
    ).resolves.toBeNull();
    expect(lookup).not.toHaveBeenCalled();
    expect(state.identity.patient.identityConfirmed).toBe(false);

    await expect(
      resolvePatientIdentity(
        state,
        { firstName: "Jane", lastName: "Smith", dob: "02/03/1982" },
        lookup,
      ),
    ).resolves.toContain("Verified existing patient Jane Smith.");
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(state.identity.patient).toMatchObject({
      identityConfirmed: true,
      patientId: "private-jane-smith-id",
      name: "Jane Smith",
    });
  });

  it("does not let superseded transcript hydration replace the newer patient", async () => {
    const janeHydration = deferredResult<PatientResolveResult>();
    const mariaHydration = deferredResult<PatientResolveResult>();
    const lookup = vi.fn<PatientResolveLookup>(
      async (_officePhone, identity) => {
        if (!("patientId" in identity)) {
          throw new Error("Expected private candidate hydration");
        }
        return identity.patientId === "private-jane-id"
          ? janeHydration.promise
          : mariaHydration.promise;
      },
    );
    const state = createTestCallState({
      officeKey: "spring-hill",
      amdOfficePhone: SPRING_HILL_OFFICE_PHONE,
      trunkPhone: SPRING_HILL_OFFICE_PHONE,
      preCall: buildPreCallContextState(
        {
          status: "multiple_matches",
          message: "Multiple patient matches found.",
          matches: [
            {
              status: "candidate",
              patientId: "private-jane-id",
              firstName: "Jane",
              lastName: "Doe",
              dob: "01/02/1980",
            },
            {
              status: "candidate",
              patientId: "private-maria-id",
              firstName: "Maria",
              lastName: "Doe",
              dob: "02/03/1982",
            },
          ],
        },
        "+17275551212",
      ),
    });

    const resolvingJane = confirmIdentityFromTranscript(
      {
        state,
        transcript: "Jane",
      },
      lookup,
    );
    const resolvingMaria = confirmIdentityFromTranscript(
      {
        state,
        transcript: "Maria",
      },
      lookup,
    );
    expect(lookup).toHaveBeenCalledTimes(2);

    mariaHydration.resolve(
      verifiedPatient({
        patientId: "private-maria-id",
        name: "Maria Doe",
        dob: "02/03/1982",
      }),
    );
    await expect(resolvingMaria).resolves.toMatchObject({
      candidateRef: "precall:2",
      systemMessage: expect.stringContaining("Patient: Maria Doe."),
    });

    janeHydration.resolve(
      verifiedPatient({
        patientId: "private-jane-id",
        name: "Jane Doe",
        dob: "01/02/1980",
      }),
    );
    await expect(resolvingJane).resolves.toMatchObject({
      candidateRef: "precall:1",
      systemMessage: expect.stringContaining("Patient: Maria Doe."),
    });
    expect(state.identity.patient).toMatchObject({
      identityConfirmed: true,
      patientId: "private-maria-id",
      name: "Maria Doe",
    });
    expect(state.identity.preCall?.selectedCandidateRef).toBe("precall:2");
    expect(state.runtime.preCallLookup.hydrationOutcome).toBe("verified");
  });

  it("switches through candidate hydration and clears prior patient work", async () => {
    const state = createTestCallState({
      officeKey: "spring-hill",
      amdOfficePhone: SPRING_HILL_OFFICE_PHONE,
      trunkPhone: SPRING_HILL_OFFICE_PHONE,
      preCall: buildPreCallContextState(
        {
          status: "multiple_matches",
          message: "Multiple patient matches found.",
          matches: [
            {
              status: "candidate",
              patientId: "private-maria-id",
              firstName: "Maria",
              lastName: "Doe",
              dob: "02/03/1982",
            },
          ],
        },
        "+17275551212",
      ),
    });
    await resolvePatientIdentity(
      state,
      { firstName: "Jane", lastName: "Doe", dob: "01/02/1980" },
      async () =>
        verifiedPatient({
          patientId: "private-jane-id",
          name: "Jane Doe",
          dob: "01/02/1980",
        }),
    );
    applySchedulingLaneToState(state, "medical_md");
    storeAvailabilityBookingToken(state, "S1", "private-booking-token");
    state.identity.latestBookedAppointmentId = 12345;

    await expect(
      resolvePatientIdentity(state, { firstName: "Maria" }, async () =>
        verifiedPatient({
          patientId: "private-maria-id",
          name: "Maria Doe",
          dob: "02/03/1982",
          insuranceCarrier: "Humana",
        }),
      ),
    ).resolves.toBe(
      "Switched active patient to Maria Doe. Insurance on file: Humana. No upcoming appointments are loaded. Check availability again before booking.",
    );
    expect(state.identity.patient).toMatchObject({
      identityConfirmed: true,
      patientId: "private-maria-id",
      name: "Maria Doe",
    });
    expect(state.workflow.current).toBeUndefined();
    expect(state.availability.bookingTokensBySlotId).toEqual({});
    expect(state.identity.latestBookedAppointmentId).toBeUndefined();
    expect(state.identity.preCall).toMatchObject({
      status: "multiple_match_confirmed",
      identityPromotion: "switched_by_identity_tool",
    });
  });

  it("selects a unique comma-name candidate from a spelled transcript", async () => {
    const preCall = buildPreCallContextState(
      {
        status: "multiple_matches",
        message: "Multiple patient matches found.",
        matches: [
          verifiedPatient({
            patientId: "private-chase-id",
            name: "TEST, CHASE",
            dob: "04/07/2000",
          }),
          verifiedPatient({
            patientId: "private-larry-id",
            name: "TEST, LARRY",
            dob: "08/18/2020",
          }),
        ],
      },
      "+17275551212",
    );
    const session = await startPreCallSession(sessions, preCall);

    await submitIdentityTranscript(
      session,
      "Could you spell the first name?",
      "L-A-R-R-Y.",
    );

    expect(session.userData.identity.patient).toMatchObject({
      identityConfirmed: true,
      patientId: "private-larry-id",
      name: "LARRY TEST",
    });
    expect(session.userData.identity.preCall).toMatchObject({
      status: "multiple_match_confirmed",
      selectedCandidateRef: "precall:2",
    });
  });

  it("keeps ambiguous and absent first-name transcript signals gated", async () => {
    const preCall = buildPreCallContextState(
      {
        status: "multiple_matches",
        message: "Multiple patient matches found.",
        matches: [
          verifiedPatient({
            patientId: "private-kyle-id",
            name: "Kyle Test",
            dob: "01/01/2010",
          }),
          verifiedPatient({
            patientId: "private-kylee-id",
            name: "Kylee Test",
            dob: "02/02/2011",
          }),
        ],
      },
      "+17275551212",
    );
    const session = await startPreCallSession(sessions, preCall);

    await submitIdentityTranscript(
      session,
      "Who is the appointment for?",
      "Kyle",
    );
    expect(session.userData.identity.patient.identityConfirmed).toBe(false);

    await submitIdentityTranscript(
      session,
      "Who is the appointment for?",
      "Morgan",
    );
    expect(session.userData.identity.patient).toMatchObject({
      status: "unknown",
      identityConfirmed: false,
      patientId: null,
    });
    expect(session.userData.identity.preCall?.status).toBe(
      "multiple_matches_pending_selection",
    );
  });

  it("accepts a near-name transcript but not a short substring", async () => {
    const nearNameSession = await startPreCallSession(
      sessions,
      buildPreCallContextState(
        verifiedPatient({
          patientId: "private-branden-id",
          name: "Branden Anderson",
          dob: "04/05/2012",
        }),
        "+17275551212",
      ),
    );
    await submitIdentityTranscript(
      nearNameSession,
      "Who is the appointment for?",
      "Brandon",
    );
    expect(nearNameSession.userData.identity.patient).toMatchObject({
      identityConfirmed: true,
      patientId: "private-branden-id",
    });

    const shortNameSession = await startPreCallSession(
      sessions,
      buildPreCallContextState(
        verifiedPatient({
          patientId: "private-al-id",
          name: "Al Doe",
          dob: "03/03/2012",
        }),
        "+17275551212",
      ),
    );
    await submitIdentityTranscript(
      shortNameSession,
      "Who is the appointment for?",
      "Sally",
    );
    expect(shortNameSession.userData.identity.patient).toMatchObject({
      identityConfirmed: false,
      patientId: null,
    });
  });

  it("asks for spelling after a preloaded last-name and DOB match", async () => {
    const reply =
      "I found a record with that last name and date of birth, but the first name does not match what I heard. Could you spell the patient's first name?";
    const llm = new voice.testing.FakeLLM([
      resolveTurn(
        "This is Lisa Arshed, October 3, 2020.",
        "Lisa",
        "Arshed",
        "10/03/2020",
      ),
      {
        input: JSON.stringify(reply),
        content: "Could you spell the first name?",
      },
    ]);
    const session = new AgentSession({ llm });
    sessions.push(session);
    session.userData = createTestCallState({
      officeKey: "spring-hill",
      amdOfficePhone: SPRING_HILL_OFFICE_PHONE,
      trunkPhone: SPRING_HILL_OFFICE_PHONE,
      preCall: buildPreCallContextState(
        verifiedPatient({
          patientId: "private-ella-id",
          name: "ELLA ARSHED",
          dob: "10/03/2020",
        }),
        "+17275551212",
      ),
    });

    await session.start({
      agent: createAgent("no_match", SPRING_HILL_OFFICE_PHONE, {
        identityLookup: async () => ({
          status: "not_found",
          message: "No patient match found.",
        }),
        suppressGreeting: true,
      }),
    });
    const run = session.run({
      userInput: "This is Lisa Arshed, October 3, 2020.",
    });
    await run.wait();

    run.expect.containsFunctionCallOutput({
      output: JSON.stringify(reply),
      isError: false,
    });
    expect(session.userData.identity.patient.identityConfirmed).toBe(false);
    expect(session.userData.identity.preCall?.status).toBe(
      "single_match_pending_confirmation",
    );
  });

  it("keeps patient actions gated when a verified lookup has incomplete identity", async () => {
    const lookup: PatientResolveLookup = async () => ({
      status: "verified",
      patientId: "private-patient-id",
      name: null,
      dob: null,
      phone: null,
      insuranceCarrier: null,
      insPlanId: null,
      respPartyId: null,
      routing: null,
      allowedProviders: [],
      routingAmbiguous: false,
      preauthRequired: false,
      appointmentsStatus: "none",
      appointmentsMessage: null,
      appointments: [],
      message: null,
    });
    const toolReply =
      "Patient lookup returned an incomplete identity. Try again.";
    const llm = new voice.testing.FakeLLM([
      {
        input: "The patient is Jane Doe, born January 2, 1980.",
        toolCalls: [
          {
            name: "resolve_patient",
            args: {
              firstName: "Jane",
              lastName: "Doe",
              dob: "01/02/1980",
            },
          },
        ],
      },
      {
        input: JSON.stringify(toolReply),
        content: "I couldn't verify that record yet.",
      },
    ]);
    const session = new AgentSession({ llm });
    sessions.push(session);
    session.userData = createTestCallState({
      officeKey: "spring-hill",
      amdOfficePhone: SPRING_HILL_OFFICE_PHONE,
      trunkPhone: SPRING_HILL_OFFICE_PHONE,
    });

    await session.start({
      agent: createAgent("no_match", SPRING_HILL_OFFICE_PHONE, {
        identityLookup: lookup,
        suppressGreeting: true,
      }),
    });
    const run = session.run({
      userInput: "The patient is Jane Doe, born January 2, 1980.",
    });
    await run.wait();

    run.expect.containsFunctionCallOutput({
      output: JSON.stringify(toolReply),
      isError: false,
    });
    expect(session.userData.identity.patient).toMatchObject({
      status: "unknown",
      identityConfirmed: false,
      patientId: null,
    });
  });

  it("switches verified patients and promotes routing while resetting patient work", async () => {
    const lookup: PatientResolveLookup = async (_officePhone, identity) =>
      identity.firstName === "Jane"
        ? verifiedPatient({
            patientId: "private-jane-id",
            name: "Jane Doe",
            dob: "01/02/1980",
            routing: "all_three",
            allowedProviders: ["Dr. Bach"],
          })
        : verifiedPatient({
            patientId: "private-john-id",
            name: "John Doe",
            dob: "02/03/1982",
            routing: "bach_only",
            allowedProviders: ["Dr. Bach"],
            appointmentsStatus: "error",
          });
    const janeReply =
      "Verified existing patient Jane Doe. No upcoming appointments are loaded.";
    const johnReply =
      "Verified existing patient John Doe. Appointments could not be loaded. Try confirming identity again before confirming or cancelling.";
    const llm = new voice.testing.FakeLLM([
      resolveTurn(
        "This is for Jane Doe, January 2, 1980.",
        "Jane",
        "Doe",
        "01/02/1980",
      ),
      { input: JSON.stringify(janeReply), content: "Jane is loaded." },
      resolveTurn(
        "Now help John Doe, February 3, 1982.",
        "John",
        "Doe",
        "02/03/1982",
      ),
      { input: JSON.stringify(johnReply), content: "John is loaded." },
    ]);
    const session = new AgentSession({ llm });
    sessions.push(session);
    session.userData = createTestCallState({
      officeKey: "spring-hill",
      amdOfficePhone: SPRING_HILL_OFFICE_PHONE,
      trunkPhone: SPRING_HILL_OFFICE_PHONE,
    });

    await session.start({
      agent: createAgent("no_match", SPRING_HILL_OFFICE_PHONE, {
        identityLookup: lookup,
        suppressGreeting: true,
      }),
    });
    await session
      .run({ userInput: "This is for Jane Doe, January 2, 1980." })
      .wait();
    applySchedulingLaneToState(session.userData, "medical_md");
    storeAvailabilityBookingToken(session.userData, "S1", "private-token");
    session.userData.identity.latestBookedAppointmentId = 123;

    const switchRun = session.run({
      userInput: "Now help John Doe, February 3, 1982.",
    });
    await switchRun.wait();

    switchRun.expect.containsFunctionCallOutput({
      output: JSON.stringify(johnReply),
      isError: false,
    });
    expect(session.userData.identity.patient).toMatchObject({
      status: "verified",
      identityConfirmed: true,
      patientId: "private-john-id",
      name: "John Doe",
      appointmentsStatus: "error",
    });
    expect(session.userData.workflow.routing).toMatchObject({
      routing: "bach_only",
      allowedProviders: ["Dr. Bach"],
    });
    expect(session.userData.workflow.current).toBeUndefined();
    expect(session.userData.availability.bookingTokensBySlotId).toEqual({});
    expect(session.userData.identity.latestBookedAppointmentId).toBeUndefined();
    expect(session.userData.runtime.patientIdentityOutcomes).toEqual([
      "verified",
      "switched",
    ]);
  });

  it("replaces patient context before replying to a same-turn identity switch", async () => {
    const toolReply =
      "Verified existing patient John Doe. Insurance on file: Humana. No upcoming appointments are loaded.";
    const llm = new CapturingFakeLLM([
      resolveTurn(
        "Now help John Doe, February 3, 1982.",
        "John",
        "Doe",
        "02/03/1982",
      ),
      {
        input: JSON.stringify(toolReply),
        content: "John is loaded.",
      },
    ]);
    const session = new AgentSession({ llm });
    sessions.push(session);
    session.userData = createTestCallState({
      officeKey: "spring-hill",
      amdOfficePhone: SPRING_HILL_OFFICE_PHONE,
      trunkPhone: SPRING_HILL_OFFICE_PHONE,
      patientId: "private-jane-id",
      patientName: "Jane Doe",
      insuranceCarrier: "Aetna",
      appointmentsStatus: "none",
    });
    session.userData.identity.patient.identityConfirmed = true;

    await session.start({
      agent: createAgent("no_match", SPRING_HILL_OFFICE_PHONE, {
        identityLookup: async () =>
          verifiedPatient({
            patientId: "private-john-id",
            name: "John Doe",
            dob: "02/03/1982",
            insuranceCarrier: "Humana",
          }),
        suppressGreeting: true,
      }),
    });

    await completeUserTurn(session, "Now help John Doe, February 3, 1982.");
    await vi.waitFor(() => expect(llm.requests).toHaveLength(2));
    await session.waitForIdle();

    expect(llm.requests).toHaveLength(2);
    expect(llm.requests[1]!.items.at(-1)?.type).toBe("function_call_output");
    expect(systemText(llm.requests[0]!)).toContain("Patient: Jane Doe.");
    expect(systemText(llm.requests[0]!)).toContain("Insurance on file: Aetna.");
    expect(systemText(llm.requests[1]!)).toContain("Patient: John Doe.");
    expect(systemText(llm.requests[1]!)).toContain(
      "Insurance on file: Humana.",
    );
    expect(systemText(llm.requests[1]!)).not.toContain("Jane Doe");
    expect(systemText(llm.requests[1]!)).not.toContain("Aetna");
  });

  it.each([
    {
      label: "not found",
      result: {
        status: "not_found",
      } satisfies PatientResolveResult,
      reply:
        "No matching patient was found. Confirm the spelling and date of birth, or ask whether the patient is already registered with us.",
      outcome: "not_found",
    },
    {
      label: "multiple matches",
      result: {
        status: "multiple_matches",
        matches: [],
      } satisfies PatientResolveResult,
      reply:
        "Multiple matching patients were found. Confirm the spelling and date of birth, then try again.",
      outcome: "multiple_matches",
    },
    {
      label: "invalid response",
      result: {
        status: "error",
        reason: "invalid_response",
      } satisfies PatientResolveResult,
      reply: "Patient lookup failed. Try again.",
      outcome: "lookup_failed",
    },
    {
      label: "unsupported office",
      result: {
        status: "error",
        reason: "unsupported_office",
      } satisfies PatientResolveResult,
      reply: "Patient lookup failed. Try again.",
      outcome: "lookup_failed",
    },
  ])(
    "preserves identity gates for normalized $label lookup outcomes",
    async ({ result, reply, outcome }) => {
      const llm = new voice.testing.FakeLLM([
        resolveTurn(
          "Find Jane Doe, January 2, 1980.",
          "Jane",
          "Doe",
          "01/02/1980",
        ),
        { input: JSON.stringify(reply), content: "I could not verify Jane." },
      ]);
      const session = new AgentSession({ llm });
      sessions.push(session);
      session.userData = createTestCallState({
        officeKey: "spring-hill",
        amdOfficePhone: SPRING_HILL_OFFICE_PHONE,
        trunkPhone: SPRING_HILL_OFFICE_PHONE,
      });

      await session.start({
        agent: createAgent("no_match", SPRING_HILL_OFFICE_PHONE, {
          identityLookup: async () => result,
          suppressGreeting: true,
        }),
      });
      const run = session.run({
        userInput: "Find Jane Doe, January 2, 1980.",
      });
      await run.wait();

      run.expect.containsFunctionCallOutput({
        output: JSON.stringify(reply),
        isError: false,
      });
      expect(session.userData.identity.patient).toMatchObject({
        status: "unknown",
        identityConfirmed: false,
        patientId: null,
      });
      expect(session.userData.runtime.patientIdentityOutcomes).toEqual([
        outcome,
      ]);
    },
  );

  it("keeps an active existing patient out of the new-chart path", async () => {
    let lookupCalls = 0;
    const existingReply =
      "Verified existing patient Jane Doe. No upcoming appointments are loaded.";
    const duplicateReply =
      "The active patient already matches that identity. Continue with the loaded patient instead of creating a new chart.";
    const llm = new voice.testing.FakeLLM([
      resolveTurn(
        "Find Jane Doe, January 2, 1980.",
        "Jane",
        "Doe",
        "01/02/1980",
      ),
      { input: JSON.stringify(existingReply), content: "Jane is loaded." },
      {
        input: "Jane says she has never registered.",
        toolCalls: [
          {
            name: "add_patient",
            args: {
              firstName: "Jane",
              lastName: "Doe",
              dob: "01/02/1980",
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
          },
        ],
      },
      {
        input: JSON.stringify(duplicateReply),
        content: "I will use Jane's existing chart.",
      },
    ]);
    const session = new AgentSession({ llm });
    sessions.push(session);
    session.userData = createTestCallState({
      officeKey: "spring-hill",
      amdOfficePhone: SPRING_HILL_OFFICE_PHONE,
      trunkPhone: SPRING_HILL_OFFICE_PHONE,
    });

    await session.start({
      agent: createAgent("no_match", SPRING_HILL_OFFICE_PHONE, {
        identityLookup: async () => {
          lookupCalls += 1;
          return verifiedPatient({
            patientId: "private-jane-id",
            name: "Jane Doe",
            dob: "01/02/1980",
          });
        },
        suppressGreeting: true,
      }),
    });
    await session.run({ userInput: "Find Jane Doe, January 2, 1980." }).wait();
    const duplicateRun = session.run({
      userInput: "Jane says she has never registered.",
    });
    await duplicateRun.wait();

    duplicateRun.expect.containsFunctionCallOutput({
      output: JSON.stringify(duplicateReply),
      isError: false,
    });
    expect(lookupCalls).toBe(1);
    expect(session.userData.identity.patient).toMatchObject({
      status: "verified",
      identityConfirmed: true,
      patientId: "private-jane-id",
    });
  });
});

function resolveTurn(
  input: string,
  firstName: string,
  lastName: string,
  dob: string,
) {
  return {
    input,
    toolCalls: [
      {
        name: "resolve_patient",
        args: { firstName, lastName, dob },
      },
    ],
  };
}

function systemText(chatCtx: ChatContext): string {
  return chatCtx.items
    .filter((item) => item.type === "message" && item.role === "system")
    .map((item) => item.textContent ?? "")
    .join(" ");
}

async function completeUserTurn(
  session: AgentSession,
  transcript: string,
): Promise<void> {
  const activity = await session.waitForIdle();
  await activity.onEndOfTurn({
    endOfUtteranceDelay: 0,
    newTranscript: transcript,
    startedSpeakingAt: undefined,
    stoppedSpeakingAt: undefined,
    transcriptionDelay: 0,
    transcriptConfidence: 0.99,
  });
}

async function startPreCallSession(
  sessions: AgentSession[],
  preCall: PreCallContextState,
): Promise<AgentSession> {
  const session = new AgentSession();
  sessions.push(session);
  session.userData = createTestCallState({
    officeKey: "spring-hill",
    amdOfficePhone: SPRING_HILL_OFFICE_PHONE,
    trunkPhone: SPRING_HILL_OFFICE_PHONE,
    preCall,
  });
  await session.start({
    agent: createAgent("no_match", SPRING_HILL_OFFICE_PHONE, {
      suppressGreeting: true,
    }),
  });
  return session;
}

async function submitIdentityTranscript(
  session: AgentSession,
  assistantText: string,
  userText: string,
): Promise<void> {
  const chatCtx = ChatContext.empty();
  chatCtx.addMessage({ role: "assistant", content: assistantText });
  await session.currentAgent.onUserTurnCompleted(
    chatCtx,
    ChatMessage.create({ role: "user", content: userText }),
  );
}

function verifiedPatient(
  overrides: Partial<PatientResolveVerified> & {
    patientId: string;
    name: string;
    dob: string;
  },
): PatientResolveVerified {
  return {
    status: "verified",
    patientId: overrides.patientId,
    name: overrides.name,
    dob: overrides.dob,
    phone: "+17275551212",
    insuranceCarrier: null,
    insPlanId: null,
    respPartyId: null,
    routing: null,
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

function deferredResult<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((value) => {
    resolve = value;
  });
  return { promise, resolve };
}
