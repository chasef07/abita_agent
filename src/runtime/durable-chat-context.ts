import type { ChatContext } from "@livekit/agents";

interface DurableChatContextAgent {
  readonly chatCtx: ChatContext;
  updateChatCtx(chatCtx: ChatContext): Promise<void>;
}

export async function addDurableInternalSystemMessage(
  agent: DurableChatContextAgent,
  activeChatCtx: ChatContext,
  content: string,
): Promise<void> {
  activeChatCtx.addMessage({ role: "system", content });

  const durableChatCtx = agent.chatCtx.copy();
  durableChatCtx.addMessage({ role: "system", content });
  await agent.updateChatCtx(durableChatCtx);
}
