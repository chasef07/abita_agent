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
import { patientContext } from "../identity/patient-identity.js";
import { clearAvailabilitySelection } from "../scheduling/state.js";
import type { PreCallPatientCandidate } from "../state/call-state.js";
import {
  createConfirmedPatientState,
  createTestCallState,
} from "./support/call-state.js";

const ownedMiddleware = new InMemoryOwnedMiddleware();

describe("agent runtime context", () => {
  initializeLogger({ pretty: false, level: "silent" });
  const sessions: AgentSession[] = [];

  afterEach(async () => {
    await Promise.all(sessions.splice(0).map((session) => session.close()));
  });

  it("exposes only lookup outcomes and candidate counts before patient activation", () => {
    const privateCandidate: PreCallPatientCandidate = {
      status: "verified",
      ref: "private-candidate-reference",
      firstName: "Private",
      lastName: "Patient",
      dob: "01/02/1980",
      patientId: "private-patient-id",
      appointments: [],
    };
    const outcomes = [
      { status: "no_match" as const, candidates: [] },
      { status: "lookup_failed" as const, candidates: [] },
      { status: "verified" as const, candidates: [privateCandidate] },
      {
        status: "multiple_matches" as const,
        candidates: [privateCandidate, { ...privateCandidate, ref: "second" }],
      },
    ];

    const projections = outcomes.map(({ status, candidates }) => {
      const state = createTestCallState({
        preCallCandidates: candidates,
        preCallLookup: { status },
      });
      return patientContext(state);
    });

    expect(projections[0]).toContain("Phone lookup found no matches");
    expect(projections[1]).toContain("Phone lookup failed");
    expect(projections.join(" ")).not.toMatch(
      /Private|P-R-I-V-A-T-E|private-|01\/02\/1980/,
    );
  });

  it("injects exactly one fresh context message into each model request only", async () => {
    const model = new ContextCapturingFakeLLM([
      { input: "I need an appointment.", content: "Who is it for?" },
    ]);
    const session = new AgentSession({ llm: model });
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
    await session.start({
      agent: createVoiceAgent(SPRING_HILL_OFFICE_PHONE, {
        ownedMiddleware,
        suppressGreeting: true,
      }).agent,
    });

    await session.run({ userInput: "I need an appointment." }).wait();

    expect(patientMessages(model.requests[0])).toEqual([
      expect.stringContaining("Phone lookup found 1 possible patient"),
    ]);
    expect(patientMessages(model.requests[0])[0]).not.toContain(
      "resolve_patient",
    );
    expect(patientMessages(session.currentAgent.chatCtx)).toEqual([]);
    const modelRequest = JSON.stringify(model.requests[0]);
    for (const privateValue of [
      "private-candidate-reference",
      "Private Patient",
      "01/02/1980",
      "private-patient-id",
    ]) {
      expect(modelRequest).not.toContain(privateValue);
    }
  });

  it("keeps availability in tool history without injecting inventory status", async () => {
    const model = new ContextCapturingFakeLLM([
      { input: "What appointments work now?", content: "Let me check." },
    ]);
    const session = new AgentSession({ llm: model });
    sessions.push(session);
    const state = createConfirmedPatientState();
    session.userData = state;
    await session.start({
      agent: createVoiceAgent(SPRING_HILL_OFFICE_PHONE, {
        ownedMiddleware,
        suppressGreeting: true,
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
      item.type === "message" && item.id === "runtime_turn_context"
        ? [item.textContent]
        : [],
    );
    expect(context).toHaveLength(1);
    expect(context[0]).toContain("Current clinic-local date and time");
    expect(context[0]).toContain("Active patient:");
    expect(context[0]).not.toMatch(
      /Availability:|Earlier lists|S1|refresh before/,
    );
  });

  it("provides appointment references once through resolver output with minimal current context", async () => {
    const model = new ContextCapturingFakeLLM([
      {
        input: "This is Jane.",
        toolCalls: [
          { name: "resolve_patient", args: { firstName: "Jane", dob: null } },
        ],
      },
    ]);
    const session = new AgentSession({ llm: model });
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
      }).agent,
    });
    await session.run({ userInput: "This is Jane." }).wait();
    const request = model.requests.at(-1)!;
    const input = JSON.stringify(request);
    expect(patientMessages(request)).toEqual(["Active patient: Jane Doe."]);
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

function patientMessages(chatCtx: ChatContext): string[] {
  return chatCtx.items.flatMap((item) =>
    item.type === "message" &&
    item.role === "system" &&
    item.textContent?.includes("Active patient:")
      ? [item.textContent.slice(item.textContent.indexOf("Active patient:"))]
      : [],
  );
}
