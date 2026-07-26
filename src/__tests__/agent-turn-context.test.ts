import {
  AgentSession,
  ChatContext,
  ChatMessage,
  initializeLogger,
} from "@livekit/agents";
import { afterEach, describe, expect, it } from "vitest";
import { createVoiceAgent } from "../agent.js";
import { SPRING_HILL_OFFICE_PHONE } from "../customers/abita/profile.js";
import { insuranceSnapshot, setInsuranceOnFile } from "../scheduling/state.js";
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
      agent: createVoiceAgent(undefined, SPRING_HILL_OFFICE_PHONE, {
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

  it("projects only the current confirmed patient into each temporary context", async () => {
    const state = createTestCallState({
      officeKey: "spring-hill",
      amdOfficePhone: SPRING_HILL_OFFICE_PHONE,
      trunkPhone: SPRING_HILL_OFFICE_PHONE,
      patientId: "patient-jane",
      patientName: "JANE DOE",
      insuranceCarrier: "AETNA",
      appointmentsStatus: "none",
    });
    state.identity.patient.identityConfirmed = true;

    const session = new AgentSession();
    sessions.push(session);
    session.userData = state;
    await session.start({
      agent: createVoiceAgent(undefined, SPRING_HILL_OFFICE_PHONE, {
        suppressGreeting: true,
      }).agent,
    });

    const firstTurnContext = ChatContext.empty();
    await session.currentAgent.onUserTurnCompleted(
      firstTurnContext,
      ChatMessage.create({ role: "user", content: "First question" }),
    );

    state.identity.patient = {
      ...state.identity.patient,
      patientId: "patient-john",
      name: "JOHN DOE",
    };
    setInsuranceOnFile(
      state,
      insuranceSnapshot({
        plan: "HUMANA",
        canonicalPlan: "HUMANA",
        currentCarrier: "HUMANA",
      }),
    );

    const secondTurnContext = ChatContext.empty();
    await session.currentAgent.onUserTurnCompleted(
      secondTurnContext,
      ChatMessage.create({ role: "user", content: "Second question" }),
    );

    expect(systemText(firstTurnContext)).toContain("Patient: JANE DOE.");
    expect(systemText(firstTurnContext)).toContain("Insurance on file: AETNA.");
    expect(systemText(secondTurnContext)).toContain("Patient: JOHN DOE.");
    expect(systemText(secondTurnContext)).toContain(
      "Insurance on file: HUMANA.",
    );
    expect(systemText(secondTurnContext)).not.toContain("JANE DOE");
    expect(systemText(secondTurnContext)).not.toContain("AETNA");
    expect(systemText(session.currentAgent.chatCtx)).not.toContain(
      "Insurance on file:",
    );
  });
});

function systemText(chatCtx: ChatContext): string {
  return chatCtx.items
    .filter((item) => item.type === "message" && item.role === "system")
    .map((item) => item.textContent ?? "")
    .join(" ");
}
