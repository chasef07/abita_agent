import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeCallEvents } from "../../evals/lib/normalize-call-events.js";
import type { NormalizedCallEvent } from "../../evals/lib/types.js";

const FIXTURE_PATH = join(
  import.meta.dirname,
  "..",
  "..",
  "evals",
  "fixtures",
  "sample-call-events.json",
);

describe("normalize call events", () => {
  it("accepts already-normalized call event arrays", () => {
    const fixture = JSON.parse(
      readFileSync(FIXTURE_PATH, "utf-8"),
    ) as NormalizedCallEvent[];
    const records = normalizeCallEvents(fixture);

    expect(records).toHaveLength(3);
    expect(records[0].callId).toBe("call-routing-001");
    expect(records[1].callId).toBe("call-multiple-match-001");
    expect(records[2].callId).toBe("call-transfer-001");
  });

  it("parses exported call event rows with stringified data", () => {
    const exported = [
      {
        callId: "call-export-001",
        officePhone: "+17275919997",
        totalTurns: "2",
        durationSec: "30",
        startedAt: "2026-04-13T12:00:00.000Z",
        data: JSON.stringify({
          turns: [
            {
              turn: 1,
              callerText: "I want a real person.",
              agentText: "let me transfer you over to the office.",
              toolCalls: [{ name: "transfer_call", args: {} }],
            },
          ],
        }),
      },
    ];

    const records = normalizeCallEvents(exported);

    expect(records).toHaveLength(1);
    expect(records[0].totalTurns).toBe(2);
    expect(records[0].durationSec).toBe(30);
    expect(records[0].data.turns[0].toolCalls[0].name).toBe("transfer_call");
  });
});
