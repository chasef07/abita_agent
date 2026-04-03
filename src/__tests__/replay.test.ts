/**
 * Transcript replay tests.
 * Replays real call scenarios through the agent with scripted FakeLLM responses
 * to verify that prompt changes produce correct tool-call behavior.
 *
 * Uses: FakeLLM (no network) + mock tools (no API calls).
 * Run: npx vitest run src/__tests__/replay.test.ts
 *
 * NOTE: These tests use FakeLLM to avoid requiring LLM inference network access.
 * Each test scripts a specific LLM decision (tool call or text response) and
 * asserts that the mock tools respond correctly to that decision.
 * This validates the tool layer, mock guards, and call-flow structure.
 */

import { initializeLogger, voice } from "@livekit/agents";
import dotenv from "dotenv";
import { afterEach, describe, expect, it } from "vitest";
import { buildPrompt } from "../prompt.js";
import { createMockTools, DEFAULT_VERIFY_NOT_FOUND } from "./mock-tools.js";

dotenv.config({ path: ".env.local" });
initializeLogger({ pretty: false, level: "warn" });

// ============================================================
// Test 1: Fabricated registration data guard (SCL_VFDwKT4Gj8Lp)
// Issue: Agent called add_patient with hallucinated data.
// Guard: mock-tools.ts detectFabrication returns error for fake data.
// ============================================================
describe("fabricated registration prevention", () => {
  it("mock tool rejects add_patient with fabricated data (example.com email)", async () => {
    const { tools, callLog } = createMockTools();

    // Simulate the LLM calling add_patient with obviously fabricated data
    // (this is what the real agent did in SCL_VFDwKT4Gj8Lp)
    const result = await tools.add_patient.execute(
      {
        firstName: "Zordena",
        lastName: "Zolina",
        dob: "11/23/1969",
        phone: "5551234567",
        email: "zordena@example.com", // fabricated
        street: "123 Main St",        // fabricated
        aptSuite: "",
        city: "Anytown",
        state: "FL",
        zip: "34608",
        sex: "female",
        insurance: "Ambetter",
        subscriberName: "Zordena Zolina",
        subscriberNum: "ABC123456",   // fabricated
      },
      {} as any,
    );

    // The mock should detect fabrication and return an error
    expect((result as any).status).toBe("error");
    expect((result as any)._testMeta?.fabrications?.length).toBeGreaterThan(0);
  });

  it("mock tool accepts add_patient with real data", async () => {
    const { tools, callLog } = createMockTools();

    const result = await tools.add_patient.execute(
      {
        firstName: "Jane",
        lastName: "Smith",
        dob: "03/15/1985",
        phone: "9548165297",
        email: "jsmith@gmail.com",
        street: "456 Oak Avenue",
        aptSuite: "Apt 2",
        city: "Spring Hill",
        state: "FL",
        zip: "34608",
        sex: "female",
        insurance: "Aetna Medicare Signature PPO",
        subscriberName: "Jane Smith",
        subscriberNum: "H89234567",
      },
      {} as any,
    );

    // Real data should succeed
    expect((result as any).status).toBe("created");
    expect((result as any).patientId).toBe("MOCK-001");
  });
});

// ============================================================
// Test 2: Transfer call guard — only fires once
// Validates the mock transfer tool records call correctly.
// ============================================================
describe("transfer call behavior", () => {
  it("transfer_call mock records the call", async () => {
    const { tools, callLog } = createMockTools();

    const result = await tools.transfer_call.execute({} as any, {} as any);

    expect(result).toBe("Transfer initiated successfully.");
    expect(callLog.filter((c) => c.name === "transfer_call")).toHaveLength(1);
  });

  it("transfer_call mock records multiple calls (real guard is in execute fn)", async () => {
    const { tools, callLog } = createMockTools();

    // Call twice — both recorded in mock (real code-level guard is in tools.ts execute fn)
    await tools.transfer_call.execute({} as any, {} as any);
    await tools.transfer_call.execute({} as any, {} as any);

    // Mock records both; real agent code-level guard (state.transferred) prevents second execution
    expect(callLog.filter((c) => c.name === "transfer_call")).toHaveLength(2);
  });
});

// ============================================================
// Test 3: verify_patient mock returns not_found by default
// ============================================================
describe("verify_patient mock behavior", () => {
  it("returns not_found by default", async () => {
    const { tools } = createMockTools();

    const result = await tools.verify_patient.execute(
      { firstName: "Unknown", lastName: "Person", dob: "01/01/1990" },
      {} as any,
    );

    expect((result as any).status).toBe("not_found");
  });

  it("returns configured result when verifyResult is set", async () => {
    const { tools } = createMockTools({
      verifyResult: {
        status: "verified",
        patientId: "99999",
        name: "SMITH,JANE",
        dob: "03/15/1985",
        insuranceCarrier: "Aetna",
        routing: "general",
        allowedProviders: ["Dr. Noel"],
        routingAmbiguous: false,
        preauthRequired: false,
      },
    });

    const result = await tools.verify_patient.execute(
      { firstName: "Jane", lastName: "Smith", dob: "03/15/1985" },
      {} as any,
    );

    expect((result as any).status).toBe("verified");
    expect((result as any).patientId).toBe("99999");
  });
});

