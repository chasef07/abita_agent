import {
  initializeLogger,
  log,
  ChatContext,
  FunctionCall,
  FunctionCallOutput,
  createSessionReport,
  sessionReportToJSON,
} from "@livekit/agents";
import { describe, expect, it, vi } from "vitest";
import {
  setupKnowledgeLogging,
  setupKnowledgeReportRedaction,
} from "../runtime/knowledge-observability.js";

describe("knowledge tool logging", () => {
  it("redacts the native SDK report factory without changing the live model history", () => {
    const history = new ChatContext([
      FunctionCall.create({
        name: "search_office_knowledge",
        callId: "knowledge-1",
        args: '{"query":"sensitive-query"}',
      }),
      FunctionCallOutput.create({
        name: "search_office_knowledge",
        callId: "knowledge-1",
        output: "sensitive-passage",
        isError: false,
      }),
      FunctionCall.create({
        name: "check_insurance",
        callId: "other-1",
        args: "existing-policy-content",
      }),
    ]);
    const report = createSessionReport({
      jobId: "job-test",
      roomId: "room-test",
      room: "test",
      chatHistory: history,
      events: [],
      options: {} as Parameters<typeof createSessionReport>[0]["options"],
    });
    const ctx = { makeSessionReport: () => report };
    setupKnowledgeReportRedaction(ctx);
    const exported = JSON.stringify(
      sessionReportToJSON(ctx.makeSessionReport()),
    );
    expect(exported).not.toContain("sensitive-query");
    expect(exported).not.toContain("sensitive-passage");
    expect(exported).toContain("existing-policy-content");
    expect(JSON.stringify(history.toJSON())).toContain("sensitive-query");
    expect(JSON.stringify(history.toJSON())).toContain("sensitive-passage");
  });

  it("redacts native pre-execution arguments on root and child loggers without changing other tools", () => {
    initializeLogger({ pretty: false, level: "info" });
    const output = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      setupKnowledgeLogging();
      log().info(
        {
          function: "search_office_knowledge",
          "lk.pii.arguments": { query: "sensitive-rejected-query" },
          speech_id: "speech-test",
        },
        "Executing LLM tool call",
      );
      log().child({ component: "generation" }).error(
        {
          function: "search_office_knowledge",
          "lk.pii.arguments": "sensitive-rejected-query",
          "lk.pii.error": "sensitive-error",
        },
        "invalid arguments",
      );
      log().info(
        {
          function: "check_insurance",
          "lk.pii.arguments": "existing-content-policy",
        },
        "Executing LLM tool call",
      );
      const written = output.mock.calls.map((call) => String(call[0])).join("");
      expect(written).not.toContain("sensitive-");
      expect(written).toContain("existing-content-policy");
      expect(written).toContain("speech-test");
    } finally {
      output.mockRestore();
      initializeLogger({ pretty: false, level: "silent" });
    }
  });
});
