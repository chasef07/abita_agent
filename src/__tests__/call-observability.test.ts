import { describe, expect, it } from "vitest";
import {
  buildLlmSummary,
  classifyToolOutput,
  createEmptySessionEventAnalytics,
  snapshotCloseEvent,
  snapshotErrorEvent,
  snapshotFalseInterruptionEvent,
  snapshotOverlappingSpeechEvent,
  snapshotToolExecutions,
} from "../call-observability.js";

describe("call observability", () => {
  it("sanitizes FunctionToolsExecuted into dashboard-safe tool executions", () => {
    const executions = snapshotToolExecutions({
      createdAt: Date.parse("2026-05-20T10:00:00.000Z"),
      functionCalls: [
        {
          args: JSON.stringify({
            dob: "1990-01-01",
            patientName: "Jane Patient",
          }),
          callId: "call_1",
          name: "book_appt",
        },
      ],
      functionCallOutputs: [
        {
          callId: "call_1",
          isError: false,
          output: JSON.stringify({
            appointmentId: "appt_123",
            status: "booked",
          }),
        },
      ],
    });

    expect(executions).toEqual([
      {
        callId: "call_1",
        createdAt: "2026-05-20T10:00:00.000Z",
        outputClass: "appointment_booked",
        status: "success",
        toolName: "book_appt",
      },
    ]);
    expect(JSON.stringify(executions)).not.toContain("Jane Patient");
    expect(JSON.stringify(executions)).not.toContain("1990-01-01");
  });

  it("classifies common tool outcomes without raw tool payloads", () => {
    expect(classifyToolOutput("transfer_call", "ok", false)).toBe(
      "transfer_started",
    );
    expect(
      classifyToolOutput(
        "transfer_call",
        "Could not transfer the call. Please try again.",
        false,
      ),
    ).toBe("transfer_failed");
    expect(
      classifyToolOutput(
        "transfer_call",
        "Already transferred. No action needed.",
        false,
      ),
    ).toBe("duplicate_tool_call");
    expect(
      classifyToolOutput(
        "transfer_call",
        JSON.stringify({
          outcome: "success",
          facts: { reason: "transfer_already_started" },
          speak: "Transfer already started. No action needed.",
        }),
        false,
      ),
    ).toBe("duplicate_tool_call");
    expect(
      classifyToolOutput(
        "verify_patient",
        JSON.stringify({ status: "multiple_matches" }),
        false,
      ),
    ).toBe("multiple_patient_matches");
    expect(
      classifyToolOutput(
        "book_appt",
        JSON.stringify({ status: "error" }),
        false,
      ),
    ).toBe("tool_error");
    expect(
      classifyToolOutput(
        "book_appt",
        JSON.stringify({
          outcome: "success",
          facts: { appointmentId: 9960766 },
        }),
        false,
      ),
    ).toBe("appointment_booked");
    expect(
      classifyToolOutput("book_appt", JSON.stringify({ status: "ok" }), false),
    ).toBe("appointment_booked");
    expect(
      classifyToolOutput(
        "cancel_appt",
        JSON.stringify({
          outcome: "not_found",
          facts: { reason: "appointment_not_found" },
        }),
        false,
      ),
    ).toBe("appointment_not_cancelled");
    expect(
      classifyToolOutput(
        "cancel_appt",
        JSON.stringify({
          outcome: "not_allowed",
          facts: { reason: "cancel_requires_verified_or_created_patient" },
        }),
        false,
      ),
    ).toBe("appointment_not_cancelled");
    expect(
      classifyToolOutput(
        "cancel_appt",
        JSON.stringify({
          outcome: "success",
          facts: { appointmentId: 12345 },
        }),
        false,
      ),
    ).toBe("appointment_cancelled");
    expect(
      classifyToolOutput(
        "confirm_appt",
        JSON.stringify({ status: "found", appointments: [{ id: 12345 }] }),
        false,
      ),
    ).toBe("appointments_found");
    expect(
      classifyToolOutput(
        "confirm_appt",
        JSON.stringify({ status: "no_appointments" }),
        false,
      ),
    ).toBe("appointments_not_found");
    expect(
      classifyToolOutput(
        "confirm_appt",
        JSON.stringify({ status: "verified", appointmentsStatus: "found" }),
        false,
      ),
    ).toBe("appointments_found");
    expect(
      classifyToolOutput(
        "confirm_appt",
        JSON.stringify({ status: "verified", appointmentsStatus: "none" }),
        false,
      ),
    ).toBe("appointments_not_found");
    expect(classifyToolOutput("book_appt", "timeout", true)).toBe(
      "middleware_error",
    );
  });

  it("marks returned tool failures as failed executions", () => {
    expect(
      snapshotToolExecutions({
        functionCalls: [{ callId: "call_1", name: "book_appt" }],
        functionCallOutputs: [
          {
            callId: "call_1",
            isError: false,
            output: JSON.stringify({
              message: "slot unavailable",
              status: "error",
            }),
          },
        ],
      })[0],
    ).toMatchObject({
      outputClass: "tool_error",
      status: "error",
    });

    expect(
      snapshotToolExecutions({
        functionCalls: [{ callId: "call_2", name: "transfer_call" }],
        functionCallOutputs: [
          {
            callId: "call_2",
            isError: false,
            output: "Could not transfer the call. Please try again.",
          },
        ],
      })[0],
    ).toMatchObject({
      outputClass: "transfer_failed",
      status: "error",
    });

    expect(
      snapshotToolExecutions({
        functionCalls: [{ callId: "call_3", name: "cancel_appt" }],
        functionCallOutputs: [
          {
            callId: "call_3",
            isError: false,
            output: JSON.stringify({
              outcome: "not_found",
              facts: { reason: "appointment_not_found" },
            }),
          },
        ],
      })[0],
    ).toMatchObject({
      outputClass: "appointment_not_cancelled",
      status: "error",
    });
  });

  it("builds session event analytics without raw error messages", () => {
    const events = createEmptySessionEventAnalytics();
    events.errors.push(
      snapshotErrorEvent({
        createdAt: Date.parse("2026-05-20T10:01:00.000Z"),
        error: Object.assign(new Error("full provider payload"), {
          code: "ETIMEDOUT",
        }),
        source: { name: "stt" },
      }),
    );
    events.close = snapshotCloseEvent({
      createdAt: Date.parse("2026-05-20T10:02:00.000Z"),
      reason: "participant_disconnected",
    });
    events.falseInterruptions.push(
      snapshotFalseInterruptionEvent({
        createdAt: Date.parse("2026-05-20T10:03:00.000Z"),
        resumed: true,
      }),
    );
    events.overlappingSpeech.push(
      snapshotOverlappingSpeechEvent({
        detectedAt: Date.parse("2026-05-20T10:04:00.000Z"),
        isInterruption: true,
        totalDurationInS: 1.25,
      }),
    );

    expect(events.errors[0]).toMatchObject({
      code: "ETIMEDOUT",
      messageClass: "code:ETIMEDOUT",
      name: "Error",
    });
    expect(JSON.stringify(events)).not.toContain("full provider payload");
    expect(events.close.reason).toBe("participant_disconnected");
    expect(events.falseInterruptions[0].resumed).toBe(true);
    expect(events.overlappingSpeech[0].durationMs).toBe(1250);
  });

  it("summarizes LLM fallback and cache metrics", () => {
    const summary = buildLlmSummary({
      fallbackModel: "MiniMaxAI/MiniMax-M2.5",
      llmMetrics: [
        {
          completionTokens: 20,
          metadata: { modelName: "zai-org/GLM-5" },
          promptCachedTokens: 40,
          promptTokens: 100,
          ttftMs: 450,
          type: "llm_metrics",
        },
        {
          completionTokens: 10,
          metadata: { modelName: "MiniMaxAI/MiniMax-M2.5" },
          promptCachedTokens: 80,
          promptTokens: 200,
          ttftMs: 550,
          type: "llm_metrics",
        },
      ],
    });

    expect(summary).toMatchObject({
      avgTtftMs: 500,
      cachedPromptTokens: 120,
      completionTokens: 30,
      fallbackUsed: true,
      modelsUsed: ["zai-org/GLM-5", "MiniMaxAI/MiniMax-M2.5"],
      peakPromptTokens: 200,
      promptTokens: 300,
    });
    expect(summary.cacheHitRate).toBeCloseTo(0.4);
  });

  it("does not count FallbackAdapter wrapper labels as real fallback", () => {
    const summary = buildLlmSummary({
      fallbackModel: "MiniMaxAI/MiniMax-M2.5",
      llmMetrics: [
        {
          completionTokens: 20,
          metadata: {
            modelName: "zai-org/GLM-5",
            modelProvider: "unknown",
          },
          promptCachedTokens: 40,
          promptTokens: 100,
          ttftMs: 450,
          type: "llm_metrics",
        },
        {
          completionTokens: 20,
          metadata: {
            modelName: "FallbackAdapter",
            modelProvider: "unknown",
          },
          promptCachedTokens: 40,
          promptTokens: 100,
          ttftMs: 450,
          type: "llm_metrics",
        },
      ],
      usage: {
        modelUsage: [
          {
            inputCachedTokens: 40,
            inputTokens: 100,
            model: "unknown/zai-org/GLM-5",
            outputTokens: 20,
            type: "llm_usage",
          },
          {
            inputCachedTokens: 40,
            inputTokens: 100,
            model: "FallbackAdapter",
            outputTokens: 20,
            type: "llm_usage",
          },
        ],
      },
    });

    expect(summary).toMatchObject({
      fallbackUsed: false,
      modelsUsed: ["zai-org/GLM-5"],
    });
  });
});
