import { describe, expect, it } from "vitest";
import {
  buildLlmSummary,
  classifyToolOutput,
  createEmptySessionEventAnalytics,
  snapshotCloseEvent,
  snapshotErrorEvent,
  snapshotFalseInterruptionEvent,
  snapshotOverlappingSpeechEvent,
  snapshotSttProfileTransition,
  snapshotToolExecutions,
  withAppointmentActionToolExecutionFallback,
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
          name: "book_appointment",
        },
      ],
      functionCallOutputs: [
        {
          callId: "call_1",
          isError: false,
          output: JSON.stringify("Booked June 1 at 9:00 AM with Doctor Smith."),
        },
      ],
    });

    expect(executions).toEqual([
      {
        callId: "call_1",
        createdAt: "2026-05-20T10:00:00.000Z",
        outputClass: "appointment_booked",
        status: "success",
        toolName: "book_appointment",
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
        "Could not transfer the call.",
        false,
      ),
    ).toBe("transfer_failed");
    expect(
      classifyToolOutput("transfer_call", "Transfer already started.", false),
    ).toBe("duplicate_tool_call");
    expect(
      classifyToolOutput(
        "transfer_call",
        "The transfer may already be in progress. Do not try again.",
        false,
      ),
    ).toBe("transfer_ambiguous");
    expect(
      classifyToolOutput("create_staff_task", "Task sent to staff.", false),
    ).toBe("staff_task_created");
    expect(
      classifyToolOutput(
        "create_staff_task",
        "Task already sent to staff.",
        false,
      ),
    ).toBe("staff_task_duplicate");
    expect(
      classifyToolOutput(
        "create_staff_task",
        "Could not send the staff task.",
        false,
      ),
    ).toBe("staff_task_failed");
    expect(
      classifyToolOutput(
        "resolve_patient",
        "Multiple patient matches found.",
        false,
        "multiple_matches",
      ),
    ).toBe("multiple_patient_matches");
    expect(
      classifyToolOutput(
        "resolve_patient",
        "Verified existing patient Jane Doe. Patient record is loaded.",
        false,
        "verified",
      ),
    ).toBe("patient_verified");
    expect(
      classifyToolOutput(
        "resolve_patient",
        "Switched active patient to Jane Doe. Check availability again before booking.",
        false,
        "switched",
      ),
    ).toBe("patient_switched");
    expect(
      classifyToolOutput(
        "resolve_patient",
        "New-chart path confirmed. Continue registration.",
        false,
        "new",
      ),
    ).toBe("patient_new");
    expect(
      classifyToolOutput(
        "resolve_patient",
        "No matching patient was found.",
        false,
        "not_found",
      ),
    ).toBe("patient_not_found");
    expect(
      classifyToolOutput(
        "resolve_patient",
        "Patient lookup failed. Try again.",
        false,
        "lookup_failed",
      ),
    ).toBe("patient_lookup_failed");
    expect(
      classifyToolOutput(
        "resolve_patient",
        "Multiple patient matches found.",
        false,
        "multiple_matches",
      ),
    ).toBe("multiple_patient_matches");
    expect(
      classifyToolOutput(
        "resolve_patient",
        "No patient match found.",
        false,
        "not_found",
      ),
    ).toBe("patient_not_found");
    expect(
      classifyToolOutput(
        "resolve_patient",
        "Patient lookup returned an invalid response.",
        false,
        "lookup_failed",
      ),
    ).toBe("patient_lookup_failed");
    expect(
      classifyToolOutput(
        "book_appointment",
        "Booked June 1 at 9:00 AM with Doctor Smith.",
        false,
      ),
    ).toBe("appointment_booked");
    expect(
      classifyToolOutput(
        "book_appointment",
        "That time is no longer available. Check availability again before booking.",
        false,
      ),
    ).toBe("appointment_not_booked");
    expect(
      classifyToolOutput(
        "book_appointment",
        "Search availability again before booking because the selected slot expired.",
        false,
      ),
    ).toBe("appointment_needs_input");
    expect(
      classifyToolOutput(
        "cancel_appointment",
        "Load appointments and confirm the exact appointment before cancelling.",
        false,
      ),
    ).toBe("appointment_needs_input");
    expect(
      classifyToolOutput(
        "cancel_appointment",
        "The appointment was not cancelled.",
        false,
      ),
    ).toBe("appointment_not_cancelled");
    expect(
      classifyToolOutput(
        "cancel_appointment",
        "Cancelled the appointment on June 5 at 10:00 AM.",
        false,
      ),
    ).toBe("appointment_cancelled");
    expect(
      classifyToolOutput(
        "reschedule_appointment",
        "Rescheduled the appointment to June 1 at 9:00 AM. Cancelled the old appointment on May 1 at 8:00 AM.",
        false,
      ),
    ).toBe("appointment_rescheduled");
    expect(
      classifyToolOutput(
        "reschedule_appointment",
        "The appointment is already rescheduled to June 1 at 9:00 AM with Doctor Smith. Tell the caller the confirmed appointment details instead of rescheduling again.",
        false,
      ),
    ).toBe("appointment_rescheduled");
    expect(
      classifyToolOutput(
        "reschedule_appointment",
        "That time is no longer available. Check availability again before booking. I did not cancel the existing appointment.",
        false,
      ),
    ).toBe("appointment_not_rescheduled");
    expect(
      classifyToolOutput(
        "reschedule_appointment",
        "Booked the new appointment for June 1 at 9:00 AM, but I could not cancel the old appointment. I need to transfer you so the office can finish the cancellation.",
        false,
      ),
    ).toBe("appointment_reschedule_partial");
    expect(
      classifyToolOutput(
        "transfer_call",
        "I couldn't transfer because the call is no longer active.",
        false,
      ),
    ).toBe("transfer_failed");
    expect(
      classifyToolOutput(
        "get_availability",
        "Before checking availability for a new appointment, call get_availability again with visitType medical or routine_vision.",
        false,
      ),
    ).toBe("availability_needs_input");
    expect(
      classifyToolOutput(
        "get_availability",
        'Invalid arguments for get_availability: expected one of "hollywood"|"sweetwater" at office',
        true,
      ),
    ).toBe("invalid_tool_arguments");
    expect(
      classifyToolOutput(
        "get_availability",
        "I couldn't check availability. I can try once more or connect you with the office.",
        true,
      ),
    ).toBe("availability_failed");
    expect(
      classifyToolOutput(
        "book_appointment",
        "Unknown function: book_appointment - available tools: resolve_patient",
        true,
      ),
    ).toBe("unknown_tool");
    expect(
      classifyToolOutput(
        "create_staff_task",
        "An internal error occurred while executing the tool.",
        true,
      ),
    ).toBe("internal_tool_error");
    expect(classifyToolOutput("book_appointment", "timeout", true)).toBe(
      "middleware_error",
    );
  });

  it("marks returned tool failures as failed executions", () => {
    expect(
      snapshotToolExecutions({
        functionCalls: [{ callId: "call_1", name: "book_appointment" }],
        functionCallOutputs: [
          {
            callId: "call_1",
            isError: true,
            output: "slot unavailable",
          },
        ],
      })[0],
    ).toMatchObject({
      outputClass: "appointment_not_booked",
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
        functionCalls: [{ callId: "call_3", name: "get_availability" }],
        functionCallOutputs: [
          {
            callId: "call_3",
            isError: false,
            output:
              "Verify or create the patient before checking availability.",
          },
        ],
      })[0],
    ).toMatchObject({
      outputClass: "availability_needs_input",
      status: "success",
    });

    expect(
      snapshotToolExecutions({
        functionCalls: [{ callId: "call_4", name: "cancel_appointment" }],
        functionCallOutputs: [
          {
            callId: "call_4",
            isError: false,
            output: JSON.stringify("The appointment was not cancelled."),
          },
        ],
      })[0],
    ).toMatchObject({
      outputClass: "appointment_not_cancelled",
      status: "error",
    });
    expect(
      classifyToolOutput(
        "book_appointment",
        JSON.stringify({ status: "booked" }),
        false,
      ),
    ).toBe("appointment_not_booked");

    expect(
      snapshotToolExecutions({
        functionCalls: [{ callId: "call_5", name: "book_appointment" }],
        functionCallOutputs: [
          {
            callId: "call_5",
            isError: false,
            output:
              "That time is no longer available. Check availability again before booking.",
          },
        ],
      })[0],
    ).toMatchObject({
      outputClass: "appointment_not_booked",
      status: "error",
    });
  });

  it("marks identity lookup failures as failed executions", () => {
    expect(
      snapshotToolExecutions(
        {
          functionCalls: [{ callId: "call_1", name: "resolve_patient" }],
          functionCallOutputs: [
            {
              callId: "call_1",
              isError: false,
              output: "Patient lookup failed. Try again.",
            },
          ],
        },
        () => "lookup_failed",
      )[0],
    ).toMatchObject({
      outputClass: "patient_lookup_failed",
      status: "error",
    });
  });

  it("does not consume an identity outcome for invalid tool arguments", () => {
    const outcomes = ["verified" as const];
    const executions = snapshotToolExecutions(
      {
        functionCalls: [
          { callId: "call_1", name: "resolve_patient" },
          { callId: "call_2", name: "resolve_patient" },
        ],
        functionCallOutputs: [
          {
            callId: "call_1",
            isError: true,
            output: "Invalid tool arguments.",
          },
          {
            callId: "call_2",
            isError: false,
            output: "Verified existing patient. Patient record is loaded.",
          },
        ],
      },
      () => outcomes.shift(),
    );

    expect(executions).toMatchObject([
      { outputClass: "invalid_tool_arguments", status: "error" },
      { outputClass: "patient_verified", status: "success" },
    ]);
  });

  it("consumes a failed identity outcome for an executed lookup", () => {
    const outcomes = ["lookup_failed" as const];
    const executions = snapshotToolExecutions(
      {
        functionCalls: [{ callId: "call_1", name: "resolve_patient" }],
        functionCallOutputs: [
          {
            callId: "call_1",
            isError: true,
            output: "Patient lookup failed. Try again.",
          },
        ],
      },
      () => outcomes.shift(),
    );

    expect(executions).toMatchObject([
      { outputClass: "patient_lookup_failed", status: "error" },
    ]);
    expect(outcomes).toEqual([]);
  });

  it.each([true, false])(
    "classifies rejected duplicate identity tools without consuming outcomes (duplicate first: %s)",
    (duplicateFirst) => {
      const duplicate = {
        callId: "duplicate",
        name: "resolve_patient",
        output: JSON.stringify(
          "Same tool `resolve_patient` is already running:\n- call_1\nIf you want to cancel the existing one, call `lk_agents_cancel_task` with call_id.",
        ),
      };
      const success = {
        callId: "success",
        name: "resolve_patient",
        output: "Verified existing patient. Patient record is loaded.",
      };
      const ordered = duplicateFirst
        ? [duplicate, success]
        : [success, duplicate];
      const outcomes = ["verified" as const];
      const executions = snapshotToolExecutions(
        {
          functionCalls: ordered.map(({ callId, name }) => ({ callId, name })),
          functionCallOutputs: ordered.map(({ callId, output }) => ({
            callId,
            isError: false,
            output,
          })),
        },
        () => outcomes.shift(),
      );

      expect(
        executions.find(({ callId }) => callId === "duplicate"),
      ).toMatchObject({
        outputClass: "duplicate_tool_rejected",
        status: "error",
      });
      expect(
        executions.find(({ callId }) => callId === "success"),
      ).toMatchObject({
        outputClass: "patient_verified",
        status: "success",
      });
      expect(outcomes).toEqual([]);
    },
  );

  it("does not classify a rejected duplicate add_patient call as a created chart", () => {
    expect(
      classifyToolOutput(
        "add_patient",
        JSON.stringify("Same tool `add_patient` is already running:\n- call_1"),
        false,
      ),
    ).toBe("duplicate_tool_rejected");
  });

  it("adds sanitized appointment action fallbacks for missing tool executions", () => {
    expect(
      withAppointmentActionToolExecutionFallback(
        [],
        [
          {
            action: "booked",
            createdAt: "2026-05-20T10:00:00.000Z",
            status: "success",
            toolName: "book_appointment",
            appointment: {
              appointmentId: "123",
              patientName: "Jane Patient",
            },
          },
          {
            action: "rescheduled",
            createdAt: "2026-05-20T10:01:00.000Z",
            message:
              "Booked the new appointment, but I could not cancel the old appointment.",
            status: "partial",
            toolName: "reschedule_appointment",
          },
        ],
      ),
    ).toEqual([
      {
        callId: "appointment_action_1",
        createdAt: "2026-05-20T10:00:00.000Z",
        outputClass: "appointment_booked",
        status: "success",
        toolName: "book_appointment",
      },
      {
        callId: "appointment_action_2",
        createdAt: "2026-05-20T10:01:00.000Z",
        outputClass: "appointment_reschedule_partial",
        status: "error",
        toolName: "reschedule_appointment",
      },
    ]);
    expect(
      JSON.stringify(
        withAppointmentActionToolExecutionFallback(
          [],
          [
            {
              action: "booked",
              status: "success",
              toolName: "book_appointment",
              appointment: {
                appointmentId: "123",
                patientName: "Jane Patient",
              },
            },
          ],
        ),
      ),
    ).not.toContain("Jane Patient");
  });

  it("does not duplicate matching appointment action tool executions", () => {
    expect(
      withAppointmentActionToolExecutionFallback(
        [
          {
            callId: "call_1",
            createdAt: "2026-05-20T10:00:00.000Z",
            outputClass: "appointment_booked",
            status: "success",
            toolName: "book_appointment",
          },
        ],
        [
          {
            action: "booked",
            createdAt: "2026-05-20T10:00:00.000Z",
            status: "success",
            toolName: "book_appointment",
          },
        ],
      ),
    ).toHaveLength(1);
  });

  it("keeps appointment action fallbacks when only a read-back call was captured", () => {
    expect(
      withAppointmentActionToolExecutionFallback(
        [
          {
            callId: "call_1",
            createdAt: "2026-05-20T09:59:00.000Z",
            outputClass: "appointment_not_booked",
            status: "error",
            toolName: "book_appointment",
          },
        ],
        [
          {
            action: "booked",
            createdAt: "2026-05-20T10:00:00.000Z",
            status: "success",
            toolName: "book_appointment",
          },
        ],
      ),
    ).toEqual([
      {
        callId: "call_1",
        createdAt: "2026-05-20T09:59:00.000Z",
        outputClass: "appointment_not_booked",
        status: "error",
        toolName: "book_appointment",
      },
      {
        callId: "appointment_action_1",
        createdAt: "2026-05-20T10:00:00.000Z",
        outputClass: "appointment_booked",
        status: "success",
        toolName: "book_appointment",
      },
    ]);
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

  it("captures bounded STT profile transitions for call reports", () => {
    const transition = snapshotSttProfileTransition({
      assistantText: "Do you have an email address?",
      callerText: "yes",
      createdAt: Date.parse("2026-05-20T10:05:00.000Z"),
      from: "default",
      reason: "assistant_prompt",
      to: "email",
    });

    expect(transition).toEqual({
      assistantText: "Do you have an email address?",
      callerText: "yes",
      createdAt: "2026-05-20T10:05:00.000Z",
      from: "default",
      reason: "assistant_prompt",
      to: "email",
    });

    const longText = "x".repeat(300);
    expect(
      snapshotSttProfileTransition({
        assistantText: longText,
        createdAt: Date.parse("2026-05-20T10:05:01.000Z"),
        from: "email",
        reason: "assistant_prompt",
        to: "default",
      }).assistantText,
    ).toHaveLength(240);
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

  it("deduplicates LiveKit Inference model identities across metrics and usage", () => {
    const summary = buildLlmSummary({
      fallbackModel: "xai/grok-4.5",
      llmMetrics: [
        {
          completionTokens: 20,
          metadata: {
            modelName: "google/gemma-4-31b-it",
            modelProvider: "livekit",
          },
          promptTokens: 100,
          type: "llm_metrics",
        },
      ],
      usage: {
        modelUsage: [
          {
            inputTokens: 100,
            model: "google/gemma-4-31b-it",
            outputTokens: 20,
            provider: "livekit",
            type: "llm_usage",
          },
        ],
      },
    });

    expect(summary).toMatchObject({
      fallbackUsed: false,
      modelsUsed: ["google/gemma-4-31b-it"],
    });
  });

  it("preserves non-LiveKit provider identities for namespaced models", () => {
    const summary = buildLlmSummary({
      fallbackModel: "fallback/model",
      llmMetrics: [
        {
          metadata: {
            modelName: "acme/model",
            modelProvider: "provider-a",
          },
          type: "llm_metrics",
        },
        {
          metadata: {
            modelName: "acme/model",
            modelProvider: "provider-b",
          },
          type: "llm_metrics",
        },
      ],
    });

    expect(summary.modelsUsed).toEqual([
      "provider-a/acme/model",
      "provider-b/acme/model",
    ]);
  });
});
