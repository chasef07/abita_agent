import {
  AgentSession,
  initializeLogger,
  llm,
  type ChatContext,
  voice,
} from "@livekit/agents";
import { afterEach, describe, expect, it } from "vitest";
import { createSchedulingTools } from "../scheduling/tools.js";
import { InMemorySchedulingMiddleware } from "./support/scheduling-middleware.js";
import { createToolContext } from "./support/tool-context.js";
import { createVoiceAgent } from "../agent.js";
import { InMemoryOwnedMiddleware } from "./support/owned-middleware.js";
import { SPRING_HILL_OFFICE_PHONE } from "../customers/abita/profile.js";
import { replaceActiveAppointments } from "../state/appointments.js";
import { patientModelProjection } from "../identity/patient-identity.js";
import {
  clearAvailabilitySelection,
  replaceAvailabilitySlots,
} from "../scheduling/state.js";
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

  it("exposes lookup outcomes without revealing private candidate identities", () => {
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

    expect(projections[0]).toContain("Phone lookup found no matches");
    expect(projections[1]).toContain("Phone lookup failed");
    expect(projections[2]).toContain("Phone lookup found 1 possible patient");
    expect(projections[3]).toContain("Phone lookup found 2 possible patients");
    expect(projections.join(" ")).not.toMatch(/Private|private-|01\/02\/1980/);
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
      expect.stringContaining("Phone lookup found 1 possible patient"),
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

  it.each([
    "invalidated",
    "empty_expired",
    "first_empty_reset",
    "incomplete_expansion",
  ])(
    "marks old calendar results unusable in actual model input after %s",
    async (mode) => {
      const model = new ContextCapturingFakeLLM([
        {
          input: "What appointments work now?",
          content: "Let me check the current appointments.",
        },
      ]);
      const session = new AgentSession({ llm: model });
      sessions.push(session);
      const state = createConfirmedPatientState();
      session.userData = state;
      if (mode === "first_empty_reset") {
        replaceAvailabilitySlots(state, [], "all_three");
        state.availability.refreshAfter = Date.now() + 60_000;
        expect(state.availability.version).toBe(1);
        expect(state.availability.nextSlotIndex).toBe(0);
      } else {
        state.availability.nextSlotIndex = 4;
      }
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
          output:
            mode === "first_empty_reset"
              ? "No openings for the previous patient"
              : "S1 — Thursday at 4:15 PM with Dr. Smith",
          isError: false,
        }),
      ]);
      await session.currentAgent.updateChatCtx(history);
      if (mode === "incomplete_expansion") {
        const middleware = new InMemorySchedulingMiddleware({
          availability: [
            {
              status: "none",
              slots: [],
              dateShifted: false,
              shouldRetrySameSearch: false,
            },
            {
              status: "incomplete",
              slots: [],
              dateShifted: false,
              shouldRetrySameSearch: true,
            },
          ],
        });
        const tool =
          createSchedulingTools(middleware).list_available_appointments;
        const options = {
          ctx: createToolContext(state),
          toolCallId: "expansion",
        } as never;
        await tool.execute({ range: "default", visitType: "medical" }, options);
        await tool.execute({ range: "+1month", visitType: "medical" }, options);
      } else {
        clearAvailabilitySelection(state, {
          invalidateReads: "patient_context_changed",
        });
      }
      if (mode === "empty_expired")
        state.availability.refreshAfter = Date.now() - 1;
      await session.run({ userInput: "What appointments work now?" }).wait();
      const request = JSON.stringify(model.requests[0]);
      expect(request).toContain(
        mode === "first_empty_reset"
          ? "No openings for the previous patient"
          : "S1 — Thursday",
      ); // Historical tool result still exists.
      const system = model.requests[0]!.items.flatMap((item) =>
        item.type === "message" && item.role === "system"
          ? [item.textContent]
          : [],
      ).join(" ");
      if (mode === "incomplete_expansion")
        expect(system).not.toContain("inventory is empty");
      expect(system).toContain(
        mode === "empty_expired"
          ? "inventory is stale"
          : "All earlier appointment lists are invalid",
      );
    },
  );

  it("exposes the matching visit category beside each loaded appointment reference in model input", async () => {
    const model = new ContextCapturingFakeLLM([
      { input: "Move my appointment.", content: "I can help move that visit." },
    ]);
    const session = new AgentSession({ llm: model });
    sessions.push(session);
    const state = createConfirmedPatientState();
    replaceActiveAppointments(
      state,
      [1007, 4245].map((appointmentTypeId, index) => ({
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
      "found",
    );
    session.userData = state;
    await session.start({
      agent: createVoiceAgent(SPRING_HILL_OFFICE_PHONE, {
        ownedMiddleware,
        suppressGreeting: true,
      }).agent,
    });
    await session.run({ userInput: "Move my appointment." }).wait();
    const input = JSON.stringify(model.requests[0]);
    for (const [index, visitType] of ["medical", "routine_vision"].entries()) {
      const ref =
        state.identity.activePatient!.appointments[index]!.appointmentRef;
      expect(input).toContain(`appointmentRef ${ref}, visitType ${visitType}`);
    }
    expect(input).not.toMatch(
      /private-cancellation-token|private-reschedule-token|appointmentTypeId/,
    );
  });

  it("identifies current inventory without duplicating the tool-result calendar", () => {
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
      "Current appointment inventory has 1 slots (S1 through S1)",
    );
    expect(projection).toContain("use appointmentSlotRef");
    expect(projection).not.toContain("bookingToken");
    expect(projection).not.toContain("9:00 AM");
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
