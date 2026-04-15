/**
 * Transcript replay tests.
 * Replays real call scenarios through the agent with modified prompts
 * to verify that prompt changes actually fix the identified issues.
 *
 * Uses: real LLM (inference.LLM) + mock tools (no API calls).
 * Run: npx vitest run src/__tests__/replay.test.ts
 */

import { initializeLogger } from "@livekit/agents";
import dotenv from "dotenv";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestAgent, loadTranscriptHistory, type TestContext, type TranscriptTurn } from "./helpers.js";
import { DEFAULT_VERIFY_NOT_FOUND } from "./mock-tools.js";

dotenv.config({ path: ".env.local" });
initializeLogger({ pretty: false, level: "warn" });

// ============================================================
// Test 1: Fabricated registration data (SCL_VFDwKT4Gj8Lp)
// Issue: Agent called add_patient with hallucinated data after
// only collecting name + DOB. Should ask for remaining fields.
// ============================================================
describe("fabricated registration prevention", () => {
  let ctx: TestContext;

  afterEach(async () => {
    await ctx?.cleanup();
  });

  it("should NOT call add_patient after only collecting name and DOB", async () => {
    // Setup: new patient, Eye Radiance office, insurance already checked
    ctx = await createTestAgent({
      phoneLookup: null,
      trunkPhone: "+13523202007",
    });

    // Replay the conversation up to the point where the agent went wrong:
    // Caller: Zordena Zolina, DOB 11/23/1969, insurance = Ambetter (accepted)
    // verify_patient returned not_found
    // The REAL call then immediately called add_patient with fabricated data.
    // With the fix, the agent should ask for phone, email, address, etc.
    const history: TranscriptTurn[] = [
      {
        turn: 1,
        callerText: null,
        agentText: "Thank you for calling Eye Radiance powered by Abeeta Eye Group. How can I help you?",
        toolCalls: [],
      },
      {
        turn: 2,
        callerText: "Hi. I just wondering if do you accept I'm better insurance",
        agentText: "I can check that for you. What's the name of the insurance plan you have?",
        toolCalls: [],
      },
      {
        turn: 3,
        callerText: "I'm better.",
        agentText: "Yeah, we do accept Ambetter.",
        toolCalls: [
          {
            name: "check_insurance",
            args: '{"plan": "Ambetter"}',
            result: '"Insurance list content..."',
            isError: false,
          },
        ],
      },
      {
        turn: 4,
        callerText: "Can I schedule an appointment?",
        agentText: "Absolutely. Let me get you set up. I'll need your last name and date of birth.",
        toolCalls: [],
      },
      {
        turn: 5,
        callerText: "Last name, Zolina, d o l i n a.",
        agentText: "I'm not finding you in our system. Let me get you registered as a new patient. What's your date of birth?",
        toolCalls: [
          {
            name: "verify_patient",
            args: '{"firstName": "Zordena", "lastName": "Zolina"}',
            result: JSON.stringify(DEFAULT_VERIFY_NOT_FOUND),
            isError: false,
          },
        ],
      },
    ];

    await loadTranscriptHistory(ctx.agent, history, 99);

    // Now send the DOB — this is where the real agent fabricated data
    const result = await ctx.session.run({ userInput: "November twenty third nineteen sixty nine." }).wait();

    // The agent should NOT have called add_patient — it should ask for more fields
    const addPatientCalls = ctx.callLog.filter((c) => c.name === "add_patient");
    expect(addPatientCalls).toHaveLength(0);

    // The agent should be asking for the next piece of info (phone, email, address, etc.)
    // It might also ask about insurance first per the collection order
    const lastMessage = result.events
      .filter((e) => e.type === "message" && e.item.role === "assistant")
      .pop();
    expect(lastMessage).toBeDefined();

    // Judge: agent should be continuing the conversation (asking for info),
    // NOT claiming registration is complete or saying "all set"
    if (lastMessage && lastMessage.type === "message") {
      await result.expect
        .containsMessage({ role: "assistant" })
        .judge(ctx.llm, {
          intent: "The agent should be asking the caller a question to continue collecting information for registration. It should NOT say the patient is registered, 'all set', or that registration is complete.",
        });
    }
  });
});

