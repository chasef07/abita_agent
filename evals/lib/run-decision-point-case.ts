import { initializeLogger, llm } from "@livekit/agents";
import dotenv from "dotenv";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createTestAgent } from "../../src/__tests__/helpers.js";
import type { DecisionPointCase } from "./types.js";

dotenv.config({ path: ".env.local", quiet: true });
initializeLogger({ pretty: false, level: "error" });

type RunDecisionPointCaseResult = {
  caseId: string;
  finalUserInput: string;
  assistantMessages: string[];
  finalText: string;
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
};

function loadCase(casePath: string): DecisionPointCase {
  const absolutePath = resolve(process.cwd(), casePath);
  return JSON.parse(readFileSync(absolutePath, "utf-8")) as DecisionPointCase;
}

function buildPhoneLookup(testCase: DecisionPointCase) {
  switch (testCase.context.phoneLookupStatus) {
    case "verified":
      return {
        status: "verified" as const,
        patientId: "EVAL-123",
        name: "DOE,JANE",
        dob: "01/01/1980",
        phone: "5551234567",
        insuranceCarrier: "Florida Blue",
        insPlanId: "PLAN-1",
        respPartyId: "RESP-1",
        routing: "general",
        allowedProviders: [],
        routingAmbiguous: false,
        appointments:
          testCase.context.appointments &&
          testCase.context.appointments.length > 0
            ? testCase.context.appointments
            : null,
      };
    case "multiple_matches":
      return {
        status: "multiple_matches" as const,
        message: "Multiple patients found for this phone number",
        matches: [{ firstName: "Jane" }, { firstName: "Kyle" }],
      };
    default:
      return null;
  }
}

function buildChatContextMessages(
  conversation: DecisionPointCase["conversation"],
) {
  const chatCtx = new llm.ChatContext();
  for (const message of conversation) {
    chatCtx.addMessage({
      role: message.role,
      content: message.content,
    });
  }
  return chatCtx;
}

function extractAssistantTexts(items: unknown[]): string[] {
  return items.flatMap((item) => {
    if (
      item &&
      typeof item === "object" &&
      "type" in item &&
      item.type === "message" &&
      "role" in item &&
      item.role === "assistant" &&
      "textContent" in item &&
      typeof item.textContent === "string" &&
      item.textContent.trim().length > 0
    ) {
      return [item.textContent];
    }
    return [];
  });
}

export async function runDecisionPointCase(
  casePath: string,
  model?: string,
): Promise<RunDecisionPointCaseResult> {
  const testCase = loadCase(casePath);
  const lastMessage = testCase.conversation.at(-1);

  if (!lastMessage || lastMessage.role !== "user") {
    throw new Error(
      `Decision-point case must end with a user turn: ${testCase.id}`,
    );
  }

  const history = testCase.conversation.slice(0, -1);
  const ctx = await createTestAgent({
    phoneLookup: buildPhoneLookup(testCase),
    trunkPhone: testCase.context.trunkPhone,
    model,
  });

  try {
    const chatCtx = buildChatContextMessages(history);
    await ctx.agent.updateChatCtx(chatCtx);
    const priorAssistantCount = extractAssistantTexts(
      ctx.session.history.items,
    ).length;

    const result = await ctx.session
      .run({ userInput: lastMessage.content })
      .wait();
    const eventAssistantMessages = result.events
      .filter(
        (event) => event.type === "message" && event.item.role === "assistant",
      )
      .flatMap((event) =>
        event.type === "message" && typeof event.item.text === "string"
          ? [event.item.text]
          : [],
      );
    const historyAssistantMessages = extractAssistantTexts(
      ctx.session.history.items,
    ).slice(priorAssistantCount);
    const assistantMessages =
      historyAssistantMessages.length > 0
        ? historyAssistantMessages
        : eventAssistantMessages;

    return {
      caseId: testCase.id,
      finalUserInput: lastMessage.content,
      assistantMessages,
      finalText: assistantMessages.at(-1) ?? "",
      toolCalls: ctx.callLog,
    };
  } finally {
    await ctx.cleanup();
  }
}
