import {
  Agent,
  AgentSession,
  ChatContext,
  ChatMessage,
  initializeLogger,
} from "@livekit/agents";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVoiceAgent } from "../agent.js";
import { InMemoryOwnedMiddleware } from "./support/owned-middleware.js";
import { SPRING_HILL_OFFICE_PHONE } from "../customers/abita/profile.js";
import { CALLER_CANDIDATE_REF } from "../state/call-state.js";
import { patientModelProjection } from "../identity/patient-identity.js";
import { createTestCallState } from "./support/call-state.js";

const ownedMiddleware = new InMemoryOwnedMiddleware();

describe("completed user turn context", () => {
  initializeLogger({ pretty: false, level: "silent" });

  const sessions: AgentSession[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(sessions.splice(0).map((session) => session.close()));
  });

  it("projects a fresh clinic timestamp into each model request only", async () => {
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
        ownedMiddleware,
        suppressGreeting: true,
        turnClock: {
          now: () => instants.shift() ?? new Date("invalid"),
        },
      }).agent,
    });

    const model = vi.spyOn(Agent.default, "llmNode").mockResolvedValue(null);
    const firstTurnContext = ChatContext.empty();
    const secondTurnContext = ChatContext.empty();
    for (const chatCtx of [firstTurnContext, secondTurnContext]) {
      await session.currentAgent.llmNode(
        chatCtx,
        session.currentAgent.toolCtx,
        {},
      );
    }

    expect(systemText(model.mock.calls[0]![1])).toContain(
      "Friday, July 24th, 2026 at 11:58 PM Eastern time",
    );
    expect(systemText(model.mock.calls[1]![1])).toContain(
      "Saturday, July 25th, 2026 at 12:02 AM Eastern time",
    );
    expect(systemText(model.mock.calls[1]![1])).not.toContain("11:58 PM");
    expect(firstTurnContext.items).toEqual([]);
    expect(secondTurnContext.items).toEqual([]);
    expect(systemText(session.currentAgent.chatCtx)).not.toContain(
      "Current clinic-local date and time for this turn",
    );
  });

  it.each([
    "L-A-R-R-Y",
    "I am not Larry.",
    "I am Larry, calling for my son John.",
  ])(
    "leaves patient selection to resolve_patient for %s",
    async (transcript) => {
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
      const middleware = new InMemoryOwnedMiddleware();
      const session = new AgentSession();
      sessions.push(session);
      session.userData = state;
      await session.start({
        agent: createVoiceAgent(SPRING_HILL_OFFICE_PHONE, {
          ownedMiddleware: middleware,
          suppressGreeting: true,
        }).agent,
      });

      const turnContext = ChatContext.empty();
      await session.currentAgent.onUserTurnCompleted(
        turnContext,
        ChatMessage.create({ role: "user", content: transcript }),
      );

      expect(middleware.operations).toEqual([]);
      expect(state.identity.activePatient).toBeNull();
      expect(state.identity.receipts).toEqual([]);
      expect(state.runtime.outcomeReceipts).toEqual([]);
      expect(patientModelProjection(state)).not.toContain("LARRY TEST");
      expect(patientModelProjection(state)).not.toContain(
        "FLORIDA BLUE SHIELD",
      );
      expect(patientModelProjection(state)).not.toContain("patient-larry");
    },
  );

  it("does not hydrate a candidate before a resolver tool call", async () => {
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
    const middleware = new InMemoryOwnedMiddleware({
      resolvePatient: [new Error("Patient lookup failed")],
    });
    const session = new AgentSession();
    sessions.push(session);
    session.userData = state;
    await session.start({
      agent: createVoiceAgent(SPRING_HILL_OFFICE_PHONE, {
        ownedMiddleware: middleware,
        suppressGreeting: true,
      }).agent,
    });

    await expect(
      session.currentAgent.onUserTurnCompleted(
        ChatContext.empty(),
        ChatMessage.create({ role: "user", content: "L-A-R-R-Y" }),
      ),
    ).resolves.toBeUndefined();
    expect(middleware.operations).toEqual([]);
    expect(state.identity.activePatient).toBeNull();
  });
});

function systemText(chatCtx: ChatContext): string {
  return chatCtx.items
    .filter((item) => item.type === "message" && item.role === "system")
    .map((item) => item.textContent ?? "")
    .join(" ");
}
