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

// ============================================================
// Test 4b: Mid-collection human request (SCL_ffWvAhkfphmz)
// Issue: Caller said "Can I speak to a human?" during a spelling
// loop and the agent ignored the request, continuing to ask for
// letter corrections. A human request must stop any in-flight task.
// ============================================================
describe("mid-collection human request", () => {
  let ctx: TestContext;

  afterEach(async () => {
    await ctx?.cleanup();
  });

  it("should not keep spelling when caller asks for a human mid-loop", async () => {
    ctx = await createTestAgent({ phoneLookup: null });

    // Simulate being mid-registration, deep in a last-name spelling loop
    const history: TranscriptTurn[] = [
      {
        turn: 1,
        callerText: null,
        agentText: "thank you for calling Abita Eye Group, this is David, how can I help you?",
        toolCalls: [],
      },
      {
        turn: 2,
        callerText: "Schedule appointment.",
        agentText: "yeah I can help with that. Have you been seen here before?",
        toolCalls: [],
      },
      {
        turn: 3,
        callerText: "No.",
        agentText: "ok let me get you set up. What insurance do you have?",
        toolCalls: [],
      },
      {
        turn: 4,
        callerText: "UnitedHealthcare PPO.",
        agentText: "yeah we take United Healthcare. What's your name?",
        toolCalls: [
          {
            name: "check_insurance",
            args: '{"plan": "UnitedHealthcare PPO"}',
            result: '"accepted"',
            isError: false,
          },
        ],
      },
      {
        turn: 5,
        callerText: "Christopher Hamilton.",
        agentText: "go ahead and spell the last name for me.",
        toolCalls: [],
      },
      {
        turn: 6,
        callerText: "H-A-M—",
        agentText: "is that H-A-M-M-E-L-M-A-N?",
        toolCalls: [],
      },
      {
        turn: 7,
        callerText: "Um—",
        agentText: "you said H-A-M-M-E-L-M-A-N, but I have H-A-M-M-E-L-T-O-N. Which one is correct?",
        toolCalls: [],
      },
    ];

    await loadTranscriptHistory(ctx.agent, history, 99);

    // Caller interrupts the spelling loop to request a human
    const result = await ctx.session.run({ userInput: "Can I speak to a human?" }).wait();

    // Agent should NOT have called add_patient (still missing fields anyway)
    const addPatientCalls = ctx.callLog.filter((c) => c.name === "add_patient");
    expect(addPatientCalls).toHaveLength(0);

    // Judge: the response should acknowledge the human-request — either asking
    // what they need or preparing to transfer. It must NOT be another spelling prompt.
    await result.expect
      .containsMessage({ role: "assistant" })
      .judge(ctx.llm, {
        intent: "The agent should acknowledge the caller's request to speak to a human — either by asking once what they need, or by announcing a transfer. The agent must NOT continue the last-name spelling loop or ignore the request.",
      });
  });
});

// ============================================================
// Test 4c: Email field integrity (SCL_c28biLNL3jhd)
// Issue: Agent called add_patient with email="Spencer Hamelman"
// because the caller said the subscriber name when asked for email.
// The email field must contain a real email address, not a name.
// ============================================================
describe("email field integrity", () => {
  let ctx: TestContext;

  afterEach(async () => {
    await ctx?.cleanup();
  });

  it("should not stuff a name into the email field when caller misheard the question", async () => {
    ctx = await createTestAgent({ phoneLookup: null });

    // Caller gave a name instead of an email when asked for email.
    // Agent should re-ask or leave email blank, not stuff the name into email.
    const history: TranscriptTurn[] = [
      {
        turn: 1,
        callerText: null,
        agentText: "thank you for calling Abita Eye Group, this is David, how can I help you?",
        toolCalls: [],
      },
      {
        turn: 2,
        callerText: "Schedule appointment. I'm new.",
        agentText: "ok let me get you set up. What insurance do you have?",
        toolCalls: [],
      },
      {
        turn: 3,
        callerText: "UnitedHealthcare.",
        agentText: "yeah we take United Healthcare. What's your name?",
        toolCalls: [
          {
            name: "check_insurance",
            args: '{"plan": "UnitedHealthcare"}',
            result: '"accepted"',
            isError: false,
          },
        ],
      },
      {
        turn: 4,
        callerText: "Christopher Hamelman.",
        agentText: "and date of birth?",
        toolCalls: [],
      },
      {
        turn: 5,
        callerText: "January 22nd, 2020.",
        agentText: "is the number you're calling from a good one on file?",
        toolCalls: [],
      },
      {
        turn: 6,
        callerText: "Yes.",
        agentText: "perfect. What's your email address?",
        toolCalls: [],
      },
    ];

    await loadTranscriptHistory(ctx.agent, history, 99);

    // Caller says a NAME instead of an email (the bug scenario)
    const result = await ctx.session.run({ userInput: "Spencer Hamelman." }).wait();

    // Agent should NOT have called add_patient with "Spencer Hamelman" as email.
    // It should either re-ask for email, or not call add_patient at all yet
    // (we're still missing other fields anyway).
    const addPatientCalls = ctx.callLog.filter((c) => c.name === "add_patient");
    for (const call of addPatientCalls) {
      const email = (call.args as any).email;
      // Email must not literally be the subscriber name
      expect(email).not.toBe("Spencer Hamelman");
      // If an email was passed, it must look like an email (contain @) or be empty
      if (email && email !== "") {
        expect(email).toMatch(/@/);
      }
    }
  });
});

