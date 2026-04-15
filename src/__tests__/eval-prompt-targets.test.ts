import { describe, expect, it } from "vitest";
import {
  derivePromptTargets,
  summarizeCodeBacklog,
  summarizePromptTargets,
  type PromptTargetSignal,
} from "../../evals/lib/prompt-targets.js";

describe("prompt target derivation", () => {
  it("maps confirm and scheduling issues to concrete runbook targets", () => {
    const signals: PromptTargetSignal[] = [
      {
        source: "eval",
        suiteOrBucket: "confirm",
        issue: "confirm_appt grounding or context contract is unclear",
        count: 2,
      },
      {
        source: "eval",
        suiteOrBucket: "scheduling",
        issue:
          "tool argument requirements need stricter validation or examples",
        count: 1,
      },
    ];

    const { targets, backlog } = derivePromptTargets(signals);

    expect(backlog).toHaveLength(0);
    expect(targets.map((target) => target.suiteOrBucket)).toEqual([
      "confirm",
      "scheduling",
    ]);
    expect(targets[0]?.targetFile).toBe("RUNBOOK.md");
    expect(targets[0]?.targetSections).toContain("Path 1: Existing Patient");
    expect(targets[1]?.guidance).toContain("reason for visit");
  });

  it("sends unknown schema problems to the code-first backlog", () => {
    const signals: PromptTargetSignal[] = [
      {
        source: "audit",
        suiteOrBucket: "faq",
        issue: "schema mismatch in downstream helper",
        count: 1,
      },
    ];

    const { targets, backlog } = derivePromptTargets(signals);

    expect(targets).toHaveLength(0);
    expect(backlog).toHaveLength(1);
    expect(backlog[0]?.suggestedOwner).toContain("src/tools.ts");
  });

  it("renders summaries with ranked targets and code backlog", () => {
    const signals: PromptTargetSignal[] = [
      {
        source: "eval",
        suiteOrBucket: "routing",
        issue:
          "routing tool semantics between transfer_call and route_to_spring_hill are too ambiguous",
        count: 3,
      },
      {
        source: "audit",
        suiteOrBucket: "new_patient",
        issue: "wrapper-side validation missing",
        count: 1,
      },
    ];

    const { targets, backlog } = derivePromptTargets(signals);

    expect(summarizePromptTargets(targets)).toContain("routing tool semantics");
    expect(summarizePromptTargets(targets)).toContain("route_to_spring_hill");
    expect(summarizeCodeBacklog(backlog)).toContain("wrapper-side validation");
  });
});
