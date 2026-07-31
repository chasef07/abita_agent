import {
  Agent as LiveKitAgent,
  AgentSession,
  ChatContext,
  ChatMessage,
  FunctionCall,
  FunctionCallOutput,
  initializeLogger,
  type ModelSettings,
} from "@livekit/agents";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVoiceAgent } from "../agent.js";
import {
  DEV_OFFICE_PHONE,
  SPRING_HILL_OFFICE_PHONE,
  type OfficeKey,
} from "../customers/abita/profile.js";
import type { CallState } from "../state/call-state.js";
import { createTestCallState } from "./support/call-state.js";

const FORCED_TRANSFER_SETTINGS = {
  toolChoice: "required",
} as const satisfies ModelSettings;

describe("demo transfer trigger", () => {
  initializeLogger({ level: "silent", pretty: false });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    "Hi. This is a controlled test call. I need to speak with someone in the office. Please transfer me to the office.",
    "Yes. Please transfer me now.",
    "I need a human in the office. Please transfer me now. Yes, I consent to the transfer.",
    "Por favor, transfiérame con la oficina.",
    "I don’t want you to transfer me. Actually, please transfer me now.",
    "No me transfiera. Pensándolo bien, transfiérame con la oficina.",
  ])("forces transfer_call for the live request: %s", async (transcript) => {
    const result = await runTurn(transcript);

    expect(result.forwarded).toEqual(FORCED_TRANSFER_SETTINGS);
    expect(result.forwardedTools).toEqual(["transfer_call"]);
  });

  it("leaves ordinary demo turns on automatic tool selection", async () => {
    const result = await runTurn("What time does the office close?");

    expect(result.forwarded).toBe(result.original);
    expect(result.forwardedTools).toContain("transfer_call");
    expect(result.forwardedTools.length).toBeGreaterThan(1);
  });

  it.each([
    "Please don’t transfer me.",
    "I don't want you to transfer me.",
    "Do not connect me to the office.",
    "No me transfiera con la oficina.",
    "No quiero que me transfiera con la oficina.",
    "Please transfer me now. Actually, don’t transfer me.",
    "Transfiérame con la oficina. Pensándolo bien, no me transfiera.",
  ])(
    "does not force a transfer the caller declined: %s",
    async (transcript) => {
      const result = await runTurn(transcript);

      expect(result.forwarded).toBe(result.original);
    },
  );

  it("does not force transfer_call again after the turn already ran it", async () => {
    const result = await runTurn("Please transfer me now.", {
      toolAlreadyRan: true,
    });

    expect(result.forwarded).toBe(result.original);
  });

  it("leaves non-demo transfer requests on the office policy", async () => {
    const result = await runTurn("Please transfer me now.", {
      officeKey: "spring-hill",
      trunkPhone: SPRING_HILL_OFFICE_PHONE,
    });

    expect(result.forwarded).toBe(result.original);
  });
});

async function runTurn(
  transcript: string,
  options: {
    officeKey?: OfficeKey;
    toolAlreadyRan?: boolean;
    trunkPhone?: string;
  } = {},
): Promise<{
  forwarded: ModelSettings | undefined;
  forwardedTools: string[];
  original: ModelSettings;
}> {
  const officeKey = options.officeKey ?? "dev";
  const trunkPhone = options.trunkPhone ?? DEV_OFFICE_PHONE;
  const state = createTestCallState({ officeKey, trunkPhone });
  const { agent } = createVoiceAgent("no_match", trunkPhone, {
    suppressGreeting: true,
  });
  const session = new AgentSession<CallState>({ userData: state, vad: null });
  const llmNode = vi
    .spyOn(LiveKitAgent.default, "llmNode")
    .mockResolvedValue(null);
  const modelSettings = {} satisfies ModelSettings;

  try {
    await session.start({ agent, record: false });
    const chatCtx = ChatContext.empty();
    const userMessage = ChatMessage.create({
      role: "user",
      content: transcript,
    });
    chatCtx.addMessage(userMessage);
    await agent.onUserTurnCompleted(chatCtx, userMessage);
    if (options.toolAlreadyRan) addTransferResult(chatCtx);
    await agent.llmNode(chatCtx, agent.toolCtx, modelSettings);
    return {
      forwarded: llmNode.mock.calls.at(-1)?.[3],
      forwardedTools: Object.keys(
        llmNode.mock.calls.at(-1)?.[2].functionTools ?? {},
      ),
      original: modelSettings,
    };
  } finally {
    await session.close();
  }
}

function addTransferResult(chatCtx: ChatContext): void {
  chatCtx.insert(
    FunctionCall.create({
      callId: "transfer-1",
      name: "transfer_call",
      args: "{}",
    }),
  );
  chatCtx.insert(
    FunctionCallOutput.create({
      callId: "transfer-1",
      name: "transfer_call",
      output: "Could not transfer the call.",
      isError: false,
    }),
  );
}
