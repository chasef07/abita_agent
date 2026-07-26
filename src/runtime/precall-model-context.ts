import { ChatContext } from "@livekit/agents";
import type { PhoneLookupResult } from "../state/call-state.js";

export type ModelFacingLookupStatus =
  "single_match" | "multiple_matches" | "no_match" | "lookup_failed";

export function modelFacingLookupStatus(
  lookup: PhoneLookupResult,
): ModelFacingLookupStatus {
  if (!lookup) return "lookup_failed";
  return lookup.status === "verified" ? "single_match" : lookup.status;
}

export function createInitialLookupChatContext(
  status: ModelFacingLookupStatus,
): ChatContext {
  const chatCtx = ChatContext.empty();
  chatCtx.addMessage({ role: "system", content: status });
  return chatCtx;
}
