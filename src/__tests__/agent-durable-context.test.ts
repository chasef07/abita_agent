import { ChatContext } from "@livekit/agents";
import { describe, expect, it, vi } from "vitest";
import { addDurableInternalSystemMessage } from "../runtime/durable-chat-context.js";

function hasSystemMessage(chatCtx: ChatContext, expected: string): boolean {
  return chatCtx.items.some(
    (item) =>
      item.type === "message" &&
      item.role === "system" &&
      item.textContent?.includes(expected),
  );
}

describe("durable chat context updates", () => {
  it("adds internal state messages to the active and durable chat contexts", async () => {
    let durableChatCtx = ChatContext.empty();
    durableChatCtx.addMessage({
      role: "assistant",
      content: "Who is the appointment for?",
    });
    const activeChatCtx = durableChatCtx.copy();
    const updateChatCtx = vi.fn(async (nextChatCtx: ChatContext) => {
      durableChatCtx = nextChatCtx;
    });
    const agent = {
      get chatCtx() {
        return durableChatCtx;
      },
      updateChatCtx,
    };

    await addDurableInternalSystemMessage(
      agent,
      activeChatCtx,
      "Internal state: patient identity is confirmed.",
    );

    expect(
      hasSystemMessage(activeChatCtx, "patient identity is confirmed"),
    ).toBe(true);
    expect(
      hasSystemMessage(durableChatCtx, "patient identity is confirmed"),
    ).toBe(true);
    expect(updateChatCtx).toHaveBeenCalledTimes(1);
  });
});
