// agent.ts — Agent definition
// Instructions loaded from workspace files, tools wired below.

import {
  Agent as LiveKitAgent,
  type ChatContext,
  type ChatMessage,
  type ModelSettings,
  type stt,
} from "@livekit/agents";
import type { AudioFrame } from "@livekit/rtc-node";
import type { ReadableStream } from "node:stream/web";
import { buildPrompt } from "./prompt.js";
import { type CallState, type PhoneLookupResult } from "./state/call-state.js";
import {
  observeSttLanguage,
  type SttLanguageDecision,
  type SttLanguageDetector,
} from "./stt-language-detector.js";
import { getOfficeConfigByPhone } from "./customers/profile.js";
import { confirmPreCallIdentityFromTranscript } from "./runtime/precall-transcript-confirmation.js";
import { addDurableInternalSystemMessage } from "./runtime/durable-chat-context.js";
import {
  buildToolsForTrunk as buildToolsForTrunkFromRegistry,
  type AgentTools,
} from "./runtime/tool-registry.js";

export { addDurableInternalSystemMessage };

export function buildToolsForTrunk(trunkPhone?: string): AgentTools {
  return buildToolsForTrunkFromRegistry(trunkPhone);
}

export function createAgent(
  phoneLookup?: PhoneLookupResult,
  trunkPhone?: string,
  options: {
    onLanguageDecision?: (decision: SttLanguageDecision) => void;
    suppressGreeting?: boolean;
    sttLanguageDetector?: SttLanguageDetector;
  } = {},
) {
  const office = getOfficeConfigByPhone(trunkPhone ?? "");
  const greeting = options.suppressGreeting ? "" : office.greeting;

  return LiveKitAgent.create<CallState>({
    instructions: buildPrompt(phoneLookup, trunkPhone),
    tools: buildToolsForTrunk(trunkPhone),

    async onEnter(ctx): Promise<void> {
      if (!greeting) return;
      // Brief delay so the SIP audio path is fully established before speaking
      await new Promise((r) => setTimeout(r, 500));
      await ctx.session.say(greeting);
    },

    async onUserTurnCompleted(
      ctx,
      chatCtx: ChatContext,
      newMessage: ChatMessage,
    ): Promise<void> {
      const state = ctx.session.userData;
      const transcript = newMessage.textContent ?? "";
      if (!transcript) return;

      state.runtime.latestUserTranscript = transcript;
      const confirmation = confirmPreCallIdentityFromTranscript({
        state,
        transcript,
        lastAssistantText: latestAssistantText(chatCtx),
      });
      if (confirmation) {
        await addDurableInternalSystemMessage(
          ctx.agent,
          chatCtx,
          confirmation.systemMessage,
        );
      }
    },

    async sttNode(
      ctx,
      audio: ReadableStream<AudioFrame> | AsyncIterable<AudioFrame>,
      modelSettings: ModelSettings,
    ): Promise<ReadableStream<stt.SpeechEvent | string> | null> {
      const events = await LiveKitAgent.default.sttNode(
        ctx.agent,
        audio,
        modelSettings,
      );
      if (!events || !options.sttLanguageDetector) return events;

      return observeSttLanguage(
        events,
        options.sttLanguageDetector,
        options.onLanguageDecision,
      );
    },
  });
}

function latestAssistantText(chatCtx: ChatContext): string | null {
  for (let index = chatCtx.items.length - 1; index >= 0; index -= 1) {
    const item = chatCtx.items[index];
    if (item.type === "message" && item.role === "assistant") {
      return item.textContent ?? null;
    }
  }
  return null;
}