// ============================================================
// Test 2: Transfer on insistence (SCL_NLZya5NUF5TG)
// Issue: Caller said "Live representative" and "Agent" but agent
// continued registration instead of transferring.
// ============================================================
describe("transfer on insistence", () => {
  let ctx: TestContext;

  afterEach(async () => {
    await ctx?.cleanup();
  });

  it("should transfer when caller says 'representative' a second time", async () => {
    ctx = await createTestAgent({ phoneLookup: null });

    // Simulate: agent is mid-registration, caller already said "representative" once
    // and agent offered to help. Now caller says it again.
    const history: TranscriptTurn[] = [
      {
        turn: 1,
        callerText: null,
        agentText: "thank you for calling Abita Eye Group, this is David, how can I help you?",
        toolCalls: [],
      },
      {
        turn: 2,
        callerText: "New patient appointment.",
        agentText: "alright, let me get you set up. Can I get your first name?",
        toolCalls: [],
      },
      {
        turn: 3,
        callerText: "Live representative.",
        agentText: "yeah, what are you calling about?",
        toolCalls: [],
      },
    ];

    await loadTranscriptHistory(ctx.agent, history, 99);

    // Caller insists again — should trigger immediate transfer
    const result = await ctx.session.run({ userInput: "Agent." }).wait();

    // Should have called transfer_call
    const transferCalls = ctx.callLog.filter((c) => c.name === "transfer_call");
    expect(transferCalls.length).toBeGreaterThanOrEqual(1);

    // Should have called it exactly once (not double)
    expect(transferCalls).toHaveLength(1);
  });

  it("should try to help on first 'representative' request", async () => {
    ctx = await createTestAgent({ phoneLookup: null });

    const history: TranscriptTurn[] = [
      {
        turn: 1,
        callerText: null,
        agentText: "thank you for calling Abita Eye Group, this is David, how can I help you?",
        toolCalls: [],
      },
    ];

    await loadTranscriptHistory(ctx.agent, history, 99);

    // First time saying "representative" — agent should try to help
    const result = await ctx.session.run({ userInput: "Representative." }).wait();

    // Should NOT have transferred yet — should ask what they need
    const transferCalls = ctx.callLog.filter((c) => c.name === "transfer_call");
    expect(transferCalls).toHaveLength(0);

    // Should ask what they're calling about
    await result.expect
      .containsMessage({ role: "assistant" })
      .judge(ctx.llm, {
        intent: "The agent should ask what the caller needs help with before transferring. It should not immediately transfer on the first request.",
      });
  });
});

// ============================================================
// Test 2b: Transfer on "operator" (SCL_TRYa2gUu4qsD, SCL_LFwTXXVvbUvS)
// Issue: Caller said "operator" 5x without triggering transfer.
// "operator" must be recognized as a trigger word.
// ============================================================
describe("transfer on operator keyword", () => {
  let ctx: TestContext;

  afterEach(async () => {
    await ctx?.cleanup();
  });

  it("should transfer when caller says 'operator' a second time", async () => {
    ctx = await createTestAgent({ phoneLookup: null });

    const history: TranscriptTurn[] = [
      {
        turn: 1,
        callerText: null,
        agentText: "thank you for calling Abita Eye Group, this is David, how can I help you?",
        toolCalls: [],
      },
      {
        turn: 2,
        callerText: "Operator.",
        agentText: "yeah, what can I help you with today?",
        toolCalls: [],
      },
    ];

    await loadTranscriptHistory(ctx.agent, history, 99);

    // Caller says "operator" again — should trigger immediate transfer
    const result = await ctx.session.run({ userInput: "Operator." }).wait();

    const transferCalls = ctx.callLog.filter((c) => c.name === "transfer_call");
    expect(transferCalls.length).toBeGreaterThanOrEqual(1);
    expect(transferCalls).toHaveLength(1);
  });
});

// ============================================================
// Test 3: Correct new patient flow
// Verify that a well-formed registration collects all fields.
// ============================================================
describe("new patient registration flow", () => {
  let ctx: TestContext;

  afterEach(async () => {
    await ctx?.cleanup();
  });

  it("should ask for insurance before other registration fields", async () => {
    ctx = await createTestAgent({ phoneLookup: null });

    const history: TranscriptTurn[] = [
      {
        turn: 1,
        callerText: null,
        agentText: "thank you for calling Abita Eye Group, this is David, how can I help you?",
        toolCalls: [],
      },
      {
        turn: 2,
        callerText: "I need to schedule an eye exam. I'm a new patient.",
        agentText: "Let me get your information. What's your first name?",
        toolCalls: [],
      },
      {
        turn: 3,
        callerText: "Jane Smith. Date of birth March fifteenth nineteen eighty five.",
        agentText: "I'm not finding you in our system. Let me get you registered.",
        toolCalls: [
          {
            name: "verify_patient",
            args: '{"firstName": "Jane", "lastName": "Smith", "dob": "03/15/1985"}',
            result: JSON.stringify(DEFAULT_VERIFY_NOT_FOUND),
            isError: false,
          },
        ],
      },
    ];

    await loadTranscriptHistory(ctx.agent, history, 99);

    // After verify fails, agent should start registration. First question should be about insurance.
    const result = await ctx.session.run({ userInput: "OK sounds good." }).wait();

    await result.expect
      .containsMessage({ role: "assistant" })
      .judge(ctx.llm, {
        intent: "The agent should be asking about insurance as the first step of registration. It should ask what insurance the caller has.",
      });
  });
});

// ============================================================
// Test 4: FAQ handling — should not transfer
// ============================================================
describe("FAQ calls should not transfer", () => {
  let ctx: TestContext;

  afterEach(async () => {
    await ctx?.cleanup();
  });

  it("should handle insurance question without transferring", async () => {
    ctx = await createTestAgent({ phoneLookup: null });

    const result = await ctx.session.run({ userInput: "Hi, do you accept Aetna?" }).wait();

    // Should call check_insurance, not transfer_call
    const insuranceCalls = ctx.callLog.filter((c) => c.name === "check_insurance");
    const transferCalls = ctx.callLog.filter((c) => c.name === "transfer_call");

    expect(insuranceCalls.length).toBeGreaterThanOrEqual(1);
    expect(transferCalls).toHaveLength(0);
  });
});
