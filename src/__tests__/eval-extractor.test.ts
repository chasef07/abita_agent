import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractDecisionPointCases } from "../../evals/lib/extract-decision-points.js";
import type { NormalizedCallEvent } from "../../evals/lib/types.js";

const FIXTURE_PATH = join(import.meta.dirname, "..", "..", "evals", "fixtures", "sample-call-events.json");

function loadFixture(): NormalizedCallEvent[] {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf-8")) as NormalizedCallEvent[];
}

describe("decision-point extractor", () => {
  it("extracts a Spring Hill routing case from normalized call events", () => {
    const [routingRecord] = loadFixture();
    const testCases = extractDecisionPointCases(routingRecord);

    expect(testCases).toHaveLength(1);
    expect(testCases[0].suite).toBe("routing");
    expect(testCases[0].expectations.mustCallTools).toContain("route_to_spring_hill");
    expect(testCases[0].expectations.mustNotCallTools).toContain("transfer_call");
  });

  it("extracts a multiple-match verification case from normalized call events", () => {
    const [, multipleMatchRecord] = loadFixture();
    const testCases = extractDecisionPointCases(multipleMatchRecord);

    expect(testCases).toHaveLength(1);
    expect(testCases[0].suite).toBe("verification");
    expect(testCases[0].expectations.mustSay).toContain("first name");
    expect(testCases[0].expectations.mustNotSay).toContain("date of birth");
    expect(testCases[0].expectations.mustNotCallTools).toContain("confirm_appt");
  });

  it("extracts a transfer case from normalized call events", () => {
    const [, , transferRecord] = loadFixture();
    const testCases = extractDecisionPointCases(transferRecord);

    expect(testCases).toHaveLength(1);
    expect(testCases[0].suite).toBe("transfer");
    expect(testCases[0].expectations.mustCallTools).toContain("transfer_call");
    expect(testCases[0].tags).toContain("human-request");
    expect(testCases[0].expectations.policyFlags).toContain("no_second_pushback");
  });

  it("extracts a confirm case when confirm_appt is called", () => {
    const confirmRecord: NormalizedCallEvent = {
      callId: "SCL_CONFIRM",
      officePhone: "+17275919997",
      totalTurns: 3,
      durationSec: 42,
      data: {
        turns: [
          {
            turn: 1,
            callerText: "I need to confirm my appointment.",
            agentText: "Sure, can I get your first name?",
            toolCalls: [],
          },
          {
            turn: 2,
            callerText: "Jane",
            agentText: "Thanks, let me pull that up.",
            toolCalls: [{ name: "confirm_appt", args: {}, isError: false }],
          },
        ],
      },
    };

    const testCases = extractDecisionPointCases(confirmRecord);

    expect(testCases).toHaveLength(1);
    expect(testCases[0].suite).toBe("confirm");
    expect(testCases[0].expectations.mustCallTools).toContain("confirm_appt");
    expect(testCases[0].tags).toContain("confirm");
  });
});
