/**
 * Test helpers for transcript replay testing.
 * Creates agents with mock tools and loads conversation history from DB transcripts.
 */

import { inference, llm, voice } from "@livekit/agents";
import * as baseten from "@livekit/agents-plugin-baseten";
import { buildPrompt } from "../prompt.js";
import type { PhoneLookupResult } from "../tools.js";
import { createMockTools, type MockConfig } from "./mock-tools.js";
import { SPRING_HILL_OFFICE_PHONE } from "../offices.js";

export interface TestContext {
  session: voice.AgentSession;
  agent: voice.Agent;
  llm: llm.LLM;
  callLog: Array<{ name: string; args: Record<string, unknown> }>;
  cleanup: () => Promise<void>;
}

/**
 * Create a test agent with the current prompts and mock tools.
 * Mirrors production: Baseten GLM-4.7 primary, MiniMax-M2.5 fallback,
 * temp=1, topP=0.9, parallelToolCalls=false. Override with opts.model
 * to use a different model via LiveKit Inference (e.g. for cheaper smoke tests).
 */
export async function createTestAgent(opts: {
  phoneLookup?: PhoneLookupResult;
  trunkPhone?: string;
  mockConfig?: MockConfig;
  /** Override the LLM model. If set, uses LiveKit Inference (e.g. "openai/gpt-4.1-mini" for cheap smoke tests). Default: production Baseten stack. */
  model?: string;
}): Promise<TestContext> {
  const trunkPhone = opts.trunkPhone ?? SPRING_HILL_OFFICE_PHONE;
  const { tools, callLog } = createMockTools(opts.mockConfig, trunkPhone);

  const llmInstance: llm.LLM = opts.model
    ? new inference.LLM({ model: opts.model })
    : new llm.FallbackAdapter({
        llms: [
          new baseten.LLM({
            model: "zai-org/GLM-4.7",
            parallelToolCalls: false,
            temperature: 1.0,
            topP: 0.9,
          }),
          new baseten.LLM({
            model: "MiniMaxAI/MiniMax-M2.5",
            parallelToolCalls: false,
            temperature: 1.0,
            topP: 0.9,
          }),
        ],
      });

  const agent = new voice.Agent({
    instructions: buildPrompt(opts.phoneLookup, trunkPhone),
    tools,
  });

  const session = new voice.AgentSession({ llm: llmInstance });
  await session.start({ agent });

  return {
    session,
    agent,
    llm: llmInstance,
    callLog,
    cleanup: async () => {
      await session?.close();
      await llmInstance?.aclose();
    },
  };
}

/**
 * Load conversation history from a transcript's turns into the agent's ChatContext.
 * Replays turns up to (but not including) `stopBeforeTurn` so we can test what
 * the agent does at that turn.
 */
export async function loadTranscriptHistory(
  agent: voice.Agent,
  turns: TranscriptTurn[],
  stopBeforeTurn: number,
): Promise<void> {
  const chatCtx = new llm.ChatContext();

  for (const turn of turns) {
    if (turn.turn >= stopBeforeTurn) break;

    // Add user message
    if (turn.callerText) {
      chatCtx.addMessage({ role: "user", content: turn.callerText });
    }

    // Add tool calls and outputs
    for (const tc of turn.toolCalls) {
      // Add as assistant function call + output in history
      chatCtx.addMessage({
        role: "assistant",
        content: `[Called ${tc.name} with args: ${tc.args}]`,
      });
      chatCtx.addMessage({
        role: "user",
        content: `[Tool result: ${tc.result}]`,
      });
    }

    // Add agent message
    if (turn.agentText) {
      chatCtx.addMessage({ role: "assistant", content: turn.agentText });
    }
  }

  await agent.updateChatCtx(chatCtx);
}

export interface TranscriptTurn {
  turn: number;
  callerText: string | null;
  agentText: string | null;
  toolCalls: Array<{
    name: string;
    args: string;
    result: string;
    isError: boolean;
  }>;
}

/**
 * Parse turns from a DB query result (JSONB data->'turns' array).
 */
export function parseTurns(turnsJson: unknown[]): TranscriptTurn[] {
  return (turnsJson as any[]).map((t) => ({
    turn: t.turn,
    callerText: t.callerText ?? null,
    agentText: t.agentText ?? null,
    toolCalls: (t.toolCalls ?? []).map((tc: any) => ({
      name: tc.name,
      args: tc.args,
      result: tc.result,
      isError: tc.isError ?? false,
    })),
  }));
}
