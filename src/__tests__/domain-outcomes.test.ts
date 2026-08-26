import { describe, expect, it } from "vitest";
import {
  domainOutcomeReceipts,
  domainOutcomesForTool,
} from "../state/observability.js";
import { createTestCallState } from "./support/call-state.js";

describe("domain outcomes", () => {
  it("keeps bound LiveKit tool identity authoritative", () => {
    const state = createTestCallState();
    const outcomes = domainOutcomesForTool(
      state,
      "bound-call",
      "create_staff_task",
    );
    const outcome = {
      callId: "wrong-call",
      toolName: "wrong-tool",
      outcome: "staff_task_created" as const,
      status: "success" as const,
    };

    expect(outcomes.reply(outcome, "done")).toBe("done");
    expect(domainOutcomeReceipts(state)).toMatchObject([
      {
        callId: "bound-call",
        toolName: "create_staff_task",
        outcome: "staff_task_created",
        status: "success",
      },
    ]);
  });
});
