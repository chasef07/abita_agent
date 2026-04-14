import { describe, expect, it } from "vitest";
import {
  countRepeatedAssistantQuestions,
  inferIntentBucket,
  summarizeAuditReport,
  summarizeDeterministicToolCorrectness,
} from "../../evals/lib/audit.js";
import type { CallAuditRecord, NormalizedCallEvent } from "../../evals/lib/types.js";

function makeCall(overrides: Partial<NormalizedCallEvent>): NormalizedCallEvent {
  return {
    callId: "SCL_TEST",
    officePhone: "+17275919997",
    totalTurns: 4,
    durationSec: 90,
    data: {
      turns: [],
    },
    ...overrides,
  };
}

describe("audit helpers", () => {
  it("infers a new-patient bucket from add_patient usage", () => {
    const call = makeCall({
      data: {
        turns: [
          {
            turn: 1,
            callerText: "I need a new patient appointment",
            agentText: "I can help with that.",
            toolCalls: [],
          },
          {
            turn: 2,
            callerText: null,
            agentText: "Thanks, I have your details.",
            toolCalls: [{ name: "add_patient", args: { firstName: "Jane" } }],
          },
        ],
      },
    });

    expect(inferIntentBucket(call)).toBe("new_patient");
  });

  it("flags missing args and bad sequencing deterministically", () => {
    const call = makeCall({
      data: {
        turns: [
          {
            turn: 1,
            callerText: "Book me tomorrow",
            agentText: "Sure",
            toolCalls: [
              { name: "book_appt", args: { columnId: 12, profileId: 99 }, isError: false },
            ],
          },
        ],
      },
    });

    const result = summarizeDeterministicToolCorrectness(call, "existing_patient_booking");
    expect(result.pass).toBe(false);
    expect(result.missingRequiredArgs.join(" ")).toContain("startDatetime");
    expect(result.sequenceIssues.join(" ")).toContain("before get_availability");
  });

  it("counts repeated assistant questions", () => {
    const call = makeCall({
      data: {
        turns: [
          { turn: 1, callerText: "Hi", agentText: "What's your first name?", toolCalls: [] },
          { turn: 2, callerText: "Jane", agentText: "What's your first name?", toolCalls: [] },
          { turn: 3, callerText: "Jane", agentText: "What insurance do you have?", toolCalls: [] },
        ],
      },
    });

    expect(countRepeatedAssistantQuestions(call)).toBe(1);
  });

  it("aggregates bucket and overall audit metrics", () => {
    const audits: CallAuditRecord[] = [
      {
        callId: "A",
        officePhone: "+17275919997",
        intentBucket: "faq",
        intentBucketGuess: "faq",
        overallStatus: "great",
        resolved: true,
        resolutionReason: "Answered the question cleanly.",
        failureModes: [],
        toolCorrectness: { pass: true, issues: [], malformedArgs: [], missingRequiredArgs: [], sequenceIssues: [] },
        pathEfficiency: { score: 1, issues: [], repeatedQuestionCount: 0, extraTurns: 0 },
        hallucinationSafety: { pass: true, issues: [] },
        strengths: ["grounded answer"],
        recommendedFixes: [],
        toolCalls: [],
        metrics: { toolCallCount: 1, toolErrorCount: 0, transferred: false, repeatedQuestionCount: 0, extraTurns: 0 },
        totalTurns: 3,
        durationSec: 45,
      },
      {
        callId: "B",
        officePhone: "+17275919997",
        intentBucket: "new_patient",
        intentBucketGuess: "new_patient",
        overallStatus: "failed",
        resolved: false,
        resolutionReason: "Registration stalled.",
        failureModes: ["slow_path"],
        toolCorrectness: {
          pass: false,
          issues: ["missing insurance"],
          malformedArgs: [],
          missingRequiredArgs: ["insurance"],
          sequenceIssues: [],
        },
        pathEfficiency: { score: 0.4, issues: ["repeated question"], repeatedQuestionCount: 1, extraTurns: 2 },
        hallucinationSafety: { pass: true, issues: [] },
        strengths: ["warm tone"],
        recommendedFixes: ["enforce registration order"],
        toolCalls: [],
        metrics: { toolCallCount: 2, toolErrorCount: 0, transferred: false, repeatedQuestionCount: 1, extraTurns: 2 },
        totalTurns: 12,
        durationSec: 180,
      },
    ];

    const report = summarizeAuditReport(audits, "2026-04-14", 24);
    expect(report.totalCalls).toBe(2);
    expect(report.overall.resolved).toBe(1);
    expect(report.byBucket.faq.total).toBe(1);
    expect(report.byBucket.new_patient.total).toBe(1);
    expect(report.failureModeCounts.slow_path).toBe(1);
    expect(report.strengthCounts["warm tone"]).toBe(1);
  });
});
