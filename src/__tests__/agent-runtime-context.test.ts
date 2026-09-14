import type { CallState } from "../state/call-state.js";
import {
  AgentSession,
  initializeLogger,
  llm,
  type ChatContext,
  voice,
} from "@livekit/agents";
import { afterEach, describe, expect, it } from "vitest";
import { createVoiceAgent } from "../agent.js";
import { InMemoryOwnedMiddleware } from "./support/owned-middleware.js";
import { SPRING_HILL_OFFICE_PHONE } from "../customers/abita/profile.js";
import { clinicTimestampMessage } from "../scheduling/clock.js";
import { clearAvailabilitySelection } from "../scheduling/availability.js";
import {
  createConfirmedPatientState,
  createTestCallState,
} from "./support/call-state.js";

const testInstant = new Date("2026-07-25T03:58:00.000Z");
const ownedMiddleware = new InMemoryOwnedMiddleware();

describe("agent runtime context", () => {
  initializeLogger({ pretty: false, level: "silent" });
  const sessions: AgentSession<CallState>[] = [];

  afterEach(async () => {
    await Promise.all(sessions.splice(0).map((session) => session.close()));
  });

  it.each([1, 2])(
    "adds a private first-name hint for %i phone candidates",
    async (candidateCount) => {
      const model = new ContextCapturingFakeLLM([
        { input: "I need an appointment.", content: "Who is it for?" },
      ]);
      const session = new AgentSession<CallState>({ llm: model });
      sessions.push(session);
      session.userData = createTestCallState({
        preCallCandidates: [
          {
            status: "verified",
            ref: "private-candidate-reference",
            firstName: "Private",
            lastName: "Patient",
            dob: "01/02/1980",
            patientId: "private-patient-id",
            appointments: [],
          },
        ],
        preCallLookup: { status: "verified" },
      });
      if (candidateCount === 2) {
        session.userData.identity.privateCandidates.push({
          ...session.userData.identity.privateCandidates[0]!,
          patientId: "private-second-patient",
        });
        session.userData.runtime.preCallLookup.status = "multiple_matches";
      }
      await session.start({
        agent: createVoiceAgent(SPRING_HILL_OFFICE_PHONE, {
          ownedMiddleware,
          suppressGreeting: true,
          turnClock: { now: () => testInstant },
        }).agent,
      });

      await session.run({ userInput: "I need an appointment." }).wait();

      expect(runtimeMessages(model.requests[0]!)).toEqual([
        clinicTimestampMessage(testInstant),
      ]);
      expect(runtimeMessages(session.currentAgent.chatCtx)).toEqual([]);
      expect(phoneLookupHints(model.requests[0]!)).toEqual([
        "Phone lookup found a possible patient. Ask for the patient's first name if needed, then call resolve_patient with firstName and dob:null.",
      ]);
      expect(phoneLookupHints(session.currentAgent.chatCtx)).toEqual([]);
      const modelRequest = JSON.stringify(model.requests[0]);
      for (const privateValue of [
        "private-candidate-reference",
        "Private Patient",
        "01/02/1980",
        "private-patient-id",
      ]) {
        expect(modelRequest).not.toContain(privateValue);
      }
    },
  );

  it.each([
    "no_match",
    "lookup_failed",
    "not_attempted",
    "active",
    "registration",
  ] as const)("omits the phone-lookup hint for %s", async (mode) => {
    const state = createTestCallState();
    if (mode === "active" || mode === "registration") {
      state.identity.privateCandidates = [
        {
          status: "verified",
          ref: "private",
          patientId: "private-patient",
          firstName: "Hidden",
          appointments: [],
        },
      ];
      state.runtime.preCallLookup.status = "verified";
      if (mode === "active") {
        state.identity.activePatient =
          createConfirmedPatientState().identity.activePatient;
      } else {
        state.identity.registration = { firstName: "New" };
      }
    } else {
      state.runtime.preCallLookup.status = mode;
    }
    const model = new ContextCapturingFakeLLM([
      { input: "I need help.", content: "How can I help?" },
    ]);
    const session = new AgentSession<CallState>({
      llm: model,
      userData: state,
    });
    sessions.push(session);
    await session.start({
      agent: createVoiceAgent(SPRING_HILL_OFFICE_PHONE, {
        ownedMiddleware,
        suppressGreeting: true,
      }).agent,
    });
    await session.run({ userInput: "I need help." }).wait();
    expect(phoneLookupHints(model.requests[0]!)).toEqual([]);
  });

  it("keeps availability in tool history without injecting inventory status", async () => {
    const model = new ContextCapturingFakeLLM([
      { input: "What appointments work now?", content: "Let me check." },
    ]);
    const session = new AgentSession<CallState>({ llm: model });
    sessions.push(session);
    const state = createConfirmedPatientState();
    session.userData = state;
    await session.start({
      agent: createVoiceAgent(SPRING_HILL_OFFICE_PHONE, {
        ownedMiddleware,
        suppressGreeting: true,
        turnClock: { now: () => testInstant },
      }).agent,
    });
    const history = session.currentAgent.chatCtx.copy();
    history.insert([
      llm.FunctionCall.create({
        callId: "old-list",
        name: "list_available_appointments",
        args: "{}",
      }),
      llm.FunctionCallOutput.create({
        callId: "old-list",
        name: "list_available_appointments",
        output: "S1 — Thursday at 4:15 PM with Dr. Smith",
        isError: false,
      }),
    ]);
    await session.currentAgent.updateChatCtx(history);
    clearAvailabilitySelection(state, { invalidateReads: true });

    await session.run({ userInput: "What appointments work now?" }).wait();

    const request = model.requests[0]!;
    expect(JSON.stringify(request)).toContain("S1 — Thursday at 4:15 PM");
    const context = request.items.flatMap((item) =>
      item.type === "message" && item.id === "clinic_time"
        ? [item.textContent]
        : [],
    );
    expect(context).toHaveLength(1);
    expect(context).toEqual([clinicTimestampMessage(testInstant)]);
    expect(context[0]).not.toMatch(
      /Active patient:|Availability:|Earlier lists|S1|refresh before/,
    );
  });

  it("provides patient details and appointment references through resolver output only", async () => {
    const model = new ContextCapturingFakeLLM([
      {
        input: "This is Jane.",
        toolCalls: [
          {
            name: "resolve_patient",
            args: { lastName: null, firstName: "Jane", dob: null },
          },
        ],
      },
    ]);
    const session = new AgentSession<CallState>({ llm: model });
    sessions.push(session);
    const state = createTestCallState({
      preCallCandidates: [
        {
          status: "verified",
          ref: "private-candidate",
          patientId: "private-patient",
          firstName: "Jane",
          lastName: "Doe",
          dob: "01/02/1980",
          insuranceCarrier: "Aetna",
          appointmentsStatus: "found",
          appointments: [1007, 4245].map((appointmentTypeId, index) => ({
            id: 100 + index,
            appointmentTypeId,
            type: "Appointment",
            date: "2026-09-10",
            time: "9:00 AM",
            provider: "Dr. Smith",
            facility: "Spring Hill",
            confirmed: true,
            cancellationToken: "private-cancellation-token",
            rescheduleToken: "private-reschedule-token",
          })),
        },
      ],
    });
    session.userData = state;
    await session.start({
      agent: createVoiceAgent(SPRING_HILL_OFFICE_PHONE, {
        ownedMiddleware,
        suppressGreeting: true,
        turnClock: { now: () => testInstant },
      }).agent,
    });
    await session.run({ userInput: "This is Jane." }).wait();
    expect(phoneLookupHints(model.requests[0]!)).toHaveLength(1);
    const request = model.requests.at(-1)!;
    expect(phoneLookupHints(request)).toEqual([]);
    const input = JSON.stringify(request);
    expect(runtimeMessages(request)).toEqual([
      clinicTimestampMessage(testInstant),
    ]);
    const outputs = request.items.filter(
      (item) => item.type === "function_call_output",
    );
    expect(JSON.stringify(outputs)).toContain(
      "I found you in our system, Jane Doe.",
    );
    expect(JSON.stringify(outputs)).toContain("We have Aetna on file.");
    for (const [index, visitType] of ["medical", "routine_vision"].entries()) {
      const ref =
        state.identity.activePatient!.appointments[index]!.appointmentRef;
      expect(input).toContain(`appointmentRef ${ref}, visitType ${visitType}`);
    }
    expect(input).toContain(
      "Internal appointment references (do not read aloud)",
    );
    expect(input).not.toMatch(
      /private-cancellation-token|private-reschedule-token|appointmentTypeId|private-patient|01\/02\/1980/,
    );
  });
});

class ContextCapturingFakeLLM extends voice.testing.FakeLLM {
  readonly requests: ChatContext[] = [];

  override chat(options: Parameters<voice.testing.FakeLLM["chat"]>[0]) {
    this.requests.push(options.chatCtx.copy());
    return super.chat(options);
  }
}

function runtimeMessages(chatCtx: ChatContext): string[] {
  return chatCtx.items.flatMap((item) =>
    item.type === "message" && item.id === "clinic_time"
      ? [item.textContent ?? ""]
      : [],
  );
}

function phoneLookupHints(chatCtx: ChatContext): string[] {
  return chatCtx.items.flatMap((item) =>
    item.type === "message" && item.id === "precall_lookup_hint"
      ? [item.textContent ?? ""]
      : [],
  );
}
