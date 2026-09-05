import {
  AgentSession,
  initializeLogger,
  type ChatContext,
  voice,
} from "@livekit/agents";
import { afterEach, describe, expect, it } from "vitest";
import { createVoiceAgent } from "../agent.js";
import { InMemoryOwnedMiddleware } from "./support/owned-middleware.js";
import { SPRING_HILL_OFFICE_PHONE } from "../customers/abita/profile.js";
import { patientModelProjection } from "../identity/patient-identity.js";
import { availabilityModelProjection } from "../scheduling/availability.js";
import type { PreCallPatientCandidate } from "../state/call-state.js";
import {
  createConfirmedPatientState,
  createTestCallState,
} from "./support/call-state.js";

const ownedMiddleware = new InMemoryOwnedMiddleware();

describe("patient model projection", () => {
  initializeLogger({ pretty: false, level: "silent" });
  const sessions: AgentSession[] = [];

  afterEach(async () => {
    await Promise.all(sessions.splice(0).map((session) => session.close()));
  });

  it("makes every unresolved pre-call outcome indistinguishable", () => {
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
        preCallLookup: { status, durationMs: 12 },
      });
      return patientModelProjection(state);
    });

    expect(new Set(projections)).toEqual(
      new Set(["Patient situation: no patient is active."]),
    );
    expect(projections.join(" ")).not.toMatch(
      /private|candidate|lookup|match|01\/02\/1980/i,
    );
  });

  it("injects exactly one fresh projection into each model request only", async () => {
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
      preCallLookup: { status: "verified", durationMs: 12 },
    });
    await session.start({
      agent: createVoiceAgent(SPRING_HILL_OFFICE_PHONE, {
        ownedMiddleware,
        suppressGreeting: true,
      }).agent,
    });

    await session.run({ userInput: "I need an appointment." }).wait();

    expect(patientMessages(model.requests[0])).toEqual([
      "Patient situation: no patient is active.",
    ]);
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

  it("keeps availability references in fresh system context", () => {
    const state = createConfirmedPatientState();
    state.availability.slots = [
      {
        slotId: "S1",
        provider: "Dr. Bach",
        date: "2026-06-01",
        time: "9:00 AM",
        datetime: "2026-06-01T09:00:00",
        routing: "all_three",
      },
    ];

    const projection = availabilityModelProjection(state);

    expect(projection).toContain(
      "S1 is Monday, June 1 at 9:00 AM with Dr. Bach",
    );
    expect(projection).toContain(
      "use the matching value as appointmentSlotRef",
    );
    expect(projection).not.toContain("bookingToken");
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
    item.textContent?.includes("Patient situation:")
      ? [item.textContent.slice(item.textContent.indexOf("Patient situation:"))]
      : [],
  );
}
