import {
  Agent as LiveKitAgent,
  AgentSession,
  ChatContext,
  FunctionCall,
  FunctionCallOutput,
  initializeLogger,
  ToolContext,
  tool,
  voice,
} from "@livekit/agents";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

describe("LiveKit dynamic tool history", () => {
  beforeAll(() => {
    initializeLogger({ pretty: false, level: "silent" });
  });

  const sessions: AgentSession[] = [];

  afterEach(async () => {
    await Promise.all(sessions.splice(0).map((session) => session.close()));
  });

  it("keeps a call paired with its output when the executing tool removes itself", async () => {
    const keep = tool({
      name: "keep",
      description: "Keep this tool available.",
      execute: async () => "kept",
    });
    const agentRef: { current?: LiveKitAgent } = {};
    const remove = tool({
      name: "remove",
      description: "Remove this tool while it executes.",
      execute: async () => {
        await agentRef.current?.updateTools([keep]);
        return "removed";
      },
    });
    const agent = LiveKitAgent.create({
      instructions: "Test agent.",
      tools: [keep, remove],
    });
    agentRef.current = agent;
    const llm = new voice.testing.FakeLLM([
      {
        input: "Remove the tool.",
        toolCalls: [{ name: "remove", args: {} }],
      },
      { input: JSON.stringify("removed"), content: "Done." },
    ]);
    const session = new AgentSession({ llm });
    sessions.push(session);

    await session.start({ agent });
    await session.run({ userInput: "Remove the tool." }).wait();

    expect(Object.keys(agent.toolCtx.functionTools)).toEqual(["keep"]);
    const functionCall = agent.chatCtx.items.find(
      (item) => item.type === "function_call" && item.name === "remove",
    );
    const functionOutput = agent.chatCtx.items.find(
      (item) => item.type === "function_call_output" && item.name === "remove",
    );
    expect(functionCall).toBeDefined();
    expect(functionOutput).toMatchObject({
      callId: functionCall?.callId,
      output: JSON.stringify("removed"),
    });
  });

  it("preserves explicit ChatContext tool filtering outside dynamic updates", () => {
    const keep = tool({
      name: "keep",
      description: "Keep this tool available.",
      execute: async () => "kept",
    });
    const functionCall = FunctionCall.create({
      id: "assistant-turn/function-call",
      callId: "call-1",
      name: "remove",
      args: "{}",
    });
    const functionOutput = FunctionCallOutput.create({
      callId: functionCall.callId,
      name: functionCall.name,
      output: JSON.stringify("removed"),
      isError: false,
    });

    const filtered = new ChatContext([functionCall, functionOutput]).copy({
      toolCtx: new ToolContext([keep]),
    });

    expect(filtered.items).toEqual([]);
  });
});