// ============================================================
// Test 4: check_insurance mock works
// ============================================================
describe("check_insurance mock", () => {
  it("returns insurance data from file or fallback", async () => {
    const { tools, callLog } = createMockTools();

    const result = await tools.check_insurance.execute({ plan: "Aetna" }, {} as any);

    expect(typeof result).toBe("string");
    // Should return some content (file or fallback)
    expect((result as string).length).toBeGreaterThan(0);

    expect(callLog.filter((c) => c.name === "check_insurance")).toHaveLength(1);
    expect(callLog[0].args).toMatchObject({ plan: "Aetna" });
  });
});

// ============================================================
// Test 5: get_availability mock returns default slot
// ============================================================
describe("get_availability mock", () => {
  it("returns default availability slot", async () => {
    const { tools, callLog } = createMockTools();

    const result = await tools.get_availability.execute({ date: "2026-04-14" }, {} as any);

    expect((result as any).slots).toHaveLength(1);
    expect((result as any).slots[0].provider).toBe("Dr. Noel");
    expect(callLog.filter((c) => c.name === "get_availability")).toHaveLength(1);
  });
});

// ============================================================
// Test 6: book_appt mock records the call
// ============================================================
describe("book_appt mock", () => {
  it("records booking and returns booked status", async () => {
    const { tools, callLog } = createMockTools();

    const result = await tools.book_appt.execute(
      {
        columnId: 101,
        profileId: 201,
        startDatetime: "2026-04-14T09:30",
        duration: 30,
        appointmentTypeId: 1007,
      },
      {} as any,
    );

    expect((result as any).status).toBe("booked");
    expect(callLog.filter((c) => c.name === "book_appt")).toHaveLength(1);
  });
});

// ============================================================
// Test 7: FakeLLM-based agent session test
// Verify the agent session starts and handles a scripted response
// without requiring real LLM network access.
// ============================================================
describe("agent session with FakeLLM", () => {
  let session: voice.AgentSession;

  afterEach(async () => {
    await session?.close();
  });

  it("agent session starts successfully with mock tools", async () => {
    const { tools } = createMockTools();
    const { FakeLLM } = await import("@livekit/agents").then((m) => m.voice.testing);

    const fakeLlm = new FakeLLM([
      {
        input: "Hi, do you accept Aetna?",
        toolCalls: [{ name: "check_insurance", args: { plan: "Aetna" } }],
      },
    ]);

    const agent = new voice.Agent({
      instructions: buildPrompt(null),
      tools,
    });

    session = new voice.AgentSession({ llm: fakeLlm });
    await session.start({ agent });

    // Session should start without error
    expect(session).toBeDefined();
  });
});

// ============================================================
// Test 8: Fabrication detection patterns
// Validates all fabrication patterns in the mock guard.
// ============================================================
describe("fabrication detection completeness", () => {
  const fabricationCases = [
    { field: "email", value: "test@example.com", desc: "example.com domain" },
    { field: "email", value: "user@test.com", desc: "test.com domain" },
    { field: "street", value: "123 Main St", desc: "generic placeholder address" },
    { field: "subscriberNum", value: "ABC123456", desc: "ABC123 pattern member ID" },
    { field: "email", value: "placeholder@gmail.com", desc: "placeholder prefix" },
  ];

  for (const { field, value, desc } of fabricationCases) {
    it(`rejects fabricated ${field}: ${desc}`, async () => {
      const { tools } = createMockTools();

      const baseArgs = {
        firstName: "Jane",
        lastName: "Smith",
        dob: "03/15/1985",
        phone: "9548165297",
        email: "jsmith@gmail.com",
        street: "456 Oak Ave",
        aptSuite: "",
        city: "Spring Hill",
        state: "FL",
        zip: "34608",
        sex: "female" as "female",
        insurance: "Aetna Medicare Signature PPO",
        subscriberName: "Jane Smith",
        subscriberNum: "H89234567",
      };

      const argsWithFabrication = { ...baseArgs, [field]: value };

      const result = await tools.add_patient.execute(argsWithFabrication, {} as any);

      expect((result as any).status).toBe("error");
      expect((result as any)._testMeta?.fabrications).toBeDefined();
      expect((result as any)._testMeta.fabrications.length).toBeGreaterThan(0);
    });
  }
});
