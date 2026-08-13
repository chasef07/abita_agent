import {
  AgentSession,
  ChatContext,
  ChatMessage,
  initializeLogger,
} from "@livekit/agents";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVoiceAgent } from "../agent.js";
import { SPRING_HILL_OFFICE_PHONE } from "../customers/abita/profile.js";
import { CALLER_CANDIDATE_REF } from "../state/call-state.js";
import { patientModelProjection } from "../identity/patient-identity.js";
import { createTestCallState } from "./support/call-state.js";

describe("completed user turn context", () => {
  initializeLogger({ pretty: false, level: "silent" });

  const sessions: AgentSession[] = [];

  afterEach(async () => {
    await Promise.all(sessions.splice(0).map((session) => session.close()));
  });

  it("adds a fresh clinic timestamp to each temporary context only", async () => {
    const instants = [
      new Date("2026-07-25T03:58:00.000Z"),
      new Date("2026-07-25T04:02:00.000Z"),
    ];
    const session = new AgentSession();
    sessions.push(session);
    session.userData = createTestCallState({
      officeKey: "spring-hill",
      amdOfficePhone: SPRING_HILL_OFFICE_PHONE,
      trunkPhone: SPRING_HILL_OFFICE_PHONE,
    });
    await session.start({
      agent: createVoiceAgent(SPRING_HILL_OFFICE_PHONE, {
        suppressGreeting: true,
        turnClock: {
          now: () => instants.shift() ?? new Date("invalid"),
        },
      }).agent,
    });

    const firstTurnContext = ChatContext.empty();
    await session.currentAgent.onUserTurnCompleted(
      firstTurnContext,
      ChatMessage.create({ role: "user", content: "First turn" }),
    );
    const secondTurnContext = ChatContext.empty();
    await session.currentAgent.onUserTurnCompleted(
      secondTurnContext,
      ChatMessage.create({ role: "user", content: "Second turn" }),
    );

    expect(systemText(firstTurnContext)).toContain(
      "Friday, July 24th, 2026 at 11:58 PM Eastern time",
    );
    expect(systemText(secondTurnContext)).toContain(
      "Saturday, July 25th, 2026 at 12:02 AM Eastern time",
    );
    expect(systemText(secondTurnContext)).not.toContain("11:58 PM");
    expect(systemText(session.currentAgent.chatCtx)).not.toContain(
      "Current clinic-local date and time for this turn",
    );
  });

  it("activates a matching pre-call patient from the first caller turn without resolve_patient", async () => {
    const state = createTestCallState({
      officeKey: "spring-hill",
      amdOfficePhone: SPRING_HILL_OFFICE_PHONE,
      trunkPhone: SPRING_HILL_OFFICE_PHONE,
      preCallCandidates: [
        {
          status: "verified",
          ref: CALLER_CANDIDATE_REF,
          firstName: "LARRY",
          lastName: "TEST",
          dob: "08/18/2020",
          patientId: "patient-larry",
          appointments: [],
          appointmentsStatus: "none",
          insuranceCarrier: "FLORIDA BLUE SHIELD",
        },
      ],
    });
    const identityLookup = vi.fn(async () => {
      throw new Error("Verified pre-call patients must not be looked up again");
    });
    const session = new AgentSession();
    sessions.push(session);
    session.userData = state;
    await session.start({
      agent: createVoiceAgent(SPRING_HILL_OFFICE_PHONE, {
        identityLookup,
        suppressGreeting: true,
      }).agent,
    });

    const turnContext = ChatContext.empty();
    await session.currentAgent.onUserTurnCompleted(
      turnContext,
      ChatMessage.create({ role: "user", content: "L-A-R-R-Y" }),
    );

    expect(identityLookup).not.toHaveBeenCalled();
    expect(state.identity.activePatient).toMatchObject({
      kind: "existing",
      patientId: "patient-larry",
      name: "LARRY TEST",
    });
    expect(state.identity.receipts).toEqual([
      { outcome: "confirmed", source: "caller_transcript" },
    ]);
    expect(state.runtime.patientIdentityOutcomes).toEqual([]);
    expect(patientModelProjection(state)).toContain("LARRY TEST");
    expect(patientModelProjection(state)).toContain(
      "Insurance on file: FLORIDA BLUE SHIELD.",
    );
    expect(patientModelProjection(state)).not.toContain("patient-larry");
  });

  it("contains a rejected lightweight-candidate hydration on the caller turn", async () => {
    const state = createTestCallState({
      officeKey: "spring-hill",
      amdOfficePhone: SPRING_HILL_OFFICE_PHONE,
      trunkPhone: SPRING_HILL_OFFICE_PHONE,
      preCallCandidates: [
        {
          status: "candidate",
          ref: CALLER_CANDIDATE_REF,
          firstName: "LARRY",
          patientId: "patient-larry",
        },
      ],
    });
    const identityLookup = vi.fn(async () => {
      throw new Error("Patient lookup failed");
    });
    const session = new AgentSession();
    sessions.push(session);
    session.userData = state;
    await session.start({
      agent: createVoiceAgent(SPRING_HILL_OFFICE_PHONE, {
        identityLookup,
        suppressGreeting: true,
      }).agent,
    });

    await expect(
      session.currentAgent.onUserTurnCompleted(
        ChatContext.empty(),
        ChatMessage.create({ role: "user", content: "L-A-R-R-Y" }),
      ),
    ).rejects.toThrow("Patient lookup failed");
    expect(state.identity.activePatient).toBeNull();
  });
});

function systemText(chatCtx: ChatContext): string {
  return chatCtx.items
    .filter((item) => item.type === "message" && item.role === "system")
    .map((item) => item.textContent ?? "")
    .join(" ");
}
