import { llm } from "@livekit/agents";

interface DurableChatContextAgent {
  readonly chatCtx: llm.ChatContext;
  updateChatCtx(chatCtx: llm.ChatContext): Promise<void>;
}

export async function addDurableInternalSystemMessage(
  agent: DurableChatContextAgent,
  activeChatCtx: llm.ChatContext,
  content: string,
): Promise<void> {
  activeChatCtx.addMessage({ role: "system", content });

  const durableChatCtx = agent.chatCtx.copy();
  durableChatCtx.addMessage({ role: "system", content });
  await agent.updateChatCtx(durableChatCtx);
}
