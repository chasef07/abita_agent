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
import { recordLatestUserTranscript } from "./state/call-lifecycle.js";
import {
  observeSttLanguage,
  type SttLanguageDecision,
  type SttLanguageDetector,
} from "./stt-language-detector.js";
import { getOfficeProfileByPhone } from "./customers/abita/profile.js";
import { confirmPreCallIdentityFromTranscript } from "./runtime/precall-transcript-confirmation.js";
import { addDurableInternalSystemMessage } from "./runtime/durable-chat-context.js";
import { buildToolsForTrunk } from "./runtime/tool-registry.js";
import type { PatientResolveLookup } from "./identity/promotion.js";
import {
  officeKnowledgeReference,
  resolveOfficeKnowledge,
} from "./office-knowledge.js";
import { activeOfficeKey } from "./state/call-lifecycle.js";
import { recordOfficeKnowledgeRetrieval } from "./state/observability.js";
import {
  clinicTimestampMessage,
  systemSchedulingClock,
  type SchedulingClock,
} from "./scheduling/temporal.js";

export { addDurableInternalSystemMessage };

type VoiceAgentOptions = {
  identityLookup?: PatientResolveLookup;
  officeKnowledgeResolver?: typeof resolveOfficeKnowledge;
  onAssistantText?: (text: string, complete: boolean) => void;
  onLanguageDecision?: (decision: SttLanguageDecision) => void;
  suppressGreeting?: boolean;
  sttLanguageDetector?: SttLanguageDetector;
  turnClock?: SchedulingClock;
};

export function createVoiceAgent(
  phoneLookup?: PhoneLookupResult,
  trunkPhone?: string,
  options: VoiceAgentOptions = {},
) {
  const office = getOfficeProfileByPhone(trunkPhone ?? "");
  const greeting = options.suppressGreeting ? "" : office.greeting;

  const agent = LiveKitAgent.create<CallState>({
    instructions: buildPrompt(phoneLookup, trunkPhone),
    tools: buildToolsForTrunk(trunkPhone, {
      identityLookup: options.identityLookup,
    }),

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
      chatCtx.addMessage({
        role: "system",
        content: clinicTimestampMessage(
          (options.turnClock ?? systemSchedulingClock).now(),
        ),
      });

      const state = ctx.session.userData;
      const transcript = newMessage.textContent ?? "";
      if (!transcript) return;

      recordLatestUserTranscript(state, transcript);
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

      const officeKey = activeOfficeKey(state);
      const startedAt = performance.now();
      try {
        const knowledge = (
          options.officeKnowledgeResolver ?? resolveOfficeKnowledge
        )(officeKey, transcript, recentNaturalLanguageConversation(chatCtx));
        if (knowledge.outcome !== "skipped") {
          chatCtx.addMessage({
            role: "assistant",
            content: officeKnowledgeReference(officeKey, knowledge),
          });
        }
        recordOfficeKnowledgeRetrieval(state, {
          elapsedMs: elapsedMilliseconds(startedAt),
          language: knowledge.language,
          officeKey,
          outcome: knowledge.outcome,
          sectionCount: knowledge.sections.length,
          topic: knowledge.topic,
        });
      } catch {
        recordOfficeKnowledgeRetrieval(state, {
          elapsedMs: elapsedMilliseconds(startedAt),
          language: "unknown",
          officeKey,
          outcome: "failure",
          sectionCount: 0,
          topic: null,
        });
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

    async ttsNode(ctx, text, modelSettings) {
      return LiveKitAgent.default.ttsNode(
        ctx.agent,
        options.onAssistantText
          ? observeAssistantText(text, options.onAssistantText)
          : text,
        modelSettings,
      );
    },
  });

  return { agent, office };
}

export async function* observeAssistantText(
  chunks: AsyncIterable<string>,
  observer: (text: string, complete: boolean) => void,
): AsyncIterable<string> {
  let text = "";

  for await (const chunk of chunks) {
    text += chunk;
    observer(text, false);
    yield chunk;
  }

  observer(text, true);
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

function recentNaturalLanguageConversation(chatCtx: ChatContext): string[] {
  return chatCtx.items
    .flatMap((item) =>
      item.type === "message" &&
      (item.role === "user" || item.role === "assistant") &&
      item.textContent?.trim()
        ? [item.textContent]
        : [],
    )
    .slice(-2);
}

function elapsedMilliseconds(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}