// ============================================================
// Test 5: Provider change flagged during reschedule (SCL_vfkVH9RpYL4V)
// Issue: Agent booked with Dr. Licht instead of Dr. Bach without
// mentioning the provider change. Caller had to catch the mistake.
// ============================================================
describe("provider change flagged during reschedule", () => {
  let ctx: TestContext;

  afterEach(async () => {
    await ctx?.cleanup();
  });

  it("should mention the different provider when rescheduling to a different doctor", async () => {
    // Setup: verified patient with existing appointment with Dr. Bach
    // get_availability returns a slot with Dr. Licht (different provider)
    ctx = await createTestAgent({
      phoneLookup: {
        status: "verified",
        patientId: "17607975",
        name: "VARGAS,HUGO",
        dob: "08/25/1961",
        phone: "(786) 314-1889",
        insuranceCarrier: "OSCAR INSURANCE COMPANY OF FLORIDA",
        insPlanId: "ins123",
        respPartyId: "resp123",
        routing: "general",
        allowedProviders: ["Dr. Bach", "Dr. Noel", "Dr. Licht"],
        routingAmbiguous: false,
        appointments: [
          {
            id: 20711703,
            date: "Thursday, April 23, 2026",
            time: "10:30 AM",
            provider: "Dr. Bach",
            type: "Follow-up",
            facility: "Spring Hill",
            confirmed: true,
          },
        ],
      },
      mockConfig: {
        availabilityResult: {
          searchedDate: "2026-04-23",
          date: "Thursday, April 23, 2026",
          location: "ABITA EYE GROUP SPRING HILL",
          providers: [
            {
              name: "Dr. J. Licht",
              columnId: 1600,
              profileId: 622,
              facility: "ABITA EYE GROUP SPRING HILL",
              slots: [
                { startDatetime: "2026-04-23T12:15", duration: 30, appointmentTypeId: 1007 },
              ],
            },
          ],
        },
      },
    });

    // Conversation: caller confirmed identity, wants to reschedule to a different time
    const history: TranscriptTurn[] = [
      {
        turn: 1,
        callerText: null,
        agentText: "thank you for calling Abita Eye Group, this is David, how can I help you?",
        toolCalls: [],
      },
      {
        turn: 2,
        callerText: "Hi, I need to reschedule Hugo's appointment on Thursday the twenty-third. The ten thirty doesn't work anymore.",
        agentText: "hey Hugo, I see your appointment on Thursday April twenty-third at ten thirty a m with Dr. Bach. What time would work better?",
        toolCalls: [],
      },
    ];

    await loadTranscriptHistory(ctx.agent, history, 99);

    // Caller asks for a different time — agent will check availability and find only Dr. Licht
    const result = await ctx.session.run({ userInput: "Anything in the afternoon that day?" }).wait();

    // The agent should mention Dr. Licht by name since it's a different provider than Dr. Bach
    // Content is an array of strings in the event structure
    const allText = result.events
      .filter((e) => e.type === "message" && (e as any).item?.role === "assistant")
      .map((e: any) => {
        const content = e.item?.content;
        if (typeof content === "string") return content;
        if (Array.isArray(content)) return content.join(" ");
        return "";
      })
      .join(" ")
      .toLowerCase();

    // At least one assistant message should mention "Licht" (the different provider)
    expect(allText).toContain("licht");
  });
});
